// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { Injectable } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import {
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  firstValueFrom,
  from,
  map,
  Observable,
  of,
  shareReplay,
  startWith,
  Subject,
  switchMap,
} from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { getOptionalUserId } from "@bitwarden/common/auth/services/account.service";
import { DomainSettingsService } from "@bitwarden/common/autofill/services/domain-settings.service";
import { AccountCipher } from "@bitwarden/common/autofill/types/account-cipher";
import { isUrlInList } from "@bitwarden/common/autofill/utils";
import { matchTargetingRulesForUrl } from "@bitwarden/common/autofill/utils/targeting-rules";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherRepromptType, CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { LoginUriView } from "@bitwarden/common/vault/models/view/login-uri.view";
import {
  CipherViewLike,
  CipherViewLikeUtils,
} from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { ToastService } from "@bitwarden/components";
import { PasswordRepromptService } from "@bitwarden/vault";

import { AccountSwitcherService } from "../../../auth/popup/account-switching/services/account-switcher.service";
import { AutofillOutcome } from "../../../autofill/enums/autofill-outcome.enum";
import { PageDetail } from "../../../autofill/services/abstractions/autofill.service";
import { InlineMenuFieldQualificationService } from "../../../autofill/services/inline-menu-field-qualification.service";
import { didFillOccur, FillResult, shouldAutoCopyTotp } from "../../../autofill/types/fill-result";
import { BrowserApi } from "../../../platform/browser/browser-api";
import BrowserPopupUtils from "../../../platform/browser/browser-popup-utils";
import { devFlagEnabled } from "../../../platform/flags";
import { closeViewVaultItemPopout, VaultPopoutType } from "../utils/vault-popout-window";

@Injectable({
  providedIn: "root",
})
export class VaultPopupAutofillService {
  private _refreshCurrentTab$ = new Subject<void>();
  private senderTabId$: Observable<number | undefined> = this.route.queryParams.pipe(
    map((params) => (params?.senderTabId ? parseInt(params.senderTabId, 10) : undefined)),
  );
  /**
   * Observable that contains the current tab to be considered for autofill.
   * This can be the tab from the current window if opened in a Popup OR
   * the sending tab when opened the single action Popout (specified by the senderTabId route query parameter)
   */
  currentAutofillTab$: Observable<chrome.tabs.Tab | null> = combineLatest([
    this.senderTabId$,
    this._refreshCurrentTab$.pipe(startWith(null)),
  ]).pipe(
    switchMap(async ([senderTabId]) => {
      if (senderTabId) {
        return await BrowserApi.getTab(senderTabId);
      }

      if (BrowserPopupUtils.inPopout(window)) {
        return null;
      }
      return await BrowserApi.getTabFromCurrentWindow();
    }),
    shareReplay({ refCount: false, bufferSize: 1 }),
  );

  currentTabIsOnBlocklist$: Observable<boolean> = combineLatest([
    this.domainSettingsService.blockedInteractionsUris$,
    this.currentAutofillTab$,
  ]).pipe(
    map(([blockedInteractionsUrls, currentTab]) => {
      if (blockedInteractionsUrls && currentTab) {
        return isUrlInList(currentTab?.url, blockedInteractionsUrls);
      }

      return false;
    }),
    shareReplay({ refCount: false, bufferSize: 1 }),
  );

  showCurrentTabIsBlockedBanner$: Observable<boolean> = combineLatest([
    this.domainSettingsService.blockedInteractionsUris$,
    this.currentAutofillTab$,
  ]).pipe(
    map(([blockedInteractionsUrls, currentTab]) => {
      if (blockedInteractionsUrls && currentTab?.url?.length) {
        const tabHostname = Utils.getHostname(currentTab.url);

        if (!tabHostname) {
          return false;
        }

        const tabIsBlocked = isUrlInList(currentTab.url, blockedInteractionsUrls);

        const showScriptInjectionIsBlockedBanner =
          tabIsBlocked && !blockedInteractionsUrls[tabHostname]?.bannerIsDismissed;

        return showScriptInjectionIsBlockedBanner;
      }

      return false;
    }),
    shareReplay({ refCount: false, bufferSize: 1 }),
  );

  async dismissCurrentTabIsBlockedBanner() {
    try {
      const currentTab = await firstValueFrom(this.currentAutofillTab$);
      const currentTabHostname = currentTab?.url.length && Utils.getHostname(currentTab.url);

      if (!currentTabHostname) {
        return;
      }

      const blockedURLs = await firstValueFrom(this.domainSettingsService.blockedInteractionsUris$);

      let tabIsBlocked = false;
      if (blockedURLs && currentTab?.url?.length) {
        tabIsBlocked = isUrlInList(currentTab.url, blockedURLs);
      }

      if (tabIsBlocked) {
        void this.domainSettingsService.setBlockedInteractionsUris({
          ...blockedURLs,
          [currentTabHostname as string]: { bannerIsDismissed: true },
        });
      }
      // FIXME: Remove when updating file. Eslint update
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      throw new Error(
        "There was a problem dismissing the blocked interaction URL notification banner",
      );
    }
  }

  /**
   * Observable that indicates whether autofill is allowed in the current context.
   * Autofill is allowed when there is a current tab and the popup is not in a popout window.
   */
  autofillAllowed$: Observable<boolean> = this.currentAutofillTab$.pipe(map((tab) => !!tab));

  private _currentPageDetails$: Observable<PageDetail[]> = this.currentAutofillTab$.pipe(
    switchMap((tab) => {
      if (!tab) {
        return of([]);
      }

      return this.domainSettingsService.blockedInteractionsUris$.pipe(
        switchMap((blockedURLs) => {
          if (blockedURLs && tab?.url?.length) {
            const tabIsBlocked = isUrlInList(tab.url, blockedURLs);

            if (tabIsBlocked) {
              return of([]);
            }
          }

          return from(this.collectPageDetailsFromBackground(tab));
        }),
      );
    }),
    debounceTime(50),
    shareReplay({ refCount: false, bufferSize: 1 }),
  );

  /**
   * Collects the tab's page details through the background AutofillOrchestrator — the
   * sole sender of the collect. The popup runs in the foreground and cannot
   * call the orchestrator directly, so it round-trips through the background and receives
   * the settled page details in the response.
   */
  private async collectPageDetailsFromBackground(tab: chrome.tabs.Tab): Promise<PageDetail[]> {
    const response = await BrowserApi.sendMessageWithResponse<{ result?: PageDetail[] }>(
      "collectPageDetailsForPopup",
      { tabId: tab.id },
    );
    return response?.result ?? [];
  }

  /**
   * Emits `true` when fill assist targeting rules apply to the current tab.
   *
   * The vault popup only renders when the vault is unlocked, so the auth/unlock gating that
   * {@link DomainSettingsService.getTargetingRulesForUrl} performs is already guaranteed here.
   * That lets us match the resolved rules synchronously via {@link matchTargetingRulesForUrl}
   * rather than re-resolving (and re-awaiting) that state per emission.
   */
  showFillAssistActiveBanner$: Observable<boolean> = combineLatest([
    this.currentAutofillTab$,
    this.domainSettingsService.resolvedEnableFillAssist$,
    this.domainSettingsService.targetingRules$,
    this.currentTabIsOnBlocklist$,
  ]).pipe(
    map(([currentTab, fillAssistEnabled, targetingRules, tabIsOnBlocklist]) => {
      // Developer-only banner
      if (!devFlagEnabled("fillAssistDevTools")) {
        return false;
      }

      if (!fillAssistEnabled) {
        return false;
      }

      // A blocklisted tab suppresses all autofill, so fill assist is moot regardless of the
      // blocked-domains banner's shown/dismissed state.
      if (tabIsOnBlocklist) {
        return false;
      }

      if (!currentTab?.url?.length) {
        return false;
      }

      const matchedTargetingRules = matchTargetingRulesForUrl(targetingRules, currentTab.url);

      // Any non-`null` result means rules apply, including an empty array (a targeting-rule
      // blocklist that intentionally suppresses autofill). Only `null` (no rules) is inactive.
      return matchedTargetingRules !== null;
    }),
    distinctUntilChanged(),
    shareReplay({ refCount: false, bufferSize: 1 }),
  );

  nonLoginCipherTypesOnPage$: Observable<{
    [CipherType.Card]: boolean;
    [CipherType.Identity]: boolean;
  }> = this._currentPageDetails$.pipe(
    map((pageDetails) => {
      let pageHasCardFields = false;
      let pageHasIdentityFields = false;

      try {
        if (!pageDetails) {
          throw Error("No page details were provided");
        }

        for (const details of pageDetails) {
          for (const field of details.details.fields) {
            if (!pageHasCardFields) {
              pageHasCardFields = this.inlineMenuFieldQualificationService.isFieldForCreditCardForm(
                field,
                details.details,
              );
            }

            if (!pageHasIdentityFields) {
              pageHasIdentityFields =
                this.inlineMenuFieldQualificationService.isFieldForIdentityForm(
                  field,
                  details.details,
                );
            }
          }
        }
      } catch (error) {
        // no-op on failure; do not show extra cipher types
        this.logService.warning(error.message);
      }

      return { [CipherType.Card]: pageHasCardFields, [CipherType.Identity]: pageHasIdentityFields };
    }),
  );

  constructor(
    private domainSettingsService: DomainSettingsService,
    private i18nService: I18nService,
    private toastService: ToastService,
    private platformUtilService: PlatformUtilsService,
    private passwordRepromptService: PasswordRepromptService,
    private cipherService: CipherService,
    private messagingService: MessagingService,
    private route: ActivatedRoute,
    private accountService: AccountService,
    private logService: LogService,
    private inlineMenuFieldQualificationService: InlineMenuFieldQualificationService,
    private accountSwitcherService: AccountSwitcherService,
    private router: Router,
  ) {
    this._currentPageDetails$.subscribe();
  }

  private activeUserId(): Promise<UserId | undefined> {
    return firstValueFrom(this.accountService.activeAccount$.pipe(getOptionalUserId));
  }

  /**
   * @param userId The account that owns `cipher`. Every effect of the fill runs for it.
   */
  private async _internalDoAutofill(
    cipher: CipherView,
    userId: UserId | undefined,
    tab: chrome.tabs.Tab,
    skipPasswordReprompt = false,
  ): Promise<boolean> {
    if (!skipPasswordReprompt && cipher.reprompt !== CipherRepromptType.None) {
      // The reprompt verifies the master password of the active account, so it cannot stand in
      // for another account's: such a cipher is opened in its own account instead of filled.
      if (userId !== (await this.activeUserId())) {
        this._reportAutofillFailure();
        return false;
      }

      if (!(await this.passwordRepromptService.showPasswordPrompt())) {
        return false;
      }
    }

    if (tab == null) {
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: this.i18nService.t("autofillError"),
      });
      return false;
    }

    try {
      // The cipher is sent by reference so decrypted vault data stays off the message channel. The
      // reference names the account as well: a cipher id alone does not identify one.
      const response = await BrowserApi.sendMessageWithResponse<{
        result?: FillResult;
      }>("fillCipherForPopup", { tabId: tab.id, tabUrl: tab.url, cipherId: cipher.id, userId });
      const fillResult = response?.result;
      if (!fillResult || !didFillOccur(fillResult)) {
        this._reportAutofillFailure();
        return false;
      }

      if (shouldAutoCopyTotp(fillResult)) {
        this.platformUtilService.copyToClipboard(fillResult.totp, { window: window });
      }

      // An absent fill placed no credential, so it is reported as the failure it is even when
      // copying the code mitigated it.
      if (fillResult.outcome !== AutofillOutcome.Filled) {
        this._reportAutofillFailure();
        return false;
      }
    } catch (e: unknown) {
      // unexpected error occurred during autofill
      this._reportAutofillFailure(e);
      return false;
    }

    await this.handleAutofillSuggestionUsed({ cipherId: cipher.id, userId });
    return true;
  }

  private _reportAutofillFailure(e?: unknown) {
    if (e) {
      this.logService.error(e);
    }

    this.toastService.showToast({
      variant: "error",
      title: null,
      message: this.i18nService.t("autofillError"),
    });
  }

  private async _closePopup(cipher: CipherView, tab: chrome.tabs.Tab | null) {
    if (BrowserPopupUtils.inSingleActionPopout(window, VaultPopoutType.viewVaultItem) && tab.id) {
      this.toastService.showToast({
        variant: "success",
        title: null,
        message: this.i18nService.t("autoFillSuccess"),
      });
      setTimeout(async () => {
        await BrowserApi.focusTab(tab.id);
        await closeViewVaultItemPopout(`${VaultPopoutType.viewVaultItem}_${cipher.id}`);
      }, 1000);

      return;
    }

    if (!BrowserPopupUtils.inPopup(window)) {
      return;
    }

    if (this.platformUtilService.isFirefox() || this.platformUtilService.isSafari()) {
      BrowserApi.closePopup(window);
      return;
    }

    // Slight delay to fix bug in Chromium browsers where popup closes without copying totp to clipboard
    setTimeout(() => BrowserApi.closePopup(window), 50);
  }

  /**
   * Re-fetch the current tab
   */
  refreshCurrentTab() {
    this._refreshCurrentTab$.next(null);
  }

  /**
   * Attempts to autofill the given cipher. Returns true if the autofill was successful, false otherwise.
   * Will copy any TOTP code to the clipboard if available after successful autofill.
   * @param cipher
   * @param closePopup If true, will close the popup window after successful autofill. Defaults to true.
   * @param skipPasswordReprompt If true, skips the master password reprompt even if the cipher requires it. Defaults to false.
   */
  async doAutofill(
    cipher: CipherView,
    closePopup = true,
    skipPasswordReprompt = false,
  ): Promise<boolean> {
    return this._doAutofill(cipher, await this.activeUserId(), closePopup, skipPasswordReprompt);
  }

  /**
   * {@link doAutofill} for a cipher of any autofill account. The fill runs for the account that
   * owns the cipher and leaves the active account as it is.
   *
   * A cipher of another account that requires a master password reprompt is not filled: the
   * reprompt can only verify the active account. Open it with {@link viewAccountCipher} instead.
   * @param accountCipher The cipher and the account whose vault it came from.
   * @param closePopup If true, will close the popup window after successful autofill. Defaults to true.
   */
  async doAutofillForAccount(accountCipher: AccountCipher, closePopup = true): Promise<boolean> {
    return this._doAutofill(accountCipher.cipher, accountCipher.userId, closePopup, false);
  }

  private async _doAutofill(
    cipher: CipherView,
    userId: UserId | undefined,
    closePopup: boolean,
    skipPasswordReprompt: boolean,
  ): Promise<boolean> {
    const tab = await firstValueFrom(this.currentAutofillTab$);

    const filled = await this._internalDoAutofill(cipher, userId, tab, skipPasswordReprompt);

    if (filled && closePopup) {
      await this._closePopup(cipher, tab);
    }

    return filled;
  }

  /**
   * Opens a cipher in the account that owns it. The vault pages show the active account only, so
   * another account's cipher makes its account the active one first. The master password reprompt
   * then runs for that account.
   *
   * @returns False when the account could not be made active (it locked or logged out in the
   * meantime) or the reprompt was declined.
   */
  async viewAccountCipher({ userId, cipher }: AccountCipher<CipherViewLike>): Promise<boolean> {
    if (userId !== (await this.activeUserId())) {
      const switched = await this.accountSwitcherService.selectAccount(userId);
      // A locked or logged-out account is routed by the background and the app component.
      if (switched?.authenticationStatus !== AuthenticationStatus.Unlocked) {
        return false;
      }
    }

    if (!(await this.passwordRepromptService.passwordRepromptCheck(cipher))) {
      return false;
    }

    return await this.router.navigate(["/view-cipher"], {
      queryParams: { cipherId: cipher.id, type: CipherViewLikeUtils.getType(cipher) },
    });
  }

  /**
   * When a user autofills with an autofill suggestion outside of the inline menu,
   * update the cipher's last used date.
   *
   * @param message - The cipher ID that was used and the account that owns the cipher. Without an
   * account, the active account.
   */
  async handleAutofillSuggestionUsed(message: { cipherId: string; userId?: UserId }) {
    const userId = message.userId ?? (await this.activeUserId());
    if (userId) {
      await this.cipherService.updateLastUsedDate(message.cipherId, userId);
    }
  }

  /**
   * Attempts to autofill the given cipher and, upon successful autofill, saves the URI to the cipher.
   * Will copy any TOTP code to the clipboard if available after successful autofill.
   * @param cipher The cipher to autofill and save. Only Login ciphers are supported.
   * @param closePopup If true, will close the popup window after successful autofill.
   * If false, will show a success toast instead. Defaults to true.
   */
  async doAutofillAndSave(
    cipher: CipherView,
    closePopup = true,
    skipPasswordReprompt = false,
  ): Promise<boolean> {
    // We can only save URIs for login ciphers
    if (cipher.type !== CipherType.Login) {
      return false;
    }

    const tab = await firstValueFrom(this.currentAutofillTab$);

    // Saving the URI writes to the active account's vault, so this serves its ciphers only.
    const filled = await this._internalDoAutofill(
      cipher,
      await this.activeUserId(),
      tab,
      skipPasswordReprompt,
    );

    if (!filled) {
      return false;
    }

    const didSaveUri = await this._saveNewUri(cipher, tab);

    if (!didSaveUri) {
      return false;
    }

    if (closePopup) {
      await this._closePopup(cipher, tab);
    } else {
      this.toastService.showToast({
        variant: "success",
        title: null,
        message: this.i18nService.t("autoFillSuccessAndSavedUri"),
      });
    }

    return true;
  }

  /**
   * Saves the current tab's URL as a new URI for the given cipher. If the cipher already has a URI for the tab,
   * this method does nothing and returns true.
   * @private
   */
  private async _saveNewUri(cipher: CipherView, tab: chrome.tabs.Tab): Promise<boolean> {
    cipher.login.uris ??= [];

    if (cipher.login.uris.some((uri) => uri.uri === tab.url)) {
      // Cipher already has a URI for this tab
      return true;
    }

    const loginUri = new LoginUriView();
    loginUri.uri = tab.url;
    cipher.login.uris.push(loginUri);

    try {
      const activeUserId = await firstValueFrom(
        this.accountService.activeAccount$.pipe(map((a) => a?.id)),
      );
      await this.cipherService.updateWithServer(cipher, activeUserId);
      this.messagingService.send("editedCipher");
      return true;
    } catch {
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: this.i18nService.t("unexpectedError"),
      });
      return false;
    }
  }
}
