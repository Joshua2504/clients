import { ComponentFixture, TestBed, fakeAsync, tick } from "@angular/core/testing";
import { FormBuilder, ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { mock } from "jest-mock-extended";
import { BehaviorSubject, EMPTY, Subject, firstValueFrom, of } from "rxjs";
import { ZXCVBNResult } from "zxcvbn";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { InternalPolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { MasterPasswordPolicyOptions } from "@bitwarden/common/admin-console/models/domain/master-password-policy-options";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { LogoutService } from "@bitwarden/common/auth/logout";
import { ForceSetPasswordReason } from "@bitwarden/common/auth/models/domain/force-set-password-reason";
import { ClientType, DeviceType } from "@bitwarden/common/enums";
import { DeviceTrustServiceAbstraction } from "@bitwarden/common/key-management/device-trust/abstractions/device-trust.service.abstraction";
import { EncryptedMigrator } from "@bitwarden/common/key-management/encrypted-migrator/encrypted-migrator.abstraction";
import { InternalMasterPasswordServiceAbstraction } from "@bitwarden/common/key-management/master-password/abstractions/master-password.service.abstraction";
import { PinServiceAbstraction } from "@bitwarden/common/key-management/pin/pin.service.abstraction";
import { BroadcasterService } from "@bitwarden/common/platform/abstractions/broadcaster.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { mockAccountInfoWith, mockAccountServiceWith } from "@bitwarden/common/spec";
import { PasswordStrengthServiceAbstraction } from "@bitwarden/common/tools/password-strength";
import { UserId } from "@bitwarden/common/types/guid";
import { UserKey } from "@bitwarden/common/types/key";
import {
  AnonLayoutWrapperDataService,
  AsyncActionsModule,
  ButtonModule,
  DialogService,
  FormFieldModule,
  IconButtonModule,
  ToastService,
} from "@bitwarden/components";
import {
  BiometricsService,
  BiometricsStatus,
  BiometricStateService,
  KeyService,
  UserAsymmetricKeysRegenerationService,
} from "@bitwarden/key-management";
// eslint-disable-next-line no-restricted-imports
import { SymmetricCryptoKey } from "@bitwarden/legacy-crypto";
import { UnlockEvent, UnlockMethod, UnlockService } from "@bitwarden/unlock";

import {
  LockComponentService,
  UnlockOption,
  UnlockOptionValue,
  UnlockOptions,
} from "../services/lock-component.service";
import { WebAuthnPrfUnlockService } from "../services/webauthn-prf-unlock.service";

import { LockComponent } from "./lock.component";

describe("LockComponent", () => {
  let component: LockComponent;
  let fixture: ComponentFixture<LockComponent>;

  const userId = "test-user-id" as UserId;

  // Mock services
  const mockAccountService = mockAccountServiceWith(userId);
  const mockUserVerificationService = mock<UserVerificationService>();
  const mockKeyService = mock<KeyService>();
  const mockPlatformUtilsService = mock<PlatformUtilsService>();
  const mockRouter = mock<Router>();
  const mockDialogService = mock<DialogService>();
  const mockMessagingService = mock<MessagingService>();
  const mockBiometricStateService = mock<BiometricStateService>();
  const mockI18nService = mock<I18nService>();
  const mockMasterPasswordService = mock<InternalMasterPasswordServiceAbstraction>();
  const mockLogService = mock<LogService>();
  const mockDeviceTrustService = mock<DeviceTrustServiceAbstraction>();
  const mockSyncService = mock<SyncService>();
  const mockPolicyService = mock<InternalPolicyService>();
  const mockPasswordStrengthService = mock<PasswordStrengthServiceAbstraction>();
  const mockToastService = mock<ToastService>();
  const mockUserAsymmetricKeysRegenerationService = mock<UserAsymmetricKeysRegenerationService>();
  const mockBiometricService = mock<BiometricsService>();
  const mockLogoutService = mock<LogoutService>();
  const mockLockComponentService = mock<LockComponentService>();
  const mockAnonLayoutWrapperDataService = mock<AnonLayoutWrapperDataService>();
  const mockBroadcasterService = mock<BroadcasterService>();
  const mockUnlockService = mock<UnlockService>();
  const mockWebAuthnPrfUnlockService = mock<WebAuthnPrfUnlockService>();
  const mockEncryptedMigrator = mock<EncryptedMigrator>();
  const mockPinService = mock<PinServiceAbstraction>();
  const mockAuthService = mock<AuthService>();
  const mockActivatedRoute = {
    snapshot: {
      paramMap: {
        get: jest.fn().mockReturnValue(null), // return null for 'disable-redirect' param
      },
      queryParamMap: {
        get: jest.fn().mockReturnValue(null), // return null for the 'userId' param
      },
    },
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    // Setup default mock returns
    mockPlatformUtilsService.getClientType.mockReturnValue(ClientType.Web);
    mockKeyService.hasUserKey.mockResolvedValue(false);
    mockI18nService.t.mockImplementation((key: string) => key);

    // Mock observables that cause timeouts
    mockBiometricStateService.promptAutomatically$.mockReturnValue(of(false));
    mockBiometricStateService.promptCancelled$.mockReturnValue(of(false));
    mockBiometricStateService.resetUserPromptCancelled.mockResolvedValue();
    mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(of(null));
    mockUnlockService.unlocked$ = EMPTY;
    mockSyncService.fullSync.mockResolvedValue(true);
    mockEncryptedMigrator.runMigrations.mockResolvedValue();
    mockDeviceTrustService.trustDeviceIfRequired.mockResolvedValue();
    mockUserAsymmetricKeysRegenerationService.regenerateIfNeeded.mockResolvedValue();
    mockAnonLayoutWrapperDataService.setAnonLayoutWrapperData.mockImplementation(() => {});

    await TestBed.configureTestingModule({
      imports: [
        LockComponent,
        ReactiveFormsModule,
        JslibModule,
        ButtonModule,
        FormFieldModule,
        AsyncActionsModule,
        IconButtonModule,
      ],
      providers: [
        FormBuilder,
        { provide: AccountService, useValue: mockAccountService },
        { provide: UserVerificationService, useValue: mockUserVerificationService },
        { provide: KeyService, useValue: mockKeyService },
        { provide: PlatformUtilsService, useValue: mockPlatformUtilsService },
        { provide: Router, useValue: mockRouter },
        { provide: DialogService, useValue: mockDialogService },
        { provide: MessagingService, useValue: mockMessagingService },
        { provide: BiometricStateService, useValue: mockBiometricStateService },
        { provide: I18nService, useValue: mockI18nService },
        { provide: InternalMasterPasswordServiceAbstraction, useValue: mockMasterPasswordService },
        { provide: LogService, useValue: mockLogService },
        { provide: DeviceTrustServiceAbstraction, useValue: mockDeviceTrustService },
        { provide: SyncService, useValue: mockSyncService },
        { provide: InternalPolicyService, useValue: mockPolicyService },
        { provide: PasswordStrengthServiceAbstraction, useValue: mockPasswordStrengthService },
        { provide: ToastService, useValue: mockToastService },
        {
          provide: UserAsymmetricKeysRegenerationService,
          useValue: mockUserAsymmetricKeysRegenerationService,
        },
        { provide: BiometricsService, useValue: mockBiometricService },
        { provide: LogoutService, useValue: mockLogoutService },
        { provide: LockComponentService, useValue: mockLockComponentService },
        { provide: AnonLayoutWrapperDataService, useValue: mockAnonLayoutWrapperDataService },
        { provide: BroadcasterService, useValue: mockBroadcasterService },
        { provide: UnlockService, useValue: mockUnlockService },
        { provide: WebAuthnPrfUnlockService, useValue: mockWebAuthnPrfUnlockService },
        { provide: ActivatedRoute, useValue: mockActivatedRoute },
        { provide: EncryptedMigrator, useValue: mockEncryptedMigrator },
        { provide: PinServiceAbstraction, useValue: mockPinService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    })
      .overrideProvider(DialogService, { useValue: mockDialogService })
      .compileComponents();

    fixture = TestBed.createComponent(LockComponent);
    component = fixture.componentInstance;
  });

  describe("PIN length", () => {
    const form = () => ({ requestSubmit: jest.fn() }) as unknown as HTMLFormElement;

    beforeEach(() => {
      component.activeAccount = { id: userId } as any;
      mockPinService.getPinLength.mockResolvedValue(4);
    });

    it("tries the PIN once it has the stored PIN length", async () => {
      const pinForm = form();

      await component["tryPinWhenComplete"]("1234", pinForm);

      expect(pinForm.requestSubmit).toHaveBeenCalled();
    });

    it("waits while the PIN is shorter or longer than the stored length", async () => {
      const pinForm = form();

      await component["tryPinWhenComplete"]("123", pinForm);
      await component["tryPinWhenComplete"]("12345", pinForm);

      expect(pinForm.requestSubmit).not.toHaveBeenCalled();
    });

    it("waits for the Unlock button when no length is stored", async () => {
      mockPinService.getPinLength.mockResolvedValue(undefined);
      const pinForm = form();

      await component["tryPinWhenComplete"]("1234", pinForm);

      expect(pinForm.requestSubmit).not.toHaveBeenCalled();
    });

    it("tries a PIN once when it is submitted again while unlocking, e.g. by Enter", async () => {
      component.formGroup = new FormBuilder().group({ pin: ["1234"] });
      let finishUnlock!: () => void;
      mockUnlockService.unlockWithPin.mockReturnValue(
        new Promise<void>((resolve) => (finishUnlock = resolve)),
      );

      const first = component["unlockViaPin"]();
      const second = component["unlockViaPin"]();
      finishUnlock();
      await Promise.all([first, second]);

      expect(mockUnlockService.unlockWithPin).toHaveBeenCalledTimes(1);
    });
  });

  describe("unlocked$", () => {
    const unlockOptions = {
      masterPassword: { enabled: true },
      pin: { enabled: false },
      biometrics: { enabled: false, biometricsStatus: BiometricsStatus.NotEnabledLocally },
      prf: { enabled: false },
    };
    let unlocked: Subject<UnlockEvent>;
    let continueAfterSettingUserKey: jest.SpyInstance;

    beforeEach(async () => {
      unlocked = new Subject<UnlockEvent>();
      mockUnlockService.unlocked$ = unlocked;
      mockKeyService.hasUserKey.mockResolvedValue(false);
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(of(unlockOptions));
      continueAfterSettingUserKey = jest
        .spyOn(component as any, "continueAfterSettingUserKey")
        .mockResolvedValue(undefined);

      component.activeAccount = await firstValueFrom(mockAccountService.activeAccount$);
      await (component as any).handleActiveAccountChange(component.activeAccount);
    });

    it.each([
      UnlockMethod.Pin,
      UnlockMethod.Biometrics,
      UnlockMethod.Prf,
      UnlockMethod.KeyConnector,
      UnlockMethod.DecryptedUserKey,
      UnlockMethod.SharedUnlock,
      UnlockMethod.AutoKey,
    ])("continues the unlock flow for an unlock by %s", (method) => {
      unlocked.next({ userId, method });

      expect(continueAfterSettingUserKey).toHaveBeenCalledTimes(1);
    });

    it("leaves a master password unlock to successfulMasterPasswordUnlock", () => {
      unlocked.next({ userId, method: UnlockMethod.MasterPassword });

      expect(continueAfterSettingUserKey).not.toHaveBeenCalled();
    });

    it("continues only once", () => {
      unlocked.next({ userId, method: UnlockMethod.Pin });
      unlocked.next({ userId, method: UnlockMethod.SharedUnlock });

      expect(continueAfterSettingUserKey).toHaveBeenCalledTimes(1);
    });

    it("ignores an unlock of another user", () => {
      unlocked.next({ userId: "other-user-id" as UserId, method: UnlockMethod.Pin });

      expect(continueAfterSettingUserKey).not.toHaveBeenCalled();
    });
  });

  describe("successfulMasterPasswordUnlock", () => {
    const mockUserKey = new SymmetricCryptoKey(new Uint8Array(64)) as UserKey;
    const masterPassword = "test-password";

    beforeEach(async () => {
      component.activeAccount = await firstValueFrom(mockAccountService.activeAccount$);
    });

    it.each([
      [undefined as unknown as UserKey, undefined as unknown as string],
      [null as unknown as UserKey, null as unknown as string],
      [mockUserKey, undefined as unknown as string],
      [mockUserKey, null as unknown as string],
      [mockUserKey, ""],
      [undefined as unknown as UserKey, masterPassword],
      [null as unknown as UserKey, masterPassword],
    ])(
      "logs an error and doesn't unlock when called with invalid data",
      async (userKey, masterPassword) => {
        await component.successfulMasterPasswordUnlock({ userKey, masterPassword });

        expect(mockLogService.error).toHaveBeenCalledWith(
          "[LockComponent] successfulMasterPasswordUnlock called with invalid data.",
        );
        expect(mockDeviceTrustService.trustDeviceIfRequired).not.toHaveBeenCalled();
        expect(mockMessagingService.send).not.toHaveBeenCalledWith("unlocked");
      },
    );

    it.each([
      [false, undefined, false],
      [false, { enforceOnLogin: false } as MasterPasswordPolicyOptions, false],
      [false, { enforceOnLogin: false } as MasterPasswordPolicyOptions, true],
      [true, { enforceOnLogin: true } as MasterPasswordPolicyOptions, false],
      [false, { enforceOnLogin: true } as MasterPasswordPolicyOptions, true],
    ])(
      "unlocks and force set password change = %o when master password on login = %o and evaluated password against policy = %o and policy loaded from policy service",
      async (forceSetPassword, masterPasswordPolicyOptions, evaluatedMasterPassword) => {
        mockPolicyService.masterPasswordPolicyOptions$.mockReturnValue(
          of(masterPasswordPolicyOptions),
        );
        const passwordStrengthResult = { score: 1 } as ZXCVBNResult;
        mockPasswordStrengthService.getPasswordStrength.mockReturnValue(passwordStrengthResult);
        mockPolicyService.evaluateMasterPassword.mockReturnValue(evaluatedMasterPassword);

        await component.successfulMasterPasswordUnlock({ userKey: mockUserKey, masterPassword });

        assertUnlocked();
        expect(mockPolicyService.masterPasswordPolicyOptions$).toHaveBeenCalledWith(userId);
        if (masterPasswordPolicyOptions?.enforceOnLogin) {
          expect(mockPasswordStrengthService.getPasswordStrength).toHaveBeenCalledWith(
            masterPassword,
            component.activeAccount!.email,
          );
          expect(mockPolicyService.evaluateMasterPassword).toHaveBeenCalledWith(
            passwordStrengthResult.score,
            masterPassword,
            masterPasswordPolicyOptions,
          );
        }
        if (forceSetPassword) {
          expect(mockMasterPasswordService.setForceSetPasswordReason).toHaveBeenCalledWith(
            ForceSetPasswordReason.WeakMasterPassword,
            userId,
          );
        } else {
          expect(mockMasterPasswordService.setForceSetPasswordReason).not.toHaveBeenCalled();
        }
      },
    );

    it.each([
      [true, ClientType.Browser],
      [false, ClientType.Cli],
      [false, ClientType.Desktop],
      [false, ClientType.Web],
    ])(
      "unlocks and navigate by url to previous url = %o when client type = %o and previous url was set",
      async (shouldNavigate, clientType) => {
        const previousUrl = "/test-url";
        component.clientType = clientType;
        mockLockComponentService.getPreviousUrl.mockReturnValue(previousUrl);

        await component.successfulMasterPasswordUnlock({ userKey: mockUserKey, masterPassword });

        assertUnlocked();
        if (shouldNavigate) {
          expect(mockRouter.navigateByUrl).toHaveBeenCalledWith(previousUrl);
        } else {
          expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
        }
      },
    );

    it.each([
      ["/tabs/current", ClientType.Browser],
      [undefined, ClientType.Cli],
      ["vault", ClientType.Desktop],
      ["vault", ClientType.Web],
    ])(
      "unlocks and navigate to success url = %o when client type = %o",
      async (navigateUrl, clientType) => {
        component.clientType = clientType;
        mockLockComponentService.getPreviousUrl.mockReturnValue(null);

        jest.spyOn(component as any, "doContinue").mockImplementation(async () => {
          await mockBiometricStateService.resetUserPromptCancelled(userId);
          mockMessagingService.send("unlocked");
          await mockSyncService.fullSync(false);
          await mockUserAsymmetricKeysRegenerationService.regenerateIfNeeded(userId);
          await mockRouter.navigate([navigateUrl]);
        });

        await component.successfulMasterPasswordUnlock({ userKey: mockUserKey, masterPassword });

        assertUnlocked();
        expect(mockRouter.navigate).toHaveBeenCalledWith([navigateUrl]);
      },
    );

    it("unlocks and close browser extension popout on firefox extension", async () => {
      component.shouldClosePopout = true;
      mockPlatformUtilsService.getDevice.mockReturnValue(DeviceType.FirefoxExtension);

      jest.spyOn(component as any, "doContinue").mockImplementation(async () => {
        await mockBiometricStateService.resetUserPromptCancelled(userId);
        mockMessagingService.send("unlocked");
        await mockSyncService.fullSync(false);
        await mockUserAsymmetricKeysRegenerationService.regenerateIfNeeded(
          component.activeAccount!.id,
        );
        mockLockComponentService.closeBrowserExtensionPopout();
      });

      await component.successfulMasterPasswordUnlock({ userKey: mockUserKey, masterPassword });

      assertUnlocked();
      expect(mockLockComponentService.closeBrowserExtensionPopout).toHaveBeenCalled();
    });

    function assertUnlocked(): void {
      expect(mockDeviceTrustService.trustDeviceIfRequired).toHaveBeenCalledWith(
        component.activeAccount!.id,
      );
    }
  });

  describe("encrypted migrations", () => {
    const previousUrl = "/fido2?sessionId=test-session";
    let resolveMigrations: () => void;

    beforeEach(async () => {
      component.activeAccount = await firstValueFrom(mockAccountService.activeAccount$);
      component.clientType = ClientType.Browser;
      mockPlatformUtilsService.getClientType.mockReturnValue(ClientType.Browser);
      mockLockComponentService.getPreviousUrl.mockReturnValue(previousUrl);
      mockPolicyService.masterPasswordPolicyOptions$.mockReturnValue(of(undefined));
      mockEncryptedMigrator.runMigrations.mockReturnValue(
        new Promise((resolve) => (resolveMigrations = resolve)),
      );
    });

    it("continues to the previous url while migrations without the master password are pending", async () => {
      await (component as any).continueAfterSettingUserKey();

      expect(mockEncryptedMigrator.runMigrations).toHaveBeenCalledWith(userId, null);
      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith(previousUrl);
    });

    it("waits for migrations that use the master password", fakeAsync(() => {
      void component.successfulMasterPasswordUnlock({
        userKey: new SymmetricCryptoKey(new Uint8Array(64)) as UserKey,
        masterPassword: "test-password",
      });
      tick();

      expect(mockEncryptedMigrator.runMigrations).toHaveBeenCalledWith(userId, "test-password");
      expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();

      resolveMigrations();
      tick();

      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith(previousUrl);
    }));
  });

  describe("onPrfUnlockSuccess", () => {
    const mockUserKey = new SymmetricCryptoKey(new Uint8Array(64)) as UserKey;

    beforeEach(async () => {
      component.activeAccount = await firstValueFrom(mockAccountService.activeAccount$);
    });

    it("unlocks with the decrypted user key via the unlock service", async () => {
      await component.onPrfUnlockSuccess(mockUserKey);

      expect(mockUnlockService.unlockWithDecryptedUserKey).toHaveBeenCalledWith(
        userId,
        mockUserKey,
        UnlockMethod.Prf,
      );
      // The continuation is driven by UnlockService.unlocked$, not by this method.
      expect(mockDeviceTrustService.trustDeviceIfRequired).not.toHaveBeenCalled();
    });

    it("throws when there is no active account", async () => {
      component.activeAccount = null;

      await expect(component.onPrfUnlockSuccess(mockUserKey)).rejects.toThrow("No active user.");
      expect(mockUnlockService.unlockWithDecryptedUserKey).not.toHaveBeenCalled();
    });
  });

  describe("logOut", () => {
    it("should log out user and redirect to login page when dialog confirmed", async () => {
      mockDialogService.openSimpleDialog.mockResolvedValue(true);
      component.activeAccount = await firstValueFrom(mockAccountService.activeAccount$);

      await component.logOut();

      expect(mockDialogService.openSimpleDialog).toHaveBeenCalledWith({
        title: { key: "logOut" },
        content: { key: "logOutConfirmation" },
        acceptButtonText: { key: "logOut" },
        type: "warning",
      });
      expect(mockLogoutService.logout).toHaveBeenCalledWith(userId, "userInitiated");
      expect(mockRouter.navigate).toHaveBeenCalledWith(["/"]);
    });

    it("should not log out user when dialog cancelled", async () => {
      mockDialogService.openSimpleDialog.mockResolvedValue(false);
      component.activeAccount = await firstValueFrom(mockAccountService.activeAccount$);

      await component.logOut();

      expect(mockDialogService.openSimpleDialog).toHaveBeenCalledWith({
        title: { key: "logOut" },
        content: { key: "logOutConfirmation" },
        acceptButtonText: { key: "logOut" },
        type: "warning",
      });
      expect(mockLogoutService.logout).not.toHaveBeenCalled();
      expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it("should not log out user when user already logged out", async () => {
      mockDialogService.openSimpleDialog.mockResolvedValue(true);
      component.activeAccount = null;

      await component.logOut();

      expect(mockDialogService.openSimpleDialog).toHaveBeenCalledWith({
        title: { key: "logOut" },
        content: { key: "logOutConfirmation" },
        acceptButtonText: { key: "logOut" },
        type: "warning",
      });
      expect(mockLogoutService.logout).not.toHaveBeenCalled();
      expect(mockRouter.navigate).not.toHaveBeenCalled();
    });
  });

  describe("swapUnlockOption", () => {
    it("switches to biometrics and immediately attempts biometric unlock", async () => {
      const unlockViaBiometricsSpy = jest
        .spyOn(component, "unlockViaBiometrics")
        .mockResolvedValue();

      await component.swapUnlockOption(UnlockOption.Biometrics);

      expect(component.activeUnlockOption).toBe(UnlockOption.Biometrics);
      expect(unlockViaBiometricsSpy).toHaveBeenCalledTimes(1);
    });

    it("switches to pin without triggering biometric unlock", async () => {
      const unlockViaBiometricsSpy = jest
        .spyOn(component, "unlockViaBiometrics")
        .mockResolvedValue();

      await component.swapUnlockOption(UnlockOption.Pin);

      expect(component.activeUnlockOption).toBe(UnlockOption.Pin);
      expect(unlockViaBiometricsSpy).not.toHaveBeenCalled();
    });

    it("switches to master password without triggering biometric unlock", async () => {
      const unlockViaBiometricsSpy = jest
        .spyOn(component, "unlockViaBiometrics")
        .mockResolvedValue();

      await component.swapUnlockOption(UnlockOption.MasterPassword);

      expect(component.activeUnlockOption).toBe(UnlockOption.MasterPassword);
      expect(unlockViaBiometricsSpy).not.toHaveBeenCalled();
    });
  });

  describe("unlockViaBiometrics", () => {
    beforeEach(async () => {
      component.activeAccount = await firstValueFrom(mockAccountService.activeAccount$);
      component.unlockOptions = {
        biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
        pin: { enabled: false },
        masterPassword: { enabled: true },
        prf: { enabled: false },
      };
    });

    it("ignores concurrent unlock attempts while one biometric unlock is in progress", async () => {
      let resolvePendingUnlock: (() => void) | undefined;
      const pendingUnlock = new Promise<void>((resolve) => {
        resolvePendingUnlock = resolve;
      });
      mockUnlockService.unlockWithBiometrics.mockReturnValue(pendingUnlock);

      const firstAttempt = component.unlockViaBiometrics();
      await component.unlockViaBiometrics();
      resolvePendingUnlock?.();
      await firstAttempt;

      expect(mockUnlockService.unlockWithBiometrics).toHaveBeenCalledTimes(1);
    });

    it("unlocks via the unlock service and leaves the continuation to unlocked$", async () => {
      mockUnlockService.unlockWithBiometrics.mockResolvedValue();

      await component.unlockViaBiometrics();

      expect(mockUnlockService.unlockWithBiometrics).toHaveBeenCalledWith(userId);
      expect(mockDeviceTrustService.trustDeviceIfRequired).not.toHaveBeenCalled();
    });

    it("does not continue the unlock flow when the unlock service throws", async () => {
      mockUnlockService.unlockWithBiometrics.mockRejectedValue(new Error("cancelled"));

      await component.unlockViaBiometrics();

      expect(mockDeviceTrustService.trustDeviceIfRequired).not.toHaveBeenCalled();
      expect(mockLogService.info).toHaveBeenCalledWith(
        "[LockComponent] Failed to unlock via biometrics.",
        expect.any(Error),
      );
    });
  });

  describe("setDefaultActiveUnlockOption", () => {
    it.each([
      [
        "biometrics enabled",
        {
          biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
          pin: { enabled: false },
          masterPassword: { enabled: false },
        } as UnlockOptions,
        UnlockOption.Biometrics,
      ],
      [
        "biometrics disabled, pin enabled",
        {
          biometrics: { enabled: false, biometricsStatus: BiometricsStatus.NotEnabledLocally },
          pin: { enabled: true },
          masterPassword: { enabled: false },
        } as UnlockOptions,
        UnlockOption.Pin,
      ],
      [
        "biometrics and pin disabled, masterPassword enabled",
        {
          biometrics: { enabled: false, biometricsStatus: BiometricsStatus.NotEnabledLocally },
          pin: { enabled: false },
          masterPassword: { enabled: true },
        } as UnlockOptions,
        UnlockOption.MasterPassword,
      ],
      [
        "hardware unavailable, no other options",
        {
          biometrics: { enabled: false, biometricsStatus: BiometricsStatus.HardwareUnavailable },
          pin: { enabled: false },
          masterPassword: { enabled: false },
        } as UnlockOptions,
        UnlockOption.Biometrics,
      ],
      [
        "desktop disconnected, no other options",
        {
          biometrics: { enabled: false, biometricsStatus: BiometricsStatus.DesktopDisconnected },
          pin: { enabled: false },
          masterPassword: { enabled: false },
        } as UnlockOptions,
        UnlockOption.Biometrics,
      ],
      [
        "not enabled in connected desktop app, no other options",
        {
          biometrics: {
            enabled: false,
            biometricsStatus: BiometricsStatus.NotEnabledInConnectedDesktopApp,
          },
          pin: { enabled: false },
          masterPassword: { enabled: false },
        } as UnlockOptions,
        UnlockOption.Biometrics,
      ],
      [
        "biometrics over pin priority",
        {
          biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
          pin: { enabled: true },
          masterPassword: { enabled: false },
        } as UnlockOptions,
        UnlockOption.Biometrics,
      ],
      [
        "biometrics over masterPassword priority",
        {
          biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
          pin: { enabled: false },
          masterPassword: { enabled: true },
        } as UnlockOptions,
        UnlockOption.Biometrics,
      ],
      [
        "pin over masterPassword priority",
        {
          biometrics: { enabled: false, biometricsStatus: BiometricsStatus.NotEnabledLocally },
          pin: { enabled: true },
          masterPassword: { enabled: true },
        } as UnlockOptions,
        UnlockOption.Pin,
      ],
      [
        "all options enabled",
        {
          biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
          pin: { enabled: true },
          masterPassword: { enabled: true },
        } as UnlockOptions,
        UnlockOption.Biometrics,
      ],
    ])(
      "should set active unlock option to $1 when %s",
      async (
        description: string,
        unlockOptions: UnlockOptions,
        expectedOption: UnlockOptionValue,
      ) => {
        await component["setDefaultActiveUnlockOption"](unlockOptions);

        expect(component.activeUnlockOption).toBe(expectedOption);
      },
    );
  });

  describe("handleActiveAccountChange", () => {
    const mockActiveAccount: Account = {
      id: userId,
      email: "test@example.com",
      name: "Test User",
    } as Account;

    beforeEach(async () => {
      component.activeAccount = mockActiveAccount;
    });

    it("should return early when account already has user key", async () => {
      mockKeyService.hasUserKey.mockResolvedValue(true);

      await component["handleActiveAccountChange"](mockActiveAccount);

      expect(mockKeyService.hasUserKey).toHaveBeenCalledWith(userId);
      expect(mockAnonLayoutWrapperDataService.setAnonLayoutWrapperData).not.toHaveBeenCalled();
    });

    it("should set email as page subtitle when account is unlocked", async () => {
      mockKeyService.hasUserKey.mockResolvedValue(false);
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(
        of({
          biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
          pin: { enabled: false },
          masterPassword: { enabled: false },
        } as UnlockOptions),
      );
      mockBiometricService.getBiometricsStatusForUser.mockResolvedValue(BiometricsStatus.Available);

      await component["handleActiveAccountChange"](mockActiveAccount);

      expect(mockAnonLayoutWrapperDataService.setAnonLayoutWrapperData).toHaveBeenCalledWith({
        pageSubtitle: mockActiveAccount.email,
      });
    });

    it("should logout user when no unlock options are available", async () => {
      mockKeyService.hasUserKey.mockResolvedValue(false);
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(
        of({
          biometrics: { enabled: false, biometricsStatus: BiometricsStatus.UnlockNeeded },
          pin: { enabled: false },
          masterPassword: { enabled: false },
        } as UnlockOptions),
      );
      mockBiometricService.getBiometricsStatusForUser.mockResolvedValue(
        BiometricsStatus.UnlockNeeded,
      );

      await component["handleActiveAccountChange"](mockActiveAccount);

      expect(mockLogService.warning).toHaveBeenCalledWith(
        "[LockComponent] User cannot unlock again. Logging out!",
      );
      expect(mockLogoutService.logout).toHaveBeenCalledWith(userId, "noUnlockOptionsAvailable");
    });

    it("should not logout when master password is enabled", async () => {
      mockKeyService.hasUserKey.mockResolvedValue(false);
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(
        of({
          biometrics: { enabled: false, biometricsStatus: BiometricsStatus.UnlockNeeded },
          pin: { enabled: false },
          masterPassword: { enabled: true },
        } as UnlockOptions),
      );
      mockBiometricService.getBiometricsStatusForUser.mockResolvedValue(
        BiometricsStatus.UnlockNeeded,
      );

      await component["handleActiveAccountChange"](mockActiveAccount);

      expect(mockLogoutService.logout).not.toHaveBeenCalled();
      expect(component.activeUnlockOption).toBe(UnlockOption.MasterPassword);
    });

    it("should not logout when pin is enabled", async () => {
      mockKeyService.hasUserKey.mockResolvedValue(false);
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(
        of({
          biometrics: { enabled: false, biometricsStatus: BiometricsStatus.UnlockNeeded },
          pin: { enabled: true },
          masterPassword: { enabled: false },
        } as UnlockOptions),
      );
      mockBiometricService.getBiometricsStatusForUser.mockResolvedValue(
        BiometricsStatus.UnlockNeeded,
      );

      await component["handleActiveAccountChange"](mockActiveAccount);

      expect(mockLogoutService.logout).not.toHaveBeenCalled();
      expect(component.activeUnlockOption).toBe(UnlockOption.Pin);
    });

    it("should not logout when biometrics is available", async () => {
      mockKeyService.hasUserKey.mockResolvedValue(false);
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(
        of({
          biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
          pin: { enabled: false },
          masterPassword: { enabled: false },
        } as UnlockOptions),
      );
      mockBiometricService.getBiometricsStatusForUser.mockResolvedValue(BiometricsStatus.Available);

      await component["handleActiveAccountChange"](mockActiveAccount);

      expect(mockLogoutService.logout).not.toHaveBeenCalled();
      expect(component.activeUnlockOption).toBe(UnlockOption.Biometrics);
    });

    it("should not logout when biometrics is temporarily unavailable but no other options", async () => {
      mockKeyService.hasUserKey.mockResolvedValue(false);
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(
        of({
          biometrics: {
            enabled: false,
            biometricsStatus: BiometricsStatus.HardwareUnavailable,
          },
          pin: { enabled: false },
          masterPassword: { enabled: false },
        } as UnlockOptions),
      );
      mockBiometricService.getBiometricsStatusForUser.mockResolvedValue(
        BiometricsStatus.HardwareUnavailable,
      );

      await component["handleActiveAccountChange"](mockActiveAccount);

      expect(mockLogoutService.logout).not.toHaveBeenCalled();
      expect(component.activeUnlockOption).toBe(UnlockOption.Biometrics);
    });
  });

  describe("listenForUnlockOptionsChanges", () => {
    const mockActiveAccount: Account = {
      id: userId,
      email: "test@example.com",
      name: "Test User",
    } as Account;

    const mockUnlockOptions: UnlockOptions = {
      masterPassword: { enabled: true },
      pin: { enabled: false },
      biometrics: { enabled: false, biometricsStatus: BiometricsStatus.Available },
      prf: { enabled: false },
    };

    beforeEach(() => {
      (component as any).loading = false;
      component.activeAccount = mockActiveAccount;
      component.activeUnlockOption = null;
      component.unlockOptions = null;
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(of(mockUnlockOptions));
    });

    it("skips polling when loading is true", fakeAsync(() => {
      (component as any).loading = true;

      component["listenForUnlockOptionsChanges"]();
      tick(0);

      expect(mockLockComponentService.getAvailableUnlockOptions$).not.toHaveBeenCalled();
    }));

    it("skips polling when activeAccount is null", fakeAsync(() => {
      component.activeAccount = null;

      component["listenForUnlockOptionsChanges"]();
      tick(0);

      expect(mockLockComponentService.getAvailableUnlockOptions$).not.toHaveBeenCalled();
    }));

    it("fetches unlock options when loading is false and activeAccount exists", fakeAsync(() => {
      component["listenForUnlockOptionsChanges"]();
      tick(0);

      expect(mockLockComponentService.getAvailableUnlockOptions$).toHaveBeenCalledWith(userId);
      expect(component.unlockOptions).toEqual(mockUnlockOptions);
    }));

    it("calls getAvailableUnlockOptions$ at 1000ms intervals", fakeAsync(() => {
      component["listenForUnlockOptionsChanges"]();

      // Initial timer fire at 0ms
      tick(0);
      expect(mockLockComponentService.getAvailableUnlockOptions$).toHaveBeenCalledTimes(1);

      // First poll at 1000ms
      tick(1000);
      expect(mockLockComponentService.getAvailableUnlockOptions$).toHaveBeenCalledTimes(2);

      // Second poll at 2000ms
      tick(1000);
      expect(mockLockComponentService.getAvailableUnlockOptions$).toHaveBeenCalledTimes(3);
    }));

    it("calls setDefaultActiveUnlockOption when activeUnlockOption is null", fakeAsync(() => {
      component.activeUnlockOption = null;
      const setDefaultSpy = jest.spyOn(component as any, "setDefaultActiveUnlockOption");

      component["listenForUnlockOptionsChanges"]();
      tick(0);

      expect(setDefaultSpy).toHaveBeenCalledWith(mockUnlockOptions);
    }));

    it("does NOT call setDefaultActiveUnlockOption when activeUnlockOption is already set", fakeAsync(() => {
      component.activeUnlockOption = UnlockOption.MasterPassword;
      component.unlockOptions = mockUnlockOptions;

      const setDefaultSpy = jest.spyOn(component as any, "setDefaultActiveUnlockOption");

      component["listenForUnlockOptionsChanges"]();
      tick(0);

      expect(setDefaultSpy).not.toHaveBeenCalled();
    }));

    it("calls setDefaultActiveUnlockOption when biometrics becomes enabled", fakeAsync(() => {
      component.activeUnlockOption = UnlockOption.MasterPassword;

      // Start with biometrics disabled
      component.unlockOptions = {
        masterPassword: { enabled: true },
        pin: { enabled: false },
        biometrics: { enabled: false, biometricsStatus: BiometricsStatus.Available },
        prf: { enabled: false },
      };

      // Mock response with biometrics enabled
      const newUnlockOptions: UnlockOptions = {
        masterPassword: { enabled: true },
        pin: { enabled: false },
        biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
        prf: { enabled: false },
      };

      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(of(newUnlockOptions));

      const setDefaultSpy = jest.spyOn(component as any, "setDefaultActiveUnlockOption");
      const handleBioSpy = jest.spyOn(component as any, "handleBiometricsUnlockEnabled");

      component["listenForUnlockOptionsChanges"]();
      tick(0);

      expect(setDefaultSpy).toHaveBeenCalledWith(newUnlockOptions);
      expect(handleBioSpy).toHaveBeenCalled();
    }));

    it("does NOT call setDefaultActiveUnlockOption when biometrics was already enabled", fakeAsync(() => {
      component.activeUnlockOption = UnlockOption.MasterPassword;

      // Start with biometrics already enabled
      component.unlockOptions = {
        masterPassword: { enabled: true },
        pin: { enabled: false },
        biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
        prf: { enabled: false },
      };

      // Mock response with biometrics still enabled
      const newUnlockOptions: UnlockOptions = {
        masterPassword: { enabled: true },
        pin: { enabled: false },
        biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
        prf: { enabled: false },
      };
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(of(newUnlockOptions));

      const setDefaultSpy = jest.spyOn(component as any, "setDefaultActiveUnlockOption");

      component["listenForUnlockOptionsChanges"]();
      tick(0);

      expect(setDefaultSpy).not.toHaveBeenCalled();
    }));
  });

  describe("the lock screen of an account named by the route", () => {
    const otherUserId = "other-user-id" as UserId;
    const otherEmail = "other@example.com";
    const previousUrl = "/fido2?sessionId=test-session&unlockedUserId=other-user-id";
    const mockUserKey = new SymmetricCryptoKey(new Uint8Array(64)) as UserKey;
    const masterPassword = "test-password";
    let otherStatus: BehaviorSubject<AuthenticationStatus>;
    const unlockOptions = {
      masterPassword: { enabled: true },
      pin: { enabled: true },
      biometrics: { enabled: false, biometricsStatus: BiometricsStatus.NotEnabledLocally },
      prf: { enabled: false },
    };

    beforeEach(() => {
      mockAccountService.accountsSubject.next({
        [userId]: mockAccountInfoWith({ email: "active@example.com" }),
        [otherUserId]: mockAccountInfoWith({ email: otherEmail }),
      });
      mockActivatedRoute.snapshot.queryParamMap.get.mockImplementation((name: string) =>
        name === "userId" ? otherUserId : null,
      );
      mockActivatedRoute.snapshot.paramMap.get.mockReturnValue(null);
      mockPlatformUtilsService.getClientType.mockReturnValue(ClientType.Browser);
      mockLockComponentService.getAvailableUnlockOptions$.mockReturnValue(of(unlockOptions));
      mockLockComponentService.getPreviousUrl.mockReturnValue(previousUrl);
      mockPolicyService.masterPasswordPolicyOptions$.mockReturnValue(of(undefined));
      mockLogoutService.logout.mockResolvedValue(undefined);
      otherStatus = new BehaviorSubject<AuthenticationStatus>(AuthenticationStatus.Locked);
      mockAuthService.authStatusFor$.mockReturnValue(otherStatus);
    });

    const init = async () => {
      await component.ngOnInit();
      await fixture.whenStable();
    };

    const activeUserId = async () => (await firstValueFrom(mockAccountService.activeAccount$))?.id;

    it("shows that account and its unlock options, not the active account's", async () => {
      await init();

      expect(component.activeAccount).toEqual(
        expect.objectContaining({ id: otherUserId, email: otherEmail }),
      );
      expect(mockAnonLayoutWrapperDataService.setAnonLayoutWrapperData).toHaveBeenCalledWith({
        pageSubtitle: otherEmail,
      });
      expect(mockLockComponentService.getAvailableUnlockOptions$).toHaveBeenCalledWith(otherUserId);
      expect(mockLockComponentService.getAvailableUnlockOptions$).not.toHaveBeenCalledWith(userId);
      expect(component.unlockOptions).toEqual(unlockOptions);
    });

    it("continues a master password unlock for that account and leaves the active account as it is", async () => {
      await init();

      await component.successfulMasterPasswordUnlock({ userKey: mockUserKey, masterPassword });

      expect(mockBiometricStateService.resetUserPromptCancelled).toHaveBeenCalledWith(otherUserId);
      expect(mockEncryptedMigrator.runMigrations).toHaveBeenCalledWith(otherUserId, masterPassword);
      expect(mockPolicyService.masterPasswordPolicyOptions$).toHaveBeenCalledWith(otherUserId);
      expect(mockSyncService.fullSync).toHaveBeenCalledWith(false, { userId: otherUserId });
      expect(mockSyncService.fullSync).not.toHaveBeenCalledWith(false);
      expect(mockUserAsymmetricKeysRegenerationService.regenerateIfNeeded).toHaveBeenCalledWith(
        otherUserId,
      );
      // The background is told which account, so it does not take it for the active one
      expect(mockMessagingService.send).toHaveBeenCalledWith("unlocked", { userId: otherUserId });
      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith(previousUrl);
      expect(await activeUserId()).toBe(userId);
      expect(mockAccountService.mock.switchAccount).not.toHaveBeenCalled();
    });

    it("requires a password change of that account when its policy asks for one", async () => {
      mockPolicyService.masterPasswordPolicyOptions$.mockReturnValue(
        of({ enforceOnLogin: true } as MasterPasswordPolicyOptions),
      );
      mockPasswordStrengthService.getPasswordStrength.mockReturnValue({ score: 1 } as ZXCVBNResult);
      mockPolicyService.evaluateMasterPassword.mockReturnValue(false);
      await init();

      await component.successfulMasterPasswordUnlock({ userKey: mockUserKey, masterPassword });

      expect(mockPasswordStrengthService.getPasswordStrength).toHaveBeenCalledWith(
        masterPassword,
        otherEmail,
      );
      expect(mockMasterPasswordService.setForceSetPasswordReason).toHaveBeenCalledWith(
        ForceSetPasswordReason.WeakMasterPassword,
        otherUserId,
      );
    });

    it("goes to the default route when no previous url is kept", async () => {
      mockLockComponentService.getPreviousUrl.mockReturnValue(null);
      await init();

      await component.successfulMasterPasswordUnlock({ userKey: mockUserKey, masterPassword });

      expect(mockRouter.navigate).toHaveBeenCalledWith(["/tabs/current"]);
    });

    it("establishes device trust for that account", async () => {
      await init();

      await component.successfulMasterPasswordUnlock({ userKey: mockUserKey, masterPassword });

      expect(mockDeviceTrustService.trustDeviceIfRequired).toHaveBeenCalledWith(otherUserId);
    });

    it.each([AuthenticationStatus.LoggedOut, AuthenticationStatus.Unlocked])(
      "returns to the previous url when that account becomes %s elsewhere",
      async (status) => {
        await init();
        expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();

        otherStatus.next(status);
        otherStatus.next(status);

        expect(mockAuthService.authStatusFor$).toHaveBeenCalledWith(otherUserId);
        expect(mockRouter.navigateByUrl).toHaveBeenCalledTimes(1);
        expect(mockRouter.navigateByUrl).toHaveBeenCalledWith(previousUrl);
        // The unlock was not performed here: its tail is not run here either
        expect(mockMessagingService.send).not.toHaveBeenCalled();
      },
    );

    it("leaves the navigation to the unlock while that account is unlocked here", async () => {
      await init();
      component.formGroup = new FormBuilder().group({ pin: ["1234"] });
      let finishUnlock!: () => void;
      mockUnlockService.unlockWithPin.mockReturnValue(
        new Promise<void>((resolve) => (finishUnlock = resolve)),
      );

      const unlock = component["unlockViaPin"]();
      await Promise.resolve();
      otherStatus.next(AuthenticationStatus.Unlocked);
      finishUnlock();
      await unlock;

      expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
    });

    it("leaves the navigation to the tail of a master password unlock", async () => {
      await init();

      const unlock = component.successfulMasterPasswordUnlock({
        userKey: mockUserKey,
        masterPassword,
      });
      otherStatus.next(AuthenticationStatus.Unlocked);
      await unlock;

      expect(mockRouter.navigateByUrl).toHaveBeenCalledTimes(1);
      expect(mockMessagingService.send).toHaveBeenCalledWith("unlocked", { userId: otherUserId });
    });

    it("unlocks that account with the PIN", async () => {
      await init();
      component.formGroup = new FormBuilder().group({ pin: ["1234"] });

      await component["unlockViaPin"]();

      expect(mockUnlockService.unlockWithPin).toHaveBeenCalledWith(otherUserId, "1234");
    });

    it("logs out that account alone after too many invalid PINs, and returns to the previous url", async () => {
      mockUnlockService.unlockWithPin.mockRejectedValue(new Error("invalid PIN"));
      await init();
      component.formGroup = new FormBuilder().group({ pin: ["0000"] });

      for (let attempt = 0; attempt < 5; attempt++) {
        await component["unlockViaPin"]();
      }

      expect(mockLogoutService.logout).toHaveBeenCalledTimes(1);
      expect(mockLogoutService.logout).toHaveBeenCalledWith(
        otherUserId,
        "tooManyInvalidPinAttempts",
      );
      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith(previousUrl);
      expect(await activeUserId()).toBe(userId);
    });

    it("logs out that account alone when the user asks to, and returns to the previous url", async () => {
      mockDialogService.openSimpleDialog.mockResolvedValue(true);
      await init();

      await component.logOut();

      expect(mockLogoutService.logout).toHaveBeenCalledWith(otherUserId, "userInitiated");
      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith(previousUrl);
      expect(mockRouter.navigate).not.toHaveBeenCalledWith(["/"]);
    });

    it("unlocks that account with biometrics", async () => {
      await init();
      component.unlockOptions = {
        ...unlockOptions,
        biometrics: { enabled: true, biometricsStatus: BiometricsStatus.Available },
      };

      await component.unlockViaBiometrics();

      expect(mockUnlockService.unlockWithBiometrics).toHaveBeenCalledWith(otherUserId);
    });
  });
});
