import { CommonModule } from "@angular/common";
import { booleanAttribute, Component, inject, input, Input } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { Router, RouterModule } from "@angular/router";
import {
  BehaviorSubject,
  combineLatest,
  firstValueFrom,
  map,
  Observable,
  of,
  switchMap,
} from "rxjs";
import { filter } from "rxjs/operators";

import { CollectionService } from "@bitwarden/admin-console/common";
import { PremiumBadgeComponent } from "@bitwarden/angular/billing/components/premium-badge";
import { JslibModule } from "@bitwarden/angular/jslib.module";
import { BrowserPremiumUpgradePromptService } from "@bitwarden/browser/billing/popup/services/browser-premium-upgrade-prompt.service";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { DomainSettingsService } from "@bitwarden/common/autofill/services/domain-settings.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { uuidAsString } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { CipherArchiveService } from "@bitwarden/common/vault/abstractions/cipher-archive.service";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { PremiumUpgradePromptService } from "@bitwarden/common/vault/abstractions/premium-upgrade-prompt.service";
import { RevealedCipherService } from "@bitwarden/common/vault/abstractions/revealed-cipher.service";
import { CipherRepromptType, CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { CipherAuthorizationService } from "@bitwarden/common/vault/services/cipher-authorization.service";
import { RestrictedItemTypesService } from "@bitwarden/common/vault/services/restricted-item-types.service";
import {
  CipherViewLike,
  CipherViewLikeUtils,
} from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import {
  RestrictedCipherAction,
  RestrictedCipherPolicy,
} from "@bitwarden/common/vault/utils/restricted-cipher-policy";
import {
  DialogService,
  IconButtonModule,
  ItemModule,
  MenuModule,
  ToastService,
  IconModule,
} from "@bitwarden/components";
import { ShareLinkMenuItemDirective } from "@bitwarden/tools-share";
import {
  PasswordRepromptService,
  uniqueContributedActions,
  VAULT_ROW_ACTIONS,
  Vfo1I18nPipe,
} from "@bitwarden/vault";

import { VaultPopupAutofillService } from "../../../services/vault-popup-autofill.service";
import { itemAccountQueryParams } from "../../../services/vault-popup-item-account.service";
import { AddEditQueryParams } from "../add-edit/add-edit.component";
import {
  AutofillConfirmationDialogComponent,
  AutofillConfirmationDialogResult,
} from "../autofill-confirmation-dialog/autofill-confirmation-dialog.component";

/** IDs of the menu's own actions. Contributed action IDs must differ. */
const BUILT_IN_ACTION_IDS: ReadonlySet<string> = new Set([
  "autofill",
  "view",
  "addFavorite",
  "removeFavorite",
  "edit",
  "clone",
  "addToSharedFolder",
  "shareViaLink",
  "archive",
  "delete",
]);

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-item-more-options",
  templateUrl: "./item-more-options.component.html",
  imports: [
    ItemModule,
    IconButtonModule,
    MenuModule,
    CommonModule,
    JslibModule,
    RouterModule,
    PremiumBadgeComponent,
    IconModule,
    Vfo1I18nPipe,
    ShareLinkMenuItemDirective,
  ],
  providers: [
    { provide: PremiumUpgradePromptService, useClass: BrowserPremiumUpgradePromptService },
  ],
})
export class ItemMoreOptionsComponent {
  private _cipher$ = new BehaviorSubject<CipherViewLike>({} as CipherViewLike);

  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input({
    required: true,
  })
  set cipher(c: CipherViewLike) {
    this._cipher$.next(c);
  }

  get cipher() {
    return this._cipher$.value;
  }

  private _userId$ = new BehaviorSubject<UserId | undefined>(undefined);

  /**
   * The account whose vault holds the cipher. Every action of the menu then runs for that
   * account: permissions, premium, the master password re-prompt, favourite, archive, delete, and
   * the pages it opens. Defaults to the active account.
   */
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input()
  set userId(userId: UserId | undefined) {
    this._userId$.next(userId ?? undefined);
  }

  get userId(): UserId | undefined {
    return this._userId$.value;
  }

  /** {@link userId} when given, else the active account. */
  private readonly userId$: Observable<UserId> = this._userId$.pipe(
    switchMap((userId) =>
      userId != null ? of(userId) : this.accountService.activeAccount$.pipe(getUserId),
    ),
  );

  /**
   * True while {@link userId} names an account other than the active one. Actions that can only
   * act on the active account are not offered then.
   */
  protected readonly otherAccount = toSignal(
    this._userId$.pipe(
      switchMap((userId) =>
        userId == null
          ? of(false)
          : this.accountService.activeAccount$.pipe(map((account) => account?.id !== userId)),
      ),
    ),
    { initialValue: false },
  );

  /**
   * Flag to show the autofill menu option.
   * When true, the "Autofill" option appears in the menu.
   */
  readonly showAutofill = input(false, { transform: booleanAttribute });

  /**
   * Flag to show the view menu option.
   * When true, the "View" option appears in the menu.
   * Used when the primary action is autofill (so users can view without autofilling).
   */
  readonly showViewOption = input(false, { transform: booleanAttribute });

  protected autofillAllowed$ = this.vaultPopupAutofillService.autofillAllowed$;

  protected readonly RestrictedCipherAction = RestrictedCipherAction;
  private readonly revealedCipherService = inject(RevealedCipherService);

  /** Actions another feature adds (`VAULT_ROW_ACTIONS`), shown after View. */
  protected readonly contributedActions = uniqueContributedActions(
    inject(VAULT_ROW_ACTIONS, { optional: true }) ?? [],
    BUILT_IN_ACTION_IDS,
  );

  /** The live revealed view of this row's restricted cipher, if any. */
  private readonly revealedView = toSignal(
    combineLatest([this._cipher$, this.userId$]).pipe(
      switchMap(([cipher, userId]) =>
        cipher?.id == null
          ? of(undefined)
          : this.revealedCipherService
              .revealed$(userId)
              .pipe(map((revealed) => revealed.get(cipher.id as CipherId))),
      ),
    ),
    { initialValue: undefined },
  );

  /**
   * Observable that emits a boolean value indicating if the user is authorized to clone the cipher.
   * @protected
   */
  protected canClone$ = combineLatest([
    this._cipher$,
    this._userId$.pipe(
      switchMap((userId) =>
        userId == null
          ? this.restrictedItemTypesService.restricted$
          : this.restrictedItemTypesService.restrictedFor$(userId),
      ),
    ),
  ]).pipe(
    filter(([c]) => c != null),
    switchMap(([c, restrictedTypes]) => {
      // This will check for restrictions from org policies before allowing cloning.
      const isItemRestricted = restrictedTypes.some(
        (restrictType) => restrictType.cipherType === CipherViewLikeUtils.getType(c),
      );
      if (!isItemRestricted) {
        return this.cipherAuthorizationService.canCloneCipher$(c, undefined, this.userId);
      }
      return new BehaviorSubject(false);
    }),
  );

  /** Observable Boolean dependent on the current user having access to an organization and editable collections */
  protected canAssignCollections$ = this.userId$.pipe(
    switchMap((userId) => {
      return combineLatest([
        this.organizationService.hasOrganizations(userId),
        this.collectionService.decryptedCollections$(userId),
      ]).pipe(
        map(([hasOrgs, collections]) => {
          const canEditCollections = collections.some((c) => !c.readOnly);
          return hasOrgs && canEditCollections;
        }),
      );
    }),
  );

  protected canArchive$: Observable<boolean> = this.userId$.pipe(
    switchMap((userId) => this.cipherArchiveService.userCanArchive$(userId)),
  );

  protected canDelete$ = combineLatest([this._cipher$, this._userId$]).pipe(
    switchMap(([cipher, userId]) =>
      this.cipherAuthorizationService.canDeleteCipher$(cipher, undefined, userId),
    ),
  );

  constructor(
    private cipherService: CipherService,
    private passwordRepromptService: PasswordRepromptService,
    private toastService: ToastService,
    private dialogService: DialogService,
    private router: Router,
    private i18nService: I18nService,
    private vaultPopupAutofillService: VaultPopupAutofillService,
    private accountService: AccountService,
    private organizationService: OrganizationService,
    private cipherAuthorizationService: CipherAuthorizationService,
    private collectionService: CollectionService,
    private restrictedItemTypesService: RestrictedItemTypesService,
    private cipherArchiveService: CipherArchiveService,
    private domainSettingsService: DomainSettingsService,
  ) {}

  /**
   * A restricted item arrives as a reduced partial envelope: there is nothing to edit or fill until
   * it is revealed, and the form and autofill paths do not exclude partials themselves.
   */
  get isPartial() {
    return RestrictedCipherPolicy.isRestricted(this.cipher);
  }

  /**
   * True for a restricted item with no live revealed view: only the view option remains. While a
   * reveal is live, the restricted-cipher policy decides each action instead.
   */
  protected get isLocked() {
    return this.isPartial && this.revealedView() == null;
  }

  get canEdit() {
    return this.cipher.edit && this.allows(RestrictedCipherAction.Edit);
  }

  /** False when the restricted-cipher rule blocks the action. */
  protected allows(action: RestrictedCipherAction): boolean {
    return RestrictedCipherPolicy.allows(this.cipher, action, this.revealedView());
  }

  get canViewPassword() {
    return this.cipher.viewPassword;
  }

  get decryptionFailure() {
    return CipherViewLikeUtils.decryptionFailure(this.cipher);
  }

  /**
   * Determines if the cipher can be autofilled.
   */
  get canAutofill() {
    // A restricted cipher without a revealed view has nothing to fill.
    return (
      !this.isLocked &&
      (
        [CipherType.Login, CipherType.Card, CipherType.Identity, CipherType.SshKey] as CipherType[]
      ).includes(CipherViewLikeUtils.getType(this.cipher))
    );
  }

  get isLogin() {
    return CipherViewLikeUtils.getType(this.cipher) === CipherType.Login;
  }

  get favoriteText() {
    return this.cipher.favorite ? "unfavorite" : "favorite";
  }

  async doAutofillAndSave() {
    const cipher = await this.cipherService.getFullCipherView(this.cipher, this.userId);
    if (this.userId != null) {
      // Saving the URL writes to the active account's vault, so another account's cipher is
      // filled without it.
      await this.fill(cipher);
      return;
    }
    await this.vaultPopupAutofillService.doAutofillAndSave(cipher);
  }

  /**
   * Fills the cipher from the vault of {@link userId}. Without one it fills from the active
   * account as it always has, the re-prompt having been answered by the caller.
   */
  private fill(cipher: CipherView): Promise<boolean> {
    const userId = this.userId;
    return userId == null
      ? this.vaultPopupAutofillService.doAutofill(cipher, true, true)
      : this.vaultPopupAutofillService.doAutofillForAccount({ userId, cipher }, true);
  }

  async doAutofill() {
    const cipher = await this.cipherService.getFullCipherView(this.cipher, this.userId);

    // `doAutofillForAccount` asks for the re-prompt of another account itself.
    if (
      this.userId == null &&
      !(await this.passwordRepromptService.passwordRepromptCheck(this.cipher))
    ) {
      return;
    }

    //for non login types that are still auto-fillable
    if (CipherViewLikeUtils.getType(cipher) !== CipherType.Login) {
      await this.fill(cipher);
      return;
    }

    //this tab checking should be moved into the vault-popup-autofill service in case the current tab is changed
    //ticket: https://bitwarden.atlassian.net/browse/PM-32467
    const currentTab = await firstValueFrom(this.vaultPopupAutofillService.currentAutofillTab$);

    if (!currentTab?.url) {
      await this.dialogService.openSimpleDialog({
        title: { key: "error" },
        content: { key: "errorGettingAutoFillData" },
        type: "danger",
      });
      return;
    }

    if (await this._domainMatched(currentTab.url)) {
      await this.fill(cipher);
      return;
    }

    const ref = AutofillConfirmationDialogComponent.open(this.dialogService, {
      data: {
        currentUrl: currentTab?.url || "",
        savedUris: cipher.login?.uris?.filter((u) => u.uri) ?? [],
        // Adding the URL saves the cipher outside the edit form, which a restricted cipher refuses.
        viewOnly:
          !this.cipher.edit ||
          RestrictedCipherPolicy.isRestricted(this.cipher) ||
          this.revealedView() != null ||
          // Adding the URL saves to the active account's vault.
          this.userId != null,
      },
    });

    const result = await firstValueFrom(ref.closed);

    switch (result) {
      case AutofillConfirmationDialogResult.Canceled:
        return;
      case AutofillConfirmationDialogResult.AutofilledOnly:
        await this.fill(cipher);
        return;
      case AutofillConfirmationDialogResult.AutofillAndUrlAdded:
        await this.vaultPopupAutofillService.doAutofillAndSave(cipher, false, true);
        return;
    }
  }

  private async _domainMatched(url: string): Promise<boolean> {
    const userId = this.userId;
    const equivalentDomains = await firstValueFrom(
      userId == null
        ? this.domainSettingsService.getUrlEquivalentDomains(url)
        : this.domainSettingsService.getUrlEquivalentDomains(url, userId),
    );
    const defaultMatch = await firstValueFrom(
      userId == null
        ? this.domainSettingsService.resolvedDefaultUriMatchStrategy$
        : this.domainSettingsService.resolvedDefaultUriMatchStrategyFor$(userId),
    );

    return CipherViewLikeUtils.matchesUri(this.cipher, url, equivalentDomains, defaultMatch);
  }

  async onView() {
    const repromptPassed = await this.passwordRepromptService.passwordRepromptCheck(
      this.cipher,
      this.userId,
    );
    if (!repromptPassed) {
      return;
    }
    await this.router.navigate(["/view-cipher"], {
      queryParams: {
        cipherId: this.cipher.id,
        type: CipherViewLikeUtils.getType(this.cipher),
        ...itemAccountQueryParams(this.userId),
      },
    });
  }

  /**
   * Toggles the favorite status of the cipher and updates it on the server.
   */
  async toggleFavorite() {
    const activeUserId = await firstValueFrom(this.userId$);
    // Change the stored copy, not the row: a revealed row is the shared revealed view.
    const stored = await this.cipherService.get(uuidAsString(this.cipher.id!), activeUserId);
    const cipher = await this.cipherService.decrypt(stored, activeUserId);

    cipher.favorite = !cipher.favorite;
    await this.cipherService.updateWithServer(cipher, activeUserId);

    if (this.revealedView() != null) {
      await this.revealedCipherService.refresh(activeUserId, cipher.id as CipherId);
    }

    this.toastService.showToast({
      variant: "success",
      message: this.i18nService.t(
        cipher.favorite ? "itemAddedToFavorites" : "itemRemovedFromFavorites",
      ),
    });
  }

  /**
   * Navigate to the clone cipher page with the current cipher as the source.
   * A password reprompt is attempted if the cipher requires it.
   * A confirmation dialog is shown if the cipher has FIDO2 credentials.
   */
  async clone() {
    if (
      this.cipher.reprompt === CipherRepromptType.Password &&
      !(await this.passwordRepromptService.showPasswordPrompt(this.userId))
    ) {
      return;
    }

    if (CipherViewLikeUtils.hasFido2Credentials(this.cipher)) {
      const confirmed = await this.dialogService.openSimpleDialog({
        title: { key: "passkeyNotCopied" },
        content: { key: "passkeyNotCopiedAlert" },
        type: "info",
      });

      if (!confirmed) {
        return;
      }
    }

    await this.router.navigate(["/clone-cipher"], {
      queryParams: {
        clone: true.toString(),
        cipherId: this.cipher.id,
        type: CipherViewLikeUtils.getType(this.cipher).toString(),
        ...itemAccountQueryParams(this.userId),
      } as AddEditQueryParams,
    });
  }

  /** Prompts for password when necessary then navigates to the assign collections route */
  async conditionallyNavigateToAssignCollections() {
    if (
      this.cipher.reprompt &&
      !(await this.passwordRepromptService.showPasswordPrompt(this.userId))
    ) {
      return;
    }

    await this.router.navigate(["/assign-collections"], {
      queryParams: { cipherId: this.cipher.id, ...itemAccountQueryParams(this.userId) },
    });
  }

  protected async edit() {
    if (
      this.cipher.reprompt &&
      !(await this.passwordRepromptService.showPasswordPrompt(this.userId))
    ) {
      return;
    }

    await this.router.navigate(["/edit-cipher"], {
      queryParams: {
        cipherId: this.cipher.id,
        type: CipherViewLikeUtils.getType(this.cipher),
        ...itemAccountQueryParams(this.userId),
      },
    });
  }

  protected async delete() {
    const repromptPassed = await this.passwordRepromptService.passwordRepromptCheck(
      this.cipher,
      this.userId,
    );
    if (!repromptPassed) {
      return;
    }

    const confirmed = await this.dialogService.openSimpleDialog({
      title: { key: "deleteItem" },
      content: { key: "deleteItemConfirmation" },
      type: "warning",
    });

    if (!confirmed) {
      return;
    }

    const activeUserId = await firstValueFrom(this.userId$);

    await this.cipherService.softDeleteWithServer(this.cipher.id as CipherId, activeUserId);

    this.toastService.showToast({
      variant: "success",
      message: this.i18nService.t("deletedItem"),
    });
  }

  async archive() {
    const repromptPassed = await this.passwordRepromptService.passwordRepromptCheck(
      this.cipher,
      this.userId,
    );
    if (!repromptPassed) {
      return;
    }

    const confirmed = await this.dialogService.openSimpleDialog({
      title: { key: "archiveItem" },
      content: { key: "archiveItemDialogContent" },
      acceptButtonText: { key: "archiveVerb" },
      type: "info",
    });

    if (!confirmed) {
      return;
    }

    const activeUserId = await firstValueFrom(this.userId$);
    await this.cipherArchiveService.archiveWithServer(this.cipher.id as CipherId, activeUserId);
    this.toastService.showToast({
      variant: "success",
      message: this.i18nService.t("itemArchiveToast"),
    });
  }
}
