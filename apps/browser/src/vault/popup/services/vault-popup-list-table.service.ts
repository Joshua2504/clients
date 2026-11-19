import { inject, Injectable, NgZone } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { Router } from "@angular/router";
import {
  BehaviorSubject,
  combineLatest,
  debounce,
  distinctUntilChanged,
  firstValueFrom,
  map,
  Observable,
  shareReplay,
  startWith,
  switchMap,
  tap,
  timer,
} from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { uuidAsString } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { SearchTextDebounceInterval } from "@bitwarden/common/vault/services/search.service";
import {
  CipherViewLike,
  CipherViewLikeUtils,
} from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { RestrictedCipherPolicy } from "@bitwarden/common/vault/utils/restricted-cipher-policy";
import { DialogService } from "@bitwarden/components";
import {
  ALL_ITEMS_SCOPE,
  cipherInScope,
  DecryptionFailureDialogComponent,
  matchesFolder,
  matchesSharedFolder,
  matchesType,
  matchesVault,
  PasswordRepromptService,
  type VaultScope,
  VaultScopeType,
} from "@bitwarden/vault";

import { BrowserApi } from "../../../platform/browser/browser-api";
import BrowserPopupUtils from "../../../platform/browser/browser-popup-utils";
import { PopupCipherViewLike } from "../views/popup-cipher.view";

import { VaultPopupAutofillService } from "./vault-popup-autofill.service";
import { itemAccountQueryParams } from "./vault-popup-item-account.service";
import { AccountAutofillCiphers, VaultPopupItemsService } from "./vault-popup-items.service";
import { VaultPopupListTableFiltersService } from "./vault-popup-list-table-filters.service";
import { VaultPopupLoadingService } from "./vault-popup-loading.service";

/**
 * The section a row belongs to within the vault list table. `accountAutofill` is the suggestions
 * section of a further autofill account, one per account, see {@link VaultTableRow.userId}.
 */
export type VaultSection = "autofill" | "accountAutofill" | "favorites" | "allItems";

/** A further autofill account that has suggestions for the current tab. */
export type VaultAccountSection = { userId: UserId; email: string };

/**
 * The resolved action affordances for a single row — which click action it takes and which
 * buttons/menu entries it exposes. Precomputed here so the template stays declarative and the
 * blocklist branching lives in one testable place.
 */
export interface VaultRowActions {
  /** Whether clicking the row autofills (vs. navigating to view). */
  primaryAutofill: boolean;
  /** Reveal the "Fill" text on hover. */
  showFillOnHover: boolean;
  /** Show the launch-in-new-tab button (still gated on the cipher being launchable). */
  showLaunch: boolean;
  /** Show the quick copy actions. */
  showCopyActions: boolean;
  /** Offer "Autofill" in the more-options menu. */
  showAutofillInMenu: boolean;
  /** Offer "View" in the more-options menu. */
  showViewInMenu: boolean;
  /** Resolved i18n key for the row's accessible title. */
  titleKey: string;
}

/** A cipher tagged with the section it renders under and its resolved actions; the row model. */
export type VaultTableRow = {
  cipher: PopupCipherViewLike;
  _section: VaultSection;
  actions: VaultRowActions;
  /**
   * The account whose vault holds the cipher when it is not the active account: set on the rows
   * of an `accountAutofill` section and nowhere else. Every action on the row runs for it.
   */
  userId?: UserId;
};

/** Inputs that decide a row's action affordances. */
interface RowActionContext {
  currentUriIsBlocked: boolean;
}

/**
 * Derives the ordered, section-tagged rows for the vault list table and encapsulates the primary
 * interactions a user can perform on a row (autofill, launch, and view). Kept independent of the
 * component so the section/search-branching behavior and item actions can be tested in isolation.
 */
@Injectable({
  providedIn: "root",
})
export class VaultPopupListTableService {
  private readonly vaultPopupItemsService = inject(VaultPopupItemsService);
  private readonly vaultPopupLoadingService = inject(VaultPopupLoadingService);
  private readonly ngZone = inject(NgZone);
  private readonly cipherService = inject(CipherService);
  private readonly accountService = inject(AccountService);
  private readonly passwordRepromptService = inject(PasswordRepromptService);
  private readonly dialogService = inject(DialogService);
  private readonly router = inject(Router);
  private readonly vaultPopupAutofillService = inject(VaultPopupAutofillService);
  private readonly listFiltersService = inject(VaultPopupListTableFiltersService);

  /**
   * The vault the page's `:vaultId` route segment narrows to.
   */
  private readonly scope$ = new BehaviorSubject<VaultScope>(ALL_ITEMS_SCOPE);

  /** The scope currently narrowing the rows. Read by the table to gate its organization chip. */
  readonly vaultScope = toSignal(this.scope$, { initialValue: ALL_ITEMS_SCOPE });

  /**
   * Narrows the vault to `scope`; {@link ALL_ITEMS_SCOPE} shows every vault's items. Does not
   * touch the chips — each vault keeps its own, keyed by the filter service.
   */
  setScope(scope: VaultScope | null): void {
    this.scope$.next(scope ?? ALL_ITEMS_SCOPE);
  }

  /**
   * Timeout used to add a small delay when selecting a cipher to allow for double click to launch.
   */
  private viewCipherTimeout?: number;

  /** The search text applied to the vault in view (e.g. restored from stored state). */
  readonly searchText = this.vaultPopupItemsService.searchText;

  /** Whether a search term is currently narrowing the vault list. */
  readonly hasSearchText$ = this.vaultPopupItemsService.hasSearchText$;

  /**
   * Whether the account has any active items at all, ignoring search/filters — the account-wide
   * fact `EmptyVaultComponent` needs to distinguish "nothing here because of an active
   * search/filter" from "the vault is genuinely empty."
   */
  readonly hasItems$: Observable<boolean> = this.vaultPopupItemsService.emptyVault$.pipe(
    map((empty) => !empty),
  );

  /**
   * The suggestions of the further autofill accounts, one entry per account. Empty while no
   * account has opted in, and seeded empty so the list never waits for another account's vault.
   */
  private readonly otherAccountCiphers$: Observable<AccountAutofillCiphers[]> =
    this.vaultPopupItemsService.otherAccountAutoFillCiphers$.pipe(
      startWith([] as AccountAutofillCiphers[]),
      // The seed and the answer of a popup where no account has opted in are both empty.
      distinctUntilChanged((a, b) => a.length === 0 && b.length === 0),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

  /**
   * Whether to show the tip that prompts the user to save a login for the current site. The tip
   * stands in for the autofill section's rows, so it only applies when nothing narrows the list,
   * the current context allows autofill (e.g. not a popout), and no login is suggested. A non-login
   * suggestion (a card or an identity) still leaves the tip on, because the site has no login to
   * fill.
   */
  readonly showEmptyAutofillTip$: Observable<boolean> = combineLatest([
    this.vaultPopupItemsService.hasFilterApplied$,
    this.vaultPopupItemsService.autoFillCiphers$,
    this.vaultPopupAutofillService.autofillAllowed$,
    this.otherAccountCiphers$,
  ]).pipe(
    map(
      ([hasFilter, ciphers, autofillAllowed, otherAccounts]) =>
        !hasFilter &&
        autofillAllowed &&
        // A login suggested from another autofill account's vault is a login for this site too.
        ![...ciphers, ...otherAccounts.flatMap((account) => account.ciphers)].some(
          (cipher) => CipherViewLikeUtils.getType(cipher) === CipherType.Login,
        ),
    ),
  );

  /**
   * The inputs that decide each row's action affordances. The `startWith` default keeps
   * {@link rows$} emitting promptly: the blocklist stream resolves asynchronously, so without a
   * seed the whole list would wait on it before first render.
   */
  private readonly rowActionContext$: Observable<RowActionContext> =
    this.vaultPopupAutofillService.currentTabIsOnBlocklist$.pipe(
      startWith(false),
      map((currentUriIsBlocked) => ({ currentUriIsBlocked })),
    );

  /**
   * The rows to render, in display order. When a search is active the list collapses to a single
   * flat "all items" section (mirroring the existing vault, which folds every filtered cipher into
   * one container); otherwise it splits into the autofill, favorites, and all-items sections.
   */
  readonly rows$: Observable<VaultTableRow[]> = combineLatest([
    this.vaultPopupItemsService.autoFillCiphers$,
    this.vaultPopupItemsService.favoriteCiphers$,
    this.vaultPopupItemsService.filteredCiphers$,
    this.vaultPopupItemsService.hasSearchText$,
    this.rowActionContext$,
    this.scope$,
    this.otherAccountCiphers$,
  ]).pipe(
    map(
      ([
        autoFillCiphers,
        favoriteCiphers,
        filteredCiphers,
        hasSearchText,
        context,
        scope,
        otherAccounts,
      ]) => {
        /** One section's rows: the ciphers the scope admits, in display order. */
        const section = (ciphers: PopupCipherViewLike[], name: VaultSection) =>
          ciphers
            .filter((cipher) => cipherInScope(cipher, scope))
            .map((cipher) => this.toRow(cipher, name, context));

        // The search covers the active account's vault alone.
        if (hasSearchText) {
          return section(filteredCiphers, "allItems");
        }

        return [
          ...section(autoFillCiphers, "autofill"),
          // The vault scope and the chips describe the active account's vault, so the
          // suggestions of another account are not narrowed by them.
          ...otherAccounts.flatMap((account) =>
            account.ciphers.map((cipher) => ({
              ...this.toRow(cipher, "accountAutofill", context),
              userId: account.userId,
            })),
          ),
          ...section(favoriteCiphers, "favorites"),
          ...section(filteredCiphers, "allItems"),
        ];
      },
    ),
    // The table renders these and the header counts them, so build the list once per emission.
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /**
   * The further autofill accounts that have suggestions in {@link rows$}, in display order. The
   * table renders one section per entry. Empty while no account has opted in.
   */
  readonly accountSections$: Observable<VaultAccountSection[]> = combineLatest([
    this.rows$,
    this.otherAccountCiphers$,
  ]).pipe(
    map(([rows, otherAccounts]) =>
      otherAccounts
        .filter((account) => rows.some((row) => row.userId === account.userId))
        .map(({ userId, email }) => ({ userId, email })),
    ),
    distinctUntilChanged(
      (a, b) =>
        a.length === b.length &&
        a.every((account, i) => account.userId === b[i].userId && account.email === b[i].email),
    ),
  );

  /**
   * Whether the vault in view is suspended, by route scope or by chip — only one is ever active.
   */
  readonly suspendedVault$: Observable<boolean> = combineLatest([
    this.scope$,
    this.listFiltersService.selectedFilters$,
  ]).pipe(
    switchMap(([scope, selected]) =>
      this.listFiltersService.suspended$(
        scope.type === VaultScopeType.Organization ? [scope.organizationId] : selected.organization,
      ),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /**
   * The header's item count. Counts the `allItems` section, which holds every cipher once, and
   * re-applies the chips, which never reach {@link rows$}. A suspended vault counts zero.
   */
  readonly itemCount$: Observable<number> = combineLatest([
    this.rows$,
    this.listFiltersService.selectedFilters$,
    this.scope$,
    this.suspendedVault$,
  ]).pipe(
    map(([rows, selected, scope, suspended]) => {
      if (suspended) {
        return 0;
      }

      const filters = this.scopedFilters(selected, scope);

      return rows.filter(
        (row) =>
          row._section === "allItems" &&
          matchesType(row.cipher, filters.cipherType) &&
          matchesVault(row.cipher, filters.organization) &&
          matchesSharedFolder(row.cipher, filters.collection) &&
          matchesFolder(row.cipher, filters.folder),
      ).length;
    }),
  );

  /**
   * The chip selection, less what the scope has taken away — a scoped vault renders no vault chip.
   */
  private scopedFilters(
    selected: {
      cipherType: CipherType | null;
      organization: string[];
      collection: string[];
      folder: string[];
    },
    scope: VaultScope,
  ) {
    if (scope.type === VaultScopeType.AllItems) {
      return selected;
    }

    return { ...selected, organization: [] as string[] };
  }

  private toRow(
    cipher: PopupCipherViewLike,
    section: VaultSection,
    context: RowActionContext,
  ): VaultTableRow {
    return {
      cipher,
      _section: section,
      actions: this.resolveActions(cipher, section, context),
    };
  }

  /**
   * Resolves a row's action affordances from its section and the current context. Pure so the
   * blocklist branching can be exercised directly.
   */
  private resolveActions(
    cipher: PopupCipherViewLike,
    section: VaultSection,
    { currentUriIsBlocked }: RowActionContext,
  ): VaultRowActions {
    const isAutofill = section === "autofill" || section === "accountAutofill";
    // The list swaps a revealed view in for its restricted row, so a restricted row has nothing
    // revealed: the server withholds its credentials.
    const gated = RestrictedCipherPolicy.isRestricted(cipher as CipherViewLike);

    // Whether clicking the row autofills: the autofill section fills unless the URI is blocked.
    const primaryAutofill = !gated && isAutofill && !currentUriIsBlocked;

    const login = CipherViewLikeUtils.getLogin(cipher as CipherViewLike);
    const titleBase = primaryAutofill ? "autofillTitle" : "viewItemTitle";

    return {
      primaryAutofill,
      showFillOnHover: primaryAutofill,
      showLaunch: !isAutofill && !gated,
      showCopyActions: !gated,
      showAutofillInMenu: !gated && !primaryAutofill,
      showViewInMenu: primaryAutofill,
      // Name the login's username field in the label when it has one.
      titleKey: login?.username != null ? `${titleBase}WithField` : titleBase,
    };
  }

  /**
   * Applies debounced search input to the vault, mirroring the existing vault search behavior:
   * applied immediately while the vault is loading (to avoid stale results), otherwise debounced by
   * {@link SearchTextDebounceInterval}. Returns a stream the caller subscribes to (and tears down)
   * so the subscription stays tied to the consuming component's lifecycle.
   */
  applyFilterOnInput(searchText$: Observable<string>): Observable<string> {
    return combineLatest([searchText$, this.vaultPopupLoadingService.loading$]).pipe(
      debounce(([, isLoading]) => timer(isLoading ? 0 : SearchTextDebounceInterval)),
      distinctUntilChanged(
        ([prevText, prevLoading], [newText, newLoading]) =>
          prevText === newText && prevLoading === newLoading,
      ),
      map(([text]) => text),
      tap((text) =>
        this.ngZone.runOutsideAngular(() =>
          this.ngZone.run(() => this.vaultPopupItemsService.applyScopedFilter(text)),
        ),
      ),
    );
  }

  /**
   * Refreshes the current tab so the autofill suggestions repopulate. Used by the sidebar, which
   * stays open across navigations and can otherwise show stale suggestions.
   */
  refreshCurrentTab() {
    this.vaultPopupAutofillService.refreshCurrentTab();
  }

  /**
   * Launches the login cipher in a new browser tab.
   * @param userId The account whose vault holds the cipher. Defaults to the active account.
   */
  async launchCipher(cipher: CipherViewLike, userId?: UserId) {
    const launchURI = CipherViewLikeUtils.getLaunchUri(cipher);
    if (
      !CipherViewLikeUtils.canLaunch(cipher) ||
      !launchURI ||
      RestrictedCipherPolicy.isRestricted(cipher)
    ) {
      return;
    }

    // If there is a view action pending, clear it
    if (this.viewCipherTimeout != null) {
      window.clearTimeout(this.viewCipherTimeout);
      this.viewCipherTimeout = undefined;
    }

    const cipherUserId =
      userId ?? (await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId)));
    await this.cipherService.updateLastLaunchedDate(uuidAsString(cipher.id!), cipherUserId);

    await BrowserApi.createNewTab(launchURI);

    if (BrowserPopupUtils.inPopup(window)) {
      BrowserApi.closePopup(window);
    }
  }

  /**
   * @param userId The account whose vault holds the cipher. The fill then runs for that account,
   * its master password reprompt included, and leaves the active account as it is. Defaults to
   * the active account.
   */
  async doAutofill(cipher: PopupCipherViewLike, userId?: UserId) {
    if (userId != null) {
      const cipherView = CipherViewLikeUtils.isCipherListView(cipher)
        ? await firstValueFrom(
            this.cipherService.cipherView$(userId, uuidAsString(cipher.id!) as CipherId),
          )
        : cipher;

      if (!cipherView) {
        return;
      }

      await this.vaultPopupAutofillService.doAutofillForAccount({ userId, cipher: cipherView });
      return;
    }

    if (!CipherViewLikeUtils.isCipherListView(cipher)) {
      await this.vaultPopupAutofillService.doAutofill(cipher);
      return;
    }

    // When only the `CipherListView` is available, fetch the full cipher details
    const activeUserId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
    const cipherView = await firstValueFrom(
      this.cipherService.cipherView$(activeUserId, uuidAsString(cipher.id!) as CipherId),
    );

    if (!cipherView) {
      return;
    }

    await this.vaultPopupAutofillService.doAutofill(cipherView);
  }

  /**
   * @param userId The account whose vault holds the cipher. The reprompt and the view page are
   * then that account's. Defaults to the active account.
   */
  async viewCipher(cipher: PopupCipherViewLike, userId?: UserId) {
    // We already have a view action in progress, don't start another
    if (this.viewCipherTimeout != null) {
      return;
    }

    // Wrap in a timeout to allow for double click to launch
    this.viewCipherTimeout = window.setTimeout(
      async () => {
        try {
          if (CipherViewLikeUtils.decryptionFailure(cipher)) {
            DecryptionFailureDialogComponent.open(this.dialogService, {
              cipherIds: [cipher.id as CipherId],
            });
            return;
          }

          const repromptPassed =
            userId == null
              ? await this.passwordRepromptService.passwordRepromptCheck(cipher)
              : await this.passwordRepromptService.passwordRepromptCheck(cipher, userId);
          if (!repromptPassed) {
            return;
          }
          await this.router.navigate(["/view-cipher"], {
            queryParams: {
              cipherId: cipher.id,
              type: cipher.type,
              ...itemAccountQueryParams(userId),
            },
          });
        } finally {
          // Ensure the timeout is always cleared
          this.viewCipherTimeout = undefined;
        }
      },
      CipherViewLikeUtils.canLaunch(cipher) ? 200 : 0,
    );
  }
}
