import { combineLatest, distinctUntilChanged, map, Observable, of, switchMap } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { UserId } from "@bitwarden/common/types/guid";

/**
 * The accounts that are logged in and locked, and would serve passkeys if they were unlocked:
 * the active account, and every other account that has opted in to serving autofill. The active
 * account comes first, the others follow in the order the accounts were added.
 *
 * A passkey request names these accounts to the user, who may unlock one to use or save a
 * passkey in it. Emits the current list on subscription, then only when the list changes.
 */
export function lockedPasskeyUserIds$(
  accountService: AccountService,
  authService: AuthService,
  autofillAccountsService: Pick<AutofillAccountsService, "enabled$">,
): Observable<UserId[]> {
  const lockedStates$ = accountService.accounts$.pipe(
    map((accounts) => Object.keys(accounts) as UserId[]),
    distinctUntilChanged(sameUserIds),
    switchMap((userIds) =>
      userIds.length === 0
        ? of([])
        : combineLatest(
            userIds.map((userId) =>
              combineLatest([
                authService.authStatusFor$(userId),
                autofillAccountsService.enabled$(userId),
              ]).pipe(
                map(([status, enabled]) => ({
                  userId,
                  locked: status === AuthenticationStatus.Locked,
                  enabled,
                })),
              ),
            ),
          ),
    ),
  );
  const activeUserId$ = accountService.activeAccount$.pipe(
    map((account) => account?.id),
    distinctUntilChanged(),
  );

  return combineLatest([activeUserId$, lockedStates$]).pipe(
    map(([activeUserId, states]) => {
      const locked = states.filter((state) => state.locked);
      return [
        ...locked.filter((state) => state.userId === activeUserId),
        ...locked.filter((state) => state.userId !== activeUserId && state.enabled),
      ].map((state) => state.userId);
    }),
    distinctUntilChanged(sameUserIds),
  );
}

function sameUserIds(a: UserId[], b: UserId[]): boolean {
  return a.length === b.length && a.every((userId, index) => userId === b[index]);
}
