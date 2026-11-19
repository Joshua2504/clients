import { inject } from "@angular/core";
import {
  ActivatedRouteSnapshot,
  CanActivateFn,
  Router,
  RouterStateSnapshot,
} from "@angular/router";
import { combineLatest, map, Observable, of, switchMap } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { SecurityTaskType, TaskService } from "@bitwarden/common/vault/tasks";
import { filterOutNullish } from "@bitwarden/common/vault/utils/observable-utilities";
import { ToastService } from "@bitwarden/components";

import { itemAccountFromParams } from "../services/vault-popup-item-account.service";

import { itemAccountAuthGuard } from "./item-account-auth.guard";

/**
 * The account whose at-risk passwords the route shows: the one it names with `userId` while that
 * account serves autofill, else the active account. Null when the named account does not serve:
 * the page then loads nothing and leaves, and its vault is not read here.
 */
function atRiskPasswordsAccount$(route: ActivatedRouteSnapshot): Observable<UserId | null> {
  const accountService = inject(AccountService);
  const autofillAccountsService = inject(AutofillAccountsService);

  const explicitUserId = itemAccountFromParams(route.queryParams);
  if (explicitUserId == null) {
    return accountService.activeAccount$.pipe(
      filterOutNullish(),
      map((account) => account.id),
    );
  }

  return autofillAccountsService
    .isAutofillUser$(explicitUserId)
    .pipe(map((serves) => (serves ? explicitUserId : null)));
}

/**
 * Wrapper around the main auth guard to redirect to login if not authenticated.
 * This is necessary because the main auth guard returns false when not authenticated,
 * which in a browser context may result in a blank extension page rather than a redirect.
 */
export const atRiskPasswordAuthGuard: CanActivateFn = async (
  route: ActivatedRouteSnapshot,
  routerState: RouterStateSnapshot,
) => {
  const router = inject(Router);

  // With a `userId` the page shows that account's tasks, whatever the active account's state.
  const authGuardResponse = await itemAccountAuthGuard(route, routerState);
  if (authGuardResponse === true) {
    return authGuardResponse;
  }
  return router.createUrlTree(["/login"]);
};

export const canAccessAtRiskPasswords: CanActivateFn = (route) => {
  const taskService = inject(TaskService);
  const toastService = inject(ToastService);
  const i18nService = inject(I18nService);
  const router = inject(Router);

  return atRiskPasswordsAccount$(route).pipe(
    switchMap((userId) => (userId == null ? of(true) : taskService.tasksEnabled$(userId))),
    map((tasksEnabled) => {
      if (!tasksEnabled) {
        toastService.showToast({
          variant: "error",
          title: "",
          message: i18nService.t("noPermissionsViewPage"),
        });

        return router.createUrlTree(["/tabs/vault"]);
      }
      return true;
    }),
  );
};

export const hasAtRiskPasswords: CanActivateFn = (route) => {
  const taskService = inject(TaskService);
  const cipherService = inject(CipherService);
  const router = inject(Router);

  return atRiskPasswordsAccount$(route).pipe(
    switchMap((userId) => {
      if (userId == null) {
        return of(true as const);
      }

      return combineLatest([
        taskService.pendingTasks$(userId),
        cipherService.cipherViews$(userId).pipe(
          filterOutNullish(),
          map((ciphers) => Object.fromEntries(ciphers.map((c) => [c.id, c]))),
        ),
      ]).pipe(
        map(([tasks, ciphers]) => {
          const hasAtRiskCiphers = tasks.some(
            (t) =>
              t.type === SecurityTaskType.UpdateAtRiskCredential &&
              t.cipherId != null &&
              ciphers[t.cipherId] != null &&
              !ciphers[t.cipherId].isDeleted,
          );

          if (!hasAtRiskCiphers) {
            return router.createUrlTree(["/tabs/vault"]);
          }
          return true;
        }),
      );
    }),
  );
};
