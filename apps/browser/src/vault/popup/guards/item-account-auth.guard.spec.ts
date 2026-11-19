import { TestBed } from "@angular/core/testing";
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from "@angular/router";
import { mock } from "jest-mock-extended";
import { BehaviorSubject, of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { ForceSetPasswordReason } from "@bitwarden/common/auth/models/domain/force-set-password-reason";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { KeyConnectorService } from "@bitwarden/common/key-management/key-connector/abstractions/key-connector.service";
import { MasterPasswordServiceAbstraction } from "@bitwarden/common/key-management/master-password/abstractions/master-password.service.abstraction";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";

import { itemAccountAuthGuard } from "./item-account-auth.guard";

describe("itemAccountAuthGuard", () => {
  const activeUserId = "active-user" as UserId;
  const otherUserId = "other-user" as UserId;
  const lockTree = new UrlTree();

  const authService = mock<AuthService>();
  const messagingService = mock<MessagingService>();
  const createUrlTree = jest.fn();
  /** The accounts that serve autofill: unlocked, and active or opted in. */
  let autofillUserIds: UserId[];
  const isAutofillUser$ = jest.fn();

  const runGuard = (queryParams: Record<string, string>) =>
    TestBed.runInInjectionContext(() =>
      itemAccountAuthGuard(
        { queryParams } as unknown as ActivatedRouteSnapshot,
        { url: "/view-cipher" } as RouterStateSnapshot,
      ),
    );

  const activeAccountIs = (status: AuthenticationStatus) => {
    authService.getAuthStatus.mockResolvedValue(status);
    autofillUserIds = autofillUserIds.filter((id) => id !== activeUserId);
    if (status === AuthenticationStatus.Unlocked) {
      autofillUserIds.unshift(activeUserId);
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    autofillUserIds = [];
    createUrlTree.mockReturnValue(lockTree);
    isAutofillUser$.mockImplementation((userId: UserId) => of(autofillUserIds.includes(userId)));

    TestBed.configureTestingModule({
      providers: [
        { provide: AccountService, useValue: mockAccountServiceWith(activeUserId) },
        { provide: AuthService, useValue: authService },
        { provide: AutofillAccountsService, useValue: { isAutofillUser$ } },
        { provide: MessagingService, useValue: messagingService },
        { provide: Router, useValue: { createUrlTree } },
        {
          provide: KeyConnectorService,
          useValue: { convertAccountRequired$: new BehaviorSubject(false) },
        },
        {
          provide: MasterPasswordServiceAbstraction,
          useValue: { forceSetPasswordReason$: () => of(ForceSetPasswordReason.None) },
        },
      ],
    });
  });

  describe("a route that names no account", () => {
    it("is reachable while the active account is unlocked", async () => {
      activeAccountIs(AuthenticationStatus.Unlocked);

      expect(await runGuard({ cipherId: "cipher-1" })).toBe(true);
      // Nobody is asked whether they serve autofill: the route follows the active account.
      expect(isAutofillUser$).not.toHaveBeenCalled();
    });

    it("goes to the lock screen while the active account is locked", async () => {
      activeAccountIs(AuthenticationStatus.Locked);

      expect(await runGuard({ cipherId: "cipher-1" })).toBe(lockTree);
      expect(createUrlTree).toHaveBeenCalledWith(["lock"], {
        queryParams: { promptBiometric: true },
      });
      expect(messagingService.send).toHaveBeenCalledWith("lockedUrl", { url: "/view-cipher" });
    });

    it("is blocked while the active account is logged out", async () => {
      activeAccountIs(AuthenticationStatus.LoggedOut);

      expect(await runGuard({ cipherId: "cipher-1" })).toBe(false);
      expect(messagingService.send).toHaveBeenCalledWith("authBlocked", { url: "/view-cipher" });
    });
  });

  describe("a route that names an account", () => {
    it("is reachable for an unlocked autofill account while the active account is locked", async () => {
      activeAccountIs(AuthenticationStatus.Locked);
      autofillUserIds.push(otherUserId);

      expect(await runGuard({ cipherId: "cipher-1", userId: otherUserId })).toBe(true);
      // The active account's lock has no say: no lock screen, no unlock prompt.
      expect(authService.getAuthStatus).not.toHaveBeenCalled();
      expect(createUrlTree).not.toHaveBeenCalled();
      expect(messagingService.send).not.toHaveBeenCalled();
    });

    it("is reachable for an unlocked autofill account while the active account is unlocked", async () => {
      activeAccountIs(AuthenticationStatus.Unlocked);
      autofillUserIds.push(otherUserId);

      expect(await runGuard({ cipherId: "cipher-1", userId: otherUserId })).toBe(true);
      expect(isAutofillUser$).toHaveBeenCalledWith(otherUserId);
    });

    it("is reachable for the active account when the route names it", async () => {
      activeAccountIs(AuthenticationStatus.Unlocked);

      expect(await runGuard({ cipherId: "cipher-1", userId: activeUserId })).toBe(true);
    });

    it("goes to the lock screen for an account that does not serve while the active account is locked", async () => {
      activeAccountIs(AuthenticationStatus.Locked);

      expect(await runGuard({ cipherId: "cipher-1", userId: otherUserId })).toBe(lockTree);
      expect(createUrlTree).toHaveBeenCalledWith(["lock"], {
        queryParams: { promptBiometric: true },
      });
    });

    it("goes to the lock screen for the locked active account when the route names it", async () => {
      activeAccountIs(AuthenticationStatus.Locked);

      expect(await runGuard({ cipherId: "cipher-1", userId: activeUserId })).toBe(lockTree);
    });

    it("is blocked for an account that does not serve while the active account is logged out", async () => {
      activeAccountIs(AuthenticationStatus.LoggedOut);

      expect(await runGuard({ cipherId: "cipher-1", userId: otherUserId })).toBe(false);
    });

    it("leaves an account that does not serve to its page while the active account is unlocked", async () => {
      // The page of such an account loads nothing and leaves; see `VaultPopupItemAccount`.
      activeAccountIs(AuthenticationStatus.Unlocked);

      expect(await runGuard({ cipherId: "cipher-1", userId: otherUserId })).toBe(true);
      expect(isAutofillUser$).toHaveBeenCalledWith(otherUserId);
    });
  });
});
