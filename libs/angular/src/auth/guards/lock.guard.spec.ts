import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { RouterTestingModule } from "@angular/router/testing";
import { MockProxy, mock } from "jest-mock-extended";
import { BehaviorSubject, of } from "rxjs";

import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { ClientType } from "@bitwarden/common/enums";
import { DeviceTrustServiceAbstraction } from "@bitwarden/common/key-management/device-trust/abstractions/device-trust.service.abstraction";
import { KeyConnectorService } from "@bitwarden/common/key-management/key-connector/abstractions/key-connector.service";
import { KeyConnectorDomainConfirmation } from "@bitwarden/common/key-management/key-connector/models/key-connector-domain-confirmation";
import { VaultTimeoutSettingsService } from "@bitwarden/common/key-management/vault-timeout";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { mockAccountInfoWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { KeyService } from "@bitwarden/key-management";

import { EmptyComponent } from "../../platform/guard/feature-flag.guard.spec";

import { lockGuard } from "./lock.guard";

interface SetupParams {
  authStatus: AuthenticationStatus;
  canLock?: boolean;
  clientType?: ClientType;
  everHadUserKey?: boolean;
  supportsDeviceTrust?: boolean;
  hasMasterPassword?: boolean;
}

describe("lockGuard", () => {
  const keyConnectorService = mock<KeyConnectorService>();

  const setup = (setupParams: SetupParams) => {
    const authService: MockProxy<AuthService> = mock<AuthService>();
    authService.authStatusFor$.mockReturnValue(of(setupParams.authStatus));

    const vaultTimeoutSettingsService: MockProxy<VaultTimeoutSettingsService> =
      mock<VaultTimeoutSettingsService>();
    vaultTimeoutSettingsService.canLock.mockResolvedValue(setupParams.canLock ?? true);

    const keyService: MockProxy<KeyService> = mock<KeyService>();
    keyService.everHadUserKey$.mockReturnValue(of(setupParams.everHadUserKey ?? true));

    const platformUtilService: MockProxy<PlatformUtilsService> = mock<PlatformUtilsService>();
    platformUtilService.getClientType.mockReturnValue(setupParams.clientType ?? ClientType.Web);

    const messagingService: MockProxy<MessagingService> = mock<MessagingService>();

    const deviceTrustService: MockProxy<DeviceTrustServiceAbstraction> =
      mock<DeviceTrustServiceAbstraction>();
    deviceTrustService.supportsDeviceTrust$ = of(setupParams.supportsDeviceTrust ?? false);

    const userVerificationService: MockProxy<UserVerificationService> =
      mock<UserVerificationService>();
    userVerificationService.hasMasterPassword.mockResolvedValue(
      setupParams.hasMasterPassword ?? true,
    );

    keyConnectorService.requiresDomainConfirmation$.mockReturnValue(of(null));

    const accountService: MockProxy<AccountService> = mock<AccountService>();
    const activeAccountSubject = new BehaviorSubject<Account | null>(null);
    accountService.activeAccount$ = activeAccountSubject;
    activeAccountSubject.next({
      id: "test-id" as UserId,
      ...mockAccountInfoWith({
        name: "Test User 1",
        email: "test@email.com",
      }),
    });

    const testBed = TestBed.configureTestingModule({
      imports: [
        RouterTestingModule.withRoutes([
          { path: "", component: EmptyComponent },
          { path: "lock", component: EmptyComponent, canActivate: [lockGuard()] },
          { path: "non-lock-route", component: EmptyComponent },
          { path: "confirm-key-connector-domain", component: EmptyComponent },
        ]),
      ],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: MessagingService, useValue: messagingService },
        { provide: AccountService, useValue: accountService },
        { provide: VaultTimeoutSettingsService, useValue: vaultTimeoutSettingsService },
        { provide: KeyService, useValue: keyService },
        { provide: PlatformUtilsService, useValue: platformUtilService },
        { provide: DeviceTrustServiceAbstraction, useValue: deviceTrustService },
        { provide: UserVerificationService, useValue: userVerificationService },
        { provide: KeyConnectorService, useValue: keyConnectorService },
      ],
    });

    return {
      router: testBed.inject(Router),
      messagingService,
      authService,
      accountService,
      vaultTimeoutSettingsService,
      keyService,
      deviceTrustService,
      userVerificationService,
    };
  };

  it("should be created", () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.Locked,
    });
    expect(router).toBeTruthy();
  });

  it("should redirect to the root route when the user is Unlocked", async () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.Unlocked,
    });

    await router.navigate(["lock"]);
    expect(router.url).toBe("/");
  });

  it("should redirect to the root route when the user is LoggedOut", async () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.LoggedOut,
    });

    await router.navigate(["lock"]);
    expect(router.url).toBe("/");
  });

  it("should allow navigation to the lock route when the user is Locked and they can lock", async () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.Locked,
      canLock: true,
    });

    await router.navigate(["lock"]);
    expect(router.url).toBe("/lock");
  });

  it("should allow navigation to the lock route when the user is locked, they can lock, and device trust is not supported", async () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.Locked,
      canLock: true,
      supportsDeviceTrust: false,
    });

    await router.navigate(["lock"]);
    expect(router.url).toBe("/lock");
  });

  it("should not allow navigation to the lock route when canLock is false", async () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.Locked,
      canLock: false,
    });

    await router.navigate(["lock"]);
    expect(router.url).toBe("/");
  });

  it("should allow navigation to the lock route when device trust is supported, the user has a MP, and the user is coming from the login-initiated page", async () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.Locked,
      canLock: true,
      clientType: ClientType.Web,
      everHadUserKey: false,
      supportsDeviceTrust: true,
      hasMasterPassword: true,
    });

    await router.navigate(["lock"], { queryParams: { from: "login-initiated" } });
    expect(router.url).toBe("/lock?from=login-initiated");
  });

  it("should allow navigation to the lock route when TDE is disabled, the user doesn't have a MP, and the user has had a user key", async () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.Locked,
      canLock: true,
      supportsDeviceTrust: false,
      hasMasterPassword: false,
      everHadUserKey: true,
    });

    await router.navigate(["lock"]);
    expect(router.url).toBe("/lock");
  });

  it("should not allow navigation to the lock route when device trust is supported and the user has not ever had a user key", async () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.Locked,
      canLock: true,
      clientType: ClientType.Web,
      everHadUserKey: false,
      supportsDeviceTrust: true,
      hasMasterPassword: false,
    });

    await router.navigate(["lock"]);
    expect(router.url).toBe("/");
  });

  it("should redirect to the confirm-key-connector-domain route when the auth status is locked, can't lock and requires key connector domain confirmation", async () => {
    const { router } = setup({
      authStatus: AuthenticationStatus.Locked,
      canLock: false,
    });
    keyConnectorService.requiresDomainConfirmation$.mockReturnValue(
      of({
        keyConnectorUrl: "https://example.com",
      } as KeyConnectorDomainConfirmation),
    );

    await router.navigate(["lock"]);
    expect(router.url).toBe("/confirm-key-connector-domain");
  });

  describe("with a userId query param", () => {
    const activeUserId = "test-id" as UserId;
    const otherUserId = "other-id" as UserId;

    /** The active account has `authStatus`; the other account is known and has `otherStatus`. */
    const setupAccounts = (
      authStatus: AuthenticationStatus,
      otherStatus: AuthenticationStatus,
      setupParams: Omit<SetupParams, "authStatus"> = {},
    ) => {
      const mocks = setup({ ...setupParams, authStatus });
      mocks.accountService.accounts$ = of({
        [activeUserId]: mockAccountInfoWith({ email: "test@email.com" }),
        [otherUserId]: mockAccountInfoWith({ email: "other@email.com" }),
      });
      mocks.authService.authStatusFor$.mockImplementation((userId) =>
        of(userId === otherUserId ? otherStatus : authStatus),
      );
      mocks.deviceTrustService.supportsDeviceTrustByUserId$.mockReturnValue(
        of(setupParams.supportsDeviceTrust ?? false),
      );
      return mocks;
    };

    it("allows the lock route for a locked account that is not the active one", async () => {
      const { router, vaultTimeoutSettingsService, keyService } = setupAccounts(
        AuthenticationStatus.Unlocked,
        AuthenticationStatus.Locked,
      );

      await router.navigate(["lock"], { queryParams: { userId: otherUserId } });

      expect(router.url).toBe(`/lock?userId=${otherUserId}`);
      expect(vaultTimeoutSettingsService.canLock).toHaveBeenCalledWith(otherUserId);
      expect(keyService.everHadUserKey$).toHaveBeenCalledWith(otherUserId);
      expect(keyConnectorService.requiresDomainConfirmation$).toHaveBeenCalledWith(otherUserId);
    });

    it.each([AuthenticationStatus.Unlocked, AuthenticationStatus.LoggedOut])(
      "redirects to the root route when that account has status %s, whatever the active account's",
      async (otherStatus) => {
        const { router } = setupAccounts(AuthenticationStatus.Locked, otherStatus);

        await router.navigate(["lock"], { queryParams: { userId: otherUserId } });

        expect(router.url).toBe("/");
      },
    );

    it("redirects to the root route for an account the client does not hold", async () => {
      const { router, authService } = setupAccounts(
        AuthenticationStatus.Locked,
        AuthenticationStatus.Locked,
      );

      await router.navigate(["lock"], { queryParams: { userId: "unknown-id" } });

      expect(router.url).toBe("/");
      expect(authService.authStatusFor$).not.toHaveBeenCalled();
    });

    it("rejects the navigation when that account cannot lock", async () => {
      const { router, vaultTimeoutSettingsService } = setupAccounts(
        AuthenticationStatus.Unlocked,
        AuthenticationStatus.Locked,
      );
      vaultTimeoutSettingsService.canLock.mockImplementation(
        async (userId) => userId !== otherUserId,
      );

      await router.navigate(["lock"], { queryParams: { userId: otherUserId } });

      expect(router.url).toBe("/");
    });

    it("rejects the navigation instead of opening the active account's key connector confirmation", async () => {
      const { router } = setupAccounts(AuthenticationStatus.Unlocked, AuthenticationStatus.Locked);
      keyConnectorService.requiresDomainConfirmation$.mockReturnValue(
        of({ keyConnectorUrl: "https://example.com" } as KeyConnectorDomainConfirmation),
      );

      await router.navigate(["lock"], { queryParams: { userId: otherUserId } });

      expect(router.url).toBe("/");
    });

    it("applies the TDE rule to that account", async () => {
      const { router, deviceTrustService, keyService } = setupAccounts(
        AuthenticationStatus.Unlocked,
        AuthenticationStatus.Locked,
        { supportsDeviceTrust: false },
      );
      deviceTrustService.supportsDeviceTrustByUserId$.mockReturnValue(of(true));
      keyService.everHadUserKey$.mockReturnValue(of(false));

      await router.navigate(["lock"], { queryParams: { userId: otherUserId } });

      expect(router.url).toBe("/");
      expect(deviceTrustService.supportsDeviceTrustByUserId$).toHaveBeenCalledWith(otherUserId);
    });

    it("leaves the active account's lock route as it is", async () => {
      const { router, vaultTimeoutSettingsService } = setupAccounts(
        AuthenticationStatus.Locked,
        AuthenticationStatus.Unlocked,
      );

      await router.navigate(["lock"]);

      expect(router.url).toBe("/lock");
      expect(vaultTimeoutSettingsService.canLock).toHaveBeenCalledWith(activeUserId);
    });
  });
});
