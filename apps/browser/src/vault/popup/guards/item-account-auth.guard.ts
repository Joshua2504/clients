import { EnvironmentInjector, inject, runInInjectionContext } from "@angular/core";
import { CanActivateFn, GuardResult } from "@angular/router";
import { firstValueFrom } from "rxjs";

import { authGuard } from "@bitwarden/angular/auth/guards";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";

import { itemAccountFromParams } from "../services/vault-popup-item-account.service";

/**
 * The auth guard of the routes that take the account they operate on as the `userId` query param
 * (see `VaultPopupItemAccount`).
 *
 * A route that names an account is reachable while that account is an unlocked autofill account,
 * whatever the state of the active account: the page reads and writes the named account alone, so
 * a locked active account has no say in it. This is what lets the background open a popout for an
 * item of another account while the active account is locked.
 *
 * A route that names no account, or one that does not serve autofill, is left to {@link authGuard}
 * and so to the active account: locked, it goes to the lock screen. When the active account lets
 * the route through, the page of an account that does not serve loads nothing and leaves.
 */
export const itemAccountAuthGuard: CanActivateFn = async (route, routerState) => {
  const injector = inject(EnvironmentInjector);
  const autofillAccountsService = inject(AutofillAccountsService);

  const explicitUserId = itemAccountFromParams(route.queryParams);
  if (
    explicitUserId != null &&
    (await firstValueFrom(autofillAccountsService.isAutofillUser$(explicitUserId)))
  ) {
    return true;
  }

  // `authGuard` answers with a promise; the guard type also allows an observable.
  return await runInInjectionContext(
    injector,
    () => authGuard(route, routerState) as Promise<GuardResult>,
  );
};
