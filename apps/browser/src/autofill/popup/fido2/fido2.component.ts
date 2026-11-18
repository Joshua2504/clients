import { CommonModule } from "@angular/common";
import { Component, OnDestroy, OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import {
  BehaviorSubject,
  combineLatest,
  concatMap,
  filter,
  firstValueFrom,
  lastValueFrom,
  map,
  Observable,
  Subject,
  take,
  takeUntil,
} from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { NoResults } from "@bitwarden/assets/svg";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import { getOptionalUserId } from "@bitwarden/common/auth/services/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { DomainSettingsService } from "@bitwarden/common/autofill/services/domain-settings.service";
import {
  AccountCipher,
  accountCipherKey,
  AccountCipherRef,
  accountCipherRef,
} from "@bitwarden/common/autofill/types/account-cipher";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { Fido2Utils } from "@bitwarden/common/platform/services/fido2/fido2-utils";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { SearchService } from "@bitwarden/common/vault/abstractions/search.service";
import { SecureNoteType, CipherType } from "@bitwarden/common/vault/enums";
import { CipherRepromptType } from "@bitwarden/common/vault/enums/cipher-reprompt-type";
import { CardView } from "@bitwarden/common/vault/models/view/card.view";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { IdentityView } from "@bitwarden/common/vault/models/view/identity.view";
import { LoginUriView } from "@bitwarden/common/vault/models/view/login-uri.view";
import { LoginView } from "@bitwarden/common/vault/models/view/login.view";
import { SecureNoteView } from "@bitwarden/common/vault/models/view/secure-note.view";
import {
  ButtonModule,
  DialogService,
  FormFieldModule,
  ItemModule,
  StatusLockupComponent,
  SearchModule,
  SectionComponent,
  SectionHeaderComponent,
  SelectModule,
  SvgComponent,
} from "@bitwarden/components";
import { PasswordRepromptService } from "@bitwarden/vault";

import { ZonedMessageListenerService } from "../../../platform/browser/zoned-message-listener.service";
import { PopupHeaderComponent } from "../../../platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "../../../platform/popup/layout/popup-page.component";
import { VaultPopoutType } from "../../../vault/popup/utils/vault-popout-window";
import {
  BrowserFido2Message,
  BrowserFido2UserInterfaceSession,
  BrowserFido2MessageTypes,
} from "../../fido2/services/browser-fido2-user-interface.service";
import { CipherUse } from "../../services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../../services/abstractions/multi-account-fill-cipher-policy";

import { Fido2AccountPasswordRepromptComponent } from "./fido2-account-password-reprompt.component";
import { Fido2CipherRowComponent } from "./fido2-cipher-row.component";
import { Fido2UseBrowserLinkComponent } from "./fido2-use-browser-link.component";

const PasskeyActions = {
  Register: "register",
  Authenticate: "authenticate",
} as const;

type PasskeyActionValue = (typeof PasskeyActions)[keyof typeof PasskeyActions];

interface ViewData {
  message: BrowserFido2Message;
  fallbackSupported: boolean;
}

/** An account a new passkey can be saved to. */
interface AccountOption {
  userId: UserId;
  label: string;
}

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-fido2",
  templateUrl: "fido2.component.html",
  imports: [
    ButtonModule,
    CommonModule,
    Fido2CipherRowComponent,
    Fido2UseBrowserLinkComponent,
    FormFieldModule,
    FormsModule,
    ItemModule,
    JslibModule,
    StatusLockupComponent,
    PopupHeaderComponent,
    PopupPageComponent,
    SearchModule,
    SectionComponent,
    SectionHeaderComponent,
    SelectModule,
    SvgComponent,
  ],
})
export class Fido2Component implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  private message$ = new BehaviorSubject<BrowserFido2Message | null>(null);
  protected BrowserFido2MessageTypes = BrowserFido2MessageTypes;
  /**
   * The accounts a new passkey can be saved to, the default first. The user chooses among them
   * when there is more than one.
   */
  protected accounts: AccountOption[] = [];
  protected activeUserId: UserId | null = null;
  protected cipher: AccountCipher | null = null;
  protected ciphers: AccountCipher[] = [];
  protected data$!: Observable<ViewData>;
  protected displayedCiphers: AccountCipher[] = [];
  protected equivalentDomains: Set<string> = new Set();
  protected equivalentDomainsKey: string | undefined = undefined;
  protected loading = false;
  protected noResultsIcon = NoResults;
  protected passkeyAction: PasskeyActionValue = PasskeyActions.Register;
  protected PasskeyActions = PasskeyActions;
  protected hasSearched = false;
  protected searchText: string | null = null;
  protected searchTypeSearch = false;
  protected senderTabId: string | undefined = undefined;
  protected sessionId: string | undefined = undefined;
  /** Whether each listed cipher is shown with the account it belongs to. */
  protected showAccountLabels = false;
  protected showNewPasskeyButton: boolean = false;
  /** The account a new passkey is saved to. The listed logins are this account's. */
  protected targetUserId: UserId | null = null;
  protected url: string | undefined = undefined;
  private accountLabels = new Map<UserId, string>();

  constructor(
    private router: Router,
    private activatedRoute: ActivatedRoute,
    private cipherService: CipherService,
    private platformUtilsService: PlatformUtilsService,
    private domainSettingsService: DomainSettingsService,
    private searchService: SearchService,
    private logService: LogService,
    private dialogService: DialogService,
    private browserMessagingApi: ZonedMessageListenerService,
    private passwordRepromptService: PasswordRepromptService,
    private accountService: AccountService,
    private multiAccountFillCipherPolicy: MultiAccountFillCipherPolicy,
    private autofillAccountsService: AutofillAccountsService,
    private userVerificationService: UserVerificationService,
  ) {}

  ngOnInit() {
    this.searchTypeSearch = !this.platformUtilsService.isSafari();

    const queryParams$ = this.activatedRoute.queryParamMap.pipe(
      take(1),
      map((queryParamMap) => ({
        sessionId: queryParamMap.get("sessionId") ?? undefined,
        senderTabId: queryParamMap.get("senderTabId") ?? undefined,
        senderUrl: queryParamMap.get("senderUrl") ?? undefined,
      })),
    );

    combineLatest([
      queryParams$,
      this.browserMessagingApi.messageListener$() as Observable<BrowserFido2Message>,
    ])
      .pipe(
        concatMap(async ([queryParams, message]) => {
          this.sessionId = queryParams.sessionId;
          this.senderTabId = queryParams.senderTabId;
          this.url = queryParams.senderUrl;
          // For a 'NewSessionCreatedRequest', abort if it doesn't belong to the current session.
          if (
            message.type === BrowserFido2MessageTypes.NewSessionCreatedRequest &&
            message.sessionId !== queryParams.sessionId
          ) {
            this.abort(false);
            return;
          }

          // Ignore messages that don't belong to the current session.
          if (message.sessionId !== queryParams.sessionId) {
            return;
          }

          if (message.type === BrowserFido2MessageTypes.AbortRequest) {
            this.abort(false);
            return;
          }

          return message;
        }),
        filter((message) => !!message),
        takeUntil(this.destroy$),
      )
      .subscribe((message) => {
        this.message$.next(message);
      });

    this.data$ = this.message$.pipe(
      filter((message): message is BrowserFido2Message => message != null),
      concatMap(async (message) => {
        switch (message.type) {
          case BrowserFido2MessageTypes.ConfirmNewCredentialRequest: {
            if (this.url == null) {
              this.displayedCiphers = [];
              break;
            }
            const activeUserId = await this.loadAccounts();
            // A sender that names no account saves to the active account.
            const userIds =
              message.userIds.length > 0
                ? message.userIds
                : activeUserId != null
                  ? [activeUserId]
                  : [];
            this.accounts = userIds.map((userId) => ({
              userId,
              label: this.accountLabel(userId),
            }));
            this.targetUserId = userIds[0] ?? null;
            await this.loadLoginsOfTargetAccount(message.userHandle);

            this.passkeyAction = PasskeyActions.Register;

            // @TODO fix new cipher creation for other fido2 registration message types and remove `showNewPasskeyButton` from the template
            this.showNewPasskeyButton = true;

            break;
          }

          case BrowserFido2MessageTypes.PickCredentialRequest: {
            await this.loadCiphersOfAccounts(message.cipherRefs);

            this.displayedCiphers = [...this.ciphers];

            this.passkeyAction = PasskeyActions.Authenticate;

            break;
          }

          case BrowserFido2MessageTypes.InformExcludedCredentialRequest: {
            await this.loadCiphersOfAccounts(message.existingCipherRefs);

            this.displayedCiphers = [...this.ciphers];

            this.passkeyAction = PasskeyActions.Register;

            break;
          }

          case BrowserFido2MessageTypes.InformCredentialNotFoundRequest: {
            this.passkeyAction = PasskeyActions.Authenticate;

            break;
          }
        }

        return {
          message,
          fallbackSupported: "fallbackSupported" in message && message.fallbackSupported,
        };
      }),

      takeUntil(this.destroy$),
    );

    queryParams$.pipe(takeUntil(this.destroy$)).subscribe((queryParams) => {
      if (queryParams.sessionId != null) {
        this.send({
          sessionId: queryParams.sessionId,
          type: BrowserFido2MessageTypes.ConnectResponse,
        });
      }
    });
  }

  protected async submit() {
    const data = this.message$.value;
    if (this.sessionId == null || this.cipher == null) {
      return;
    }

    if (
      data?.type !== BrowserFido2MessageTypes.PickCredentialRequest &&
      data?.type !== BrowserFido2MessageTypes.ConfirmNewCredentialRequest
    ) {
      // Nothing to confirm: an excluded credential is only shown.
      this.loading = true;
      return;
    }

    // The passkey belongs to the account shown with it. When that account locked or logged out
    // while the user was choosing, the request ends here.
    if (!(await this.isServed(this.cipher.userId))) {
      this.abort(false);
      return;
    }

    if (data.type === BrowserFido2MessageTypes.PickCredentialRequest) {
      // TODO: Revert to use fido2 user verification service once user verification for passkeys is approved for production.
      // PM-4577 - https://github.com/bitwarden/clients/pull/8746
      const userVerified = await this.handleUserVerification(data.userVerification, this.cipher);

      this.send({
        sessionId: this.sessionId,
        ...accountCipherRef(this.cipher),
        type: BrowserFido2MessageTypes.PickCredentialResponse,
        userVerified,
      });
    } else {
      if (this.cipher.cipher.login.hasFido2Credentials) {
        const confirmed = await this.dialogService.openSimpleDialog({
          title: { key: "overwritePasskey" },
          content: { key: "overwritePasskeyAlert" },
          type: "warning",
        });

        if (!confirmed) {
          return false;
        }
      }

      // TODO: Revert to use fido2 user verification service once user verification for passkeys is approved for production.
      // PM-4577 - https://github.com/bitwarden/clients/pull/8746
      const userVerified = await this.handleUserVerification(data.userVerification, this.cipher);

      this.send({
        sessionId: this.sessionId,
        ...accountCipherRef(this.cipher),
        type: BrowserFido2MessageTypes.ConfirmNewCredentialResponse,
        userVerified,
      });
    }

    this.loading = true;
  }

  protected async saveNewLogin() {
    const data = this.message$.value;

    if (data?.type === BrowserFido2MessageTypes.ConfirmNewCredentialRequest) {
      if (this.targetUserId == null) {
        return;
      }
      const userId = this.targetUserId;
      if (!(await this.isServed(userId))) {
        this.abort(false);
        return;
      }

      const name = data.credentialName || data.rpId;
      // TODO: Revert to check for user verification once user verification for passkeys is approved for production.
      // PM-4577 - https://github.com/bitwarden/clients/pull/8746
      await this.createNewCipher(name, data.userName, userId);

      if (this.sessionId == null || this.cipher == null) {
        return;
      }
      // We are bypassing user verification pending approval.
      this.send({
        sessionId: this.sessionId,
        ...accountCipherRef(this.cipher),
        type: BrowserFido2MessageTypes.ConfirmNewCredentialResponse,
        userVerified: data.userVerification,
      });
    }

    this.loading = true;
  }

  async handleCipherItemSelect(item: AccountCipher) {
    this.cipher = item;

    await this.submit();
  }

  /** Saves the new passkey to `userId` instead, and lists that account's logins. */
  protected async selectTargetAccount(userId: UserId) {
    const data = this.message$.value;
    if (
      data?.type !== BrowserFido2MessageTypes.ConfirmNewCredentialRequest ||
      !this.accounts.some((account) => account.userId === userId)
    ) {
      return;
    }

    this.targetUserId = userId;
    this.cipher = null;
    this.searchText = "";
    this.hasSearched = false;
    await this.loadLoginsOfTargetAccount(data.userHandle);
  }

  /**
   * Whether a login can be created in the item form. The form saves to the active account, so
   * it is offered only while the passkey is saved there.
   */
  protected get canAddCipher(): boolean {
    return this.showNewPasskeyButton && this.targetUserId === this.activeUserId;
  }

  protected cipherKey(item: AccountCipher): string {
    return accountCipherKey(accountCipherRef(item));
  }

  protected accountLabel(userId: UserId): string {
    return this.accountLabels.get(userId) ?? "";
  }

  async addCipher() {
    const data = this.message$.value;

    if (
      data?.type === BrowserFido2MessageTypes.ConfirmNewCredentialRequest &&
      this.sessionId != null &&
      this.url != null &&
      this.canAddCipher
    ) {
      await this.router.navigate(["/add-cipher"], {
        queryParams: {
          type: CipherType.Login.toString(),
          name: data.credentialName || data.rpId,
          uri: this.url,
          uilocation: "popout",
          username: data.userName,
          senderTabId: this.senderTabId,
          sessionId: this.sessionId,
          userVerification: data.userVerification,
          singleActionPopout: `${VaultPopoutType.fido2Popout}_${this.sessionId}`,
        },
      });
    }

    return;
  }

  async getEquivalentDomains(): Promise<Set<string>> {
    if (this.url == null) {
      return this.equivalentDomains;
    }
    // Equivalent domains are a setting of the account whose logins are listed.
    const userId = this.targetUserId ?? undefined;
    const key = `${userId}:${this.url}`;
    if (this.equivalentDomainsKey !== key) {
      this.equivalentDomainsKey = key;
      this.equivalentDomains = await firstValueFrom(
        this.domainSettingsService.getUrlEquivalentDomains(this.url, userId),
      );
    }

    return this.equivalentDomains;
  }

  async clearSearch() {
    this.searchText = "";
    await this.setDisplayedCiphersToAllDomainMatch();
  }

  protected async setDisplayedCiphersToAllDomainMatch() {
    if (this.url == null) {
      this.displayedCiphers = [...this.ciphers];
      return;
    }
    const url = this.url;
    const equivalentDomains = await this.getEquivalentDomains();
    this.displayedCiphers = this.ciphers.filter(({ cipher }) =>
      cipher.login.matchesUri(url, equivalentDomains),
    );
  }

  protected async search() {
    this.hasSearched = true;
    const isSearchable = await this.searchService.isSearchable(this.searchText);

    if (isSearchable && this.searchText !== null) {
      // Each account's ciphers are searched with that account's index
      const found: AccountCipher[] = [];
      for (const userId of new Set(this.ciphers.map((item) => item.userId))) {
        const ciphers = await this.searchService.searchCiphers(
          userId,
          null,
          this.searchText,
          this.ciphers.filter((item) => item.userId === userId).map((item) => item.cipher),
        );
        found.push(...ciphers.map((cipher) => ({ userId, cipher })));
      }
      this.displayedCiphers = found;
    } else {
      await this.setDisplayedCiphersToAllDomainMatch();
    }
  }

  abort(fallback: boolean) {
    this.unload(fallback);
    window.close();
  }

  unload(fallback = false) {
    if (this.sessionId == null) {
      return;
    }
    this.send({
      sessionId: this.sessionId,
      type: BrowserFido2MessageTypes.AbortResponse,
      fallbackRequested: fallback,
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Reads who the accounts are, and whether listed ciphers are shown with their account: they
   * are when more than one account serves passkeys.
   *
   * @returns The active account, null when there is none.
   */
  private async loadAccounts(): Promise<UserId | null> {
    const activeUserId = await firstValueFrom(
      this.accountService.activeAccount$.pipe(getOptionalUserId),
    );
    const accounts = await firstValueFrom(this.accountService.accounts$);
    const servedUserIds = await firstValueFrom(this.autofillAccountsService.autofillUserIds$);

    this.activeUserId = activeUserId;
    this.accountLabels = new Map(
      (Object.keys(accounts) as UserId[]).map((userId) => [
        userId,
        accounts[userId].email || accounts[userId].name || "",
      ]),
    );
    // A single account that is not the one the popup shows is named as well
    this.showAccountLabels =
      servedUserIds.length > 1 || (servedUserIds.length === 1 && servedUserIds[0] !== activeUserId);

    return activeUserId;
  }

  /**
   * Lists the ciphers named by `refs`, each as its own account holds it. A cipher of an account
   * that does not serve passkeys is left out.
   */
  private async loadCiphersOfAccounts(refs: AccountCipherRef[]) {
    const activeUserId = await this.loadAccounts();

    this.ciphers = await this.multiAccountFillCipherPolicy.ciphersForRefs(refs, CipherUse.Passkey);
    // A cipher of another account than the one the popup shows is always named as such
    this.showAccountLabels ||= this.ciphers.some((item) => item.userId !== activeUserId);
  }

  /** Lists the logins of the account the passkey is saved to that match the requesting site. */
  private async loadLoginsOfTargetAccount(userHandle: string) {
    if (this.url == null || this.targetUserId == null) {
      this.ciphers = [];
      this.displayedCiphers = [];
      return;
    }
    const url = this.url;
    const userId = this.targetUserId;
    const equivalentDomains = await this.getEquivalentDomains();

    this.ciphers = (await this.multiAccountFillCipherPolicy.ciphers(CipherUse.Passkey)).filter(
      (item) =>
        item.userId === userId && item.cipher.type === CipherType.Login && !item.cipher.isDeleted,
    );

    this.displayedCiphers = this.ciphers.filter(
      ({ cipher }) =>
        cipher.login.matchesUri(url, equivalentDomains) &&
        Fido2Utils.cipherHasNoOtherPasskeys(cipher, userHandle),
    );
  }

  /** Whether `userId` serves passkeys now. It stops when the account locks or logs out. */
  private isServed(userId: UserId): Promise<boolean> {
    return firstValueFrom(this.autofillAccountsService.isAutofillUser$(userId));
  }

  private buildCipher(name: string, username: string): CipherView | undefined {
    if (this.url == null) {
      return undefined;
    }
    const url = this.url;
    const cipher = new CipherView();
    cipher.name = name;

    cipher.type = CipherType.Login;
    cipher.login = new LoginView();
    cipher.login.username = username;
    cipher.login.uris = [new LoginUriView()];
    cipher.login.uris[0].uri = url;
    cipher.card = new CardView();
    cipher.identity = new IdentityView();
    cipher.secureNote = new SecureNoteView();
    cipher.secureNote.type = SecureNoteType.Generic;
    cipher.reprompt = CipherRepromptType.None;

    return cipher;
  }

  /** Creates a login for the passkey in the vault of `userId`. */
  private async createNewCipher(name: string, username: string, userId: UserId) {
    const cipher = this.buildCipher(name, username);
    if (cipher == null) {
      return;
    }
    this.cipher = { userId, cipher };
    try {
      const result = await this.cipherService.createWithServer(cipher, userId);
      cipher.id = result.id;
    } catch (e) {
      this.logService.error(e);
    }
  }

  // TODO: Remove and use fido2 user verification service once user verification for passkeys is approved for production.
  private async handleUserVerification(
    userVerificationRequested: boolean,
    { userId, cipher }: AccountCipher,
  ): Promise<boolean> {
    const masterPasswordRepromptRequired = cipher && cipher.reprompt !== 0;

    if (masterPasswordRepromptRequired) {
      // The reprompt is answered with the master password of the account that owns the cipher
      const activeUserId = await firstValueFrom(
        this.accountService.activeAccount$.pipe(getOptionalUserId),
      );
      if (userId === activeUserId) {
        return await this.passwordRepromptService.showPasswordPrompt();
      }

      return await this.showPasswordPromptForAccount(userId);
    }

    return userVerificationRequested;
  }

  /**
   * Asks for the master password of an account that is not the active one. As with the active
   * account, an account without a master password has no reprompt.
   */
  private async showPasswordPromptForAccount(userId: UserId): Promise<boolean> {
    if (!(await this.userVerificationService.hasMasterPassword(userId))) {
      return true;
    }

    const dialog = Fido2AccountPasswordRepromptComponent.open(this.dialogService, {
      userId,
      accountLabel: this.accountLabel(userId),
    });

    return (await lastValueFrom(dialog.closed)) === true;
  }

  private send(msg: BrowserFido2Message) {
    BrowserFido2UserInterfaceSession.sendMessage(msg);
  }
}
