import { DestroyRef, inject, Injectable, Signal } from "@angular/core";
import { takeUntilDestroyed, toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Params, Router } from "@angular/router";
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  filter,
  firstValueFrom,
  map,
  Observable,
  of,
  switchMap,
} from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getOptionalUserId, getUserId } from "@bitwarden/common/auth/services/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { UserId } from "@bitwarden/common/types/guid";

import BrowserPopupUtils from "../../../platform/browser/browser-popup-utils";
import { PopupRouterCacheService } from "../../../platform/popup/view-cache/popup-router-cache.service";
import { PopupCloseWarningService } from "../../../popup/services/popup-close-warning.service";

/**
 * The query param that names the account a vault item page operates on. Without it the page
 * operates on the active account.
 */
export const ITEM_ACCOUNT_QUERY_PARAM = "userId";

/** Where a page goes when its account stops serving and it is not in a single action popout. */
const ROUTE_AFTER_LEAVING = "/tabs/vault";

/** The account named by the query params of a vault item route, if any. */
export function itemAccountFromParams(params: Params): UserId | undefined {
  const userId = params[ITEM_ACCOUNT_QUERY_PARAM];
  return typeof userId === "string" && userId !== "" ? (userId as UserId) : undefined;
}

/**
 * The query params that carry `userId` to the next vault item page. Empty without an account, so
 * the next page operates on the active account.
 */
export function itemAccountQueryParams(userId: UserId | undefined): { userId?: UserId } {
  return userId == null ? {} : { [ITEM_ACCOUNT_QUERY_PARAM]: userId };
}

/**
 * The account a vault item page operates on.
 *
 * A page is opened for an account other than the active one with the `userId` query param. The
 * page then loads, decrypts, checks, saves and logs for that account alone, and it must be an
 * unlocked autofill account (`AutofillAccountsService.isAutofillUser$`). Without the param the
 * page operates on the active account, as it always has.
 *
 * Provide it on the page component, so it lives and ends with the page:
 *
 * ```ts
 * @Component({ providers: [VaultPopupItemAccount] })
 * ```
 *
 * When the named account stops being an autofill account, because it locked, logged out or
 * withdrew its opt-in, the page is left: a single action popout closes and any other page goes
 * to the vault. It never falls back to the active account. While the named account is the active
 * one, its lock is left to the popup's own lock handling.
 */
@Injectable()
export class VaultPopupItemAccount {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly accountService = inject(AccountService);
  private readonly autofillAccountsService = inject(AutofillAccountsService);
  private readonly popupRouterCacheService = inject(PopupRouterCacheService);
  private readonly popupCloseWarningService = inject(PopupCloseWarningService);
  private readonly destroyRef = inject(DestroyRef);

  private left = false;

  /** The account the route named last. The router emits its params on subscription. */
  private readonly explicitUserIdSubject = new BehaviorSubject<UserId | undefined>(undefined);

  /** The account the route names, undefined when the page follows the active account. */
  readonly explicitUserId$: Observable<UserId | undefined> =
    this.explicitUserIdSubject.pipe(distinctUntilChanged());

  /** {@link explicitUserId$} as a signal, for templates and for inputs of the vault components. */
  readonly explicitUserId: Signal<UserId | undefined> = toSignal(this.explicitUserId$, {
    requireSync: true,
  });

  /**
   * The account the page operates on: the named account while it is an autofill account, else
   * the active account when none is named. It does not emit while the named account is not an
   * autofill account; the page is then being left.
   */
  readonly userId$: Observable<UserId> = this.explicitUserId$.pipe(
    switchMap((explicitUserId) =>
      explicitUserId == null
        ? this.accountService.activeAccount$.pipe(getUserId)
        : this.autofillAccountsService.isAutofillUser$(explicitUserId).pipe(
            filter((serves) => serves),
            map(() => explicitUserId),
          ),
    ),
  );

  /**
   * The email of the named account while it is not the active account, for the header hint that
   * tells the user whose vault the page shows. Undefined otherwise.
   */
  readonly accountHint: Signal<string | undefined> = toSignal(
    this.explicitUserId$.pipe(
      switchMap((explicitUserId) =>
        explicitUserId == null
          ? of(undefined)
          : combineLatest([this.accountService.activeAccount$, this.accountService.accounts$]).pipe(
              map(([activeAccount, accounts]) =>
                activeAccount?.id === explicitUserId ? undefined : accounts[explicitUserId]?.email,
              ),
            ),
      ),
    ),
  );

  constructor() {
    this.route.queryParams
      .pipe(map(itemAccountFromParams), takeUntilDestroyed(this.destroyRef))
      .subscribe((explicitUserId) => this.explicitUserIdSubject.next(explicitUserId));

    this.explicitUserId$
      .pipe(
        switchMap((explicitUserId) =>
          explicitUserId == null
            ? of(true)
            : this.autofillAccountsService
                .isAutofillUser$(explicitUserId)
                .pipe(
                  switchMap((serves) => (serves ? of(true) : this.handledByLock$(explicitUserId))),
                ),
        ),
        filter((stay) => !stay),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => void this.leave());
  }

  /**
   * {@link userId$} once, for a page that is about to load or act.
   *
   * @returns Null when the named account is not an autofill account. The page is then being left
   * and must not load or do anything; it must not use the active account instead.
   */
  async userId(): Promise<UserId | null> {
    const explicitUserId = this.explicitUserId();
    if (explicitUserId == null) {
      return await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
    }

    if (await firstValueFrom(this.autofillAccountsService.isAutofillUser$(explicitUserId))) {
      return explicitUserId;
    }

    return null;
  }

  /** {@link itemAccountQueryParams} for this page's account, to open the next page with. */
  queryParams(): { userId?: UserId } {
    return itemAccountQueryParams(this.explicitUserId());
  }

  /**
   * True when the lock of `userId` belongs to the popup's own lock handling, which is while it is
   * the active account: that handling routes the popup to the lock screen.
   */
  private handledByLock$(userId: UserId): Observable<boolean> {
    return this.accountService.activeAccount$.pipe(
      getOptionalUserId,
      map((activeUserId) => activeUserId === userId),
    );
  }

  /** Leaves the page because its account no longer serves. */
  private async leave(): Promise<void> {
    if (this.left) {
      return;
    }
    this.left = true;

    if (BrowserPopupUtils.inPopout(window) && isSingleActionPopout(window)) {
      this.popupCloseWarningService.disable();
      await BrowserPopupUtils.closeCurrentPopupOrPopout(window);
      return;
    }

    await this.popupRouterCacheService.setHistory([]);
    await this.router.navigate([ROUTE_AFTER_LEAVING]);
  }
}

/** A popout that was opened for one action, such as viewing or editing one item. */
function isSingleActionPopout(win: Window): boolean {
  return win.location.href.includes("singleActionPopout=");
}
