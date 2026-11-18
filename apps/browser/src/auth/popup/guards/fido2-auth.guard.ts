import { inject } from "@angular/core";
import {
  ActivatedRouteSnapshot,
  CanActivateFn,
  Router,
  RouterStateSnapshot,
} from "@angular/router";
import { firstValueFrom } from "rxjs";

import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";

import { BrowserRouterService } from "../../../platform/popup/services/browser-router.service";

/**
 * This guard verifies the user's authentication status.
 * If "Locked", it saves the intended route in memory and redirects to the lock screen. Otherwise, the intended route is allowed.
 *
 * A locked active account does not redirect while another account serves passkeys: the request
 * is then answered from that account's vault, and the popout is opened to pick or confirm in it.
 */
export const fido2AuthGuard: CanActivateFn = async (
  route: ActivatedRouteSnapshot,
  state: RouterStateSnapshot,
) => {
  const routerService = inject(BrowserRouterService);
  const authService = inject(AuthService);
  const router = inject(Router);
  const autofillAccountsService = inject(AutofillAccountsService);

  const authStatus = await authService.getAuthStatus();

  if (
    authStatus === AuthenticationStatus.Locked &&
    (await firstValueFrom(autofillAccountsService.autofillUserIds$)).length === 0
  ) {
    // Appending fromLock=true to the query params to indicate that the user is being redirected from the lock screen, this is used for user verification.
    // TODO: Revert to use previousUrl once user verification for passkeys is approved for production.
    // PM-4577 - https://github.com/bitwarden/clients/pull/8746
    // const previousUrl = `${state.url}&fromLock=true`;
    routerService.setPreviousUrl(state.url);
    return router.createUrlTree(["/lock"], { queryParams: route.queryParams });
  }

  return true;
};
