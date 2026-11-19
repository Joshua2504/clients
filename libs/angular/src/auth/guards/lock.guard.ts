import { inject } from "@angular/core";
import {
  ActivatedRouteSnapshot,
  CanActivateFn,
  Router,
  RouterStateSnapshot,
} from "@angular/router";
import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { DeviceTrustServiceAbstraction } from "@bitwarden/common/key-management/device-trust/abstractions/device-trust.service.abstraction";
import { KeyConnectorService } from "@bitwarden/common/key-management/key-connector/abstractions/key-connector.service";
import { VaultTimeoutSettingsService } from "@bitwarden/common/key-management/vault-timeout";
import { UserId } from "@bitwarden/common/types/guid";
import { KeyService } from "@bitwarden/key-management";

/**
 * Query param of the lock route that names the account to unlock. Without it the lock route is
 * for the active account. With it, the lock screen unlocks that account and leaves the active
 * account as it is.
 */
export const LOCK_USER_ID_QUERY_PARAM = "userId";

/**
 * Only allow access to this route if the vault is locked.
 * If TDE is enabled then the user must also have had a user key at some point.
 * Otherwise reject navigation.
 *
 * The vault is the active account's, or that of the account named by the
 * {@link LOCK_USER_ID_QUERY_PARAM} query param. An account that is unknown, logged out or
 * unlocked is redirected to the root route.
 *
 * TODO: This should return Observable<boolean | UrlTree> once we can remove all the promises
 */
export function lockGuard(): CanActivateFn {
  return async (
    activatedRouteSnapshot: ActivatedRouteSnapshot,
    routerStateSnapshot: RouterStateSnapshot,
  ) => {
    const authService = inject(AuthService);
    const keyService = inject(KeyService);
    const deviceTrustService = inject(DeviceTrustServiceAbstraction);
    const router = inject(Router);
    const userVerificationService = inject(UserVerificationService);
    const vaultTimeoutSettingsService = inject(VaultTimeoutSettingsService);
    const accountService = inject(AccountService);
    const keyConnectorService = inject(KeyConnectorService);

    const activeUser = await firstValueFrom(accountService.activeAccount$);
    const scopedUserId = activatedRouteSnapshot.queryParamMap.get(
      LOCK_USER_ID_QUERY_PARAM,
    ) as UserId | null;

    let userId: UserId;
    if (scopedUserId != null) {
      // An account this client does not hold cannot be unlocked
      const accounts = await firstValueFrom(accountService.accounts$);
      if (accounts[scopedUserId] == null) {
        return router.createUrlTree(["/"]);
      }
      userId = scopedUserId;
    } else {
      // If no active user, redirect to root:
      // scenario context: user logs out on lock screen and app will reload lock comp without active user
      if (!activeUser) {
        return router.createUrlTree(["/"]);
      }
      userId = activeUser.id;
    }

    const authStatus = await firstValueFrom(authService.authStatusFor$(userId));
    if (authStatus !== AuthenticationStatus.Locked) {
      return router.createUrlTree(["/"]);
    }

    if ((await firstValueFrom(keyConnectorService.requiresDomainConfirmation$(userId))) != null) {
      // The confirmation page is for the active account
      if (userId !== activeUser?.id) {
        return false;
      }
      return router.createUrlTree(["confirm-key-connector-domain"]);
    }

    // if user can't lock, they can't access the lock screen
    const canLock = await vaultTimeoutSettingsService.canLock(userId);
    if (!canLock) {
      return false;
    }

    // User is authN and in locked state.

    const tdeEnabled = await firstValueFrom(
      scopedUserId != null
        ? deviceTrustService.supportsDeviceTrustByUserId$(scopedUserId)
        : deviceTrustService.supportsDeviceTrust$,
    );

    // Create special exception which allows users to go from the login-initiated page to the lock page for the approve w/ MP flow
    // The MP check is necessary to prevent direct manual navigation from other locked state pages for users who don't have a MP
    if (
      activatedRouteSnapshot.queryParams["from"] === "login-initiated" &&
      tdeEnabled &&
      (scopedUserId != null
        ? await userVerificationService.hasMasterPassword(scopedUserId)
        : await userVerificationService.hasMasterPassword())
    ) {
      return true;
    }

    // If authN user with TDE directly navigates to lock, reject that navigation
    const everHadUserKey = await firstValueFrom(keyService.everHadUserKey$(userId));
    if (tdeEnabled && !everHadUserKey) {
      return false;
    }

    return true;
  };
}
