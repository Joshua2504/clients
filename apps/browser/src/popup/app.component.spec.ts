import { ChangeDetectorRef, DestroyRef, NgZone } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { mock, MockProxy } from "jest-mock-extended";
import { EMPTY, of } from "rxjs";

import { DeviceTrustToastService } from "@bitwarden/angular/auth/services/device-trust-toast.service.abstraction";
import { DocumentLangSetter } from "@bitwarden/angular/platform/i18n";
import {
  AuthRequestServiceAbstraction,
  UserDecryptionOptionsServiceAbstraction,
} from "@bitwarden/auth/common";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthRequestAnsweringService } from "@bitwarden/common/auth/abstractions/auth-request-answering/auth-request-answering.service.abstraction";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { TokenService } from "@bitwarden/common/auth/abstractions/token.service";
import { PendingAuthRequestsStateService } from "@bitwarden/common/auth/services/auth-request-answering/pending-auth-requests.state";
import { PremiumCheckoutPendingService } from "@bitwarden/common/billing/abstractions/account/premium-checkout-pending.service";
import { AnimationControlService } from "@bitwarden/common/platform/abstractions/animation-control.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { SdkService } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { MessageListener } from "@bitwarden/common/platform/messaging";
import { SyncService } from "@bitwarden/common/platform/sync";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { DialogService, ToastService } from "@bitwarden/components";
import { BiometricsService, BiometricStateService, KeyService } from "@bitwarden/key-management";

import { PopupCompactModeService } from "../platform/popup/layout/popup-compact-mode.service";
import { PopupSizeService } from "../platform/popup/layout/popup-size.service";

import { AppComponent } from "./app.component";

describe("AppComponent (browser popup)", () => {
  let component: AppComponent;

  let accountService: MockProxy<AccountService>;
  let syncService: MockProxy<SyncService>;
  let premiumCheckoutPendingService: MockProxy<PremiumCheckoutPendingService>;
  let compactModeService: MockProxy<PopupCompactModeService>;
  let popupSizeService: MockProxy<PopupSizeService>;
  let authService: MockProxy<AuthService>;
  let messageListener: MockProxy<MessageListener>;
  let animationControlService: MockProxy<AnimationControlService>;
  let authRequestAnsweringService: MockProxy<AuthRequestAnsweringService>;
  let router: MockProxy<Router>;
  let ngZone: MockProxy<NgZone>;
  let logService: MockProxy<LogService>;
  let toastService: MockProxy<ToastService>;
  let i18nService: MockProxy<I18nService>;

  const userId = "user-1" as UserId;

  beforeEach(() => {
    accountService = mock<AccountService>();
    syncService = mock<SyncService>();
    premiumCheckoutPendingService = mock<PremiumCheckoutPendingService>();
    logService = mock<LogService>();
    compactModeService = mock<PopupCompactModeService>();
    popupSizeService = mock<PopupSizeService>();
    authService = mock<AuthService>();
    messageListener = mock<MessageListener>();
    animationControlService = mock<AnimationControlService>();
    authRequestAnsweringService = mock<AuthRequestAnsweringService>();
    router = mock<Router>();
    ngZone = mock<NgZone>();
    toastService = mock<ToastService>();
    i18nService = mock<I18nService>();
    i18nService.t.mockImplementation((key: string, ...params: unknown[]) =>
      [key, ...params].join(":"),
    );

    accountService.activeAccount$ = of({ id: userId } as any);
    authService.activeAccountStatus$ = EMPTY;
    messageListener.allMessages$ = EMPTY;
    animationControlService.enableRoutingAnimation$ = EMPTY;
    (router as any).events = EMPTY;
    popupSizeService.setHeight.mockResolvedValue(undefined);
    ngZone.runOutsideAngular.mockImplementation((fn: () => unknown) => fn());

    const documentLangSetter = mock<DocumentLangSetter>();
    documentLangSetter.start.mockReturnValue({ unsubscribe: jest.fn() } as any);
    const deviceTrustToastService = mock<DeviceTrustToastService>();
    deviceTrustToastService.setupListeners$ = EMPTY;

    const sdkService = mock<SdkService>();
    (sdkService as any).client$ = of(undefined);

    TestBed.configureTestingModule({
      providers: [
        { provide: PopupCompactModeService, useValue: compactModeService },
        { provide: SdkService, useValue: sdkService },
      ],
    });

    // The component uses `inject()` for `compactModeService`/`sdkService` field
    // initializers, so it must be constructed inside an injection context.
    component = TestBed.runInInjectionContext(
      () =>
        new AppComponent(
          authService,
          i18nService,
          router,
          mock<TokenService>(),
          mock<CipherService>(),
          mock<ChangeDetectorRef>(),
          ngZone,
          mock<PlatformUtilsService>(),
          mock<DialogService>(),
          messageListener,
          toastService,
          accountService,
          animationControlService,
          mock<BiometricStateService>(),
          mock<BiometricsService>(),
          deviceTrustToastService,
          mock<UserDecryptionOptionsServiceAbstraction>(),
          mock<KeyService>(),
          mock<DestroyRef>(),
          documentLangSetter,
          popupSizeService,
          logService,
          mock<AuthRequestServiceAbstraction>(),
          mock<PendingAuthRequestsStateService>(),
          authRequestAnsweringService,
          premiumCheckoutPendingService,
          syncService,
        ),
    );

    // Avoid touching the real chrome.runtime API during ngOnInit.
    (global as any).chrome = {
      runtime: { connect: jest.fn() },
    };
    (window as any).onmousedown = undefined;
  });

  afterEach(() => {
    component.ngOnDestroy();
    jest.clearAllMocks();
  });

  it("syncs once when a premium checkout was pending on popup open", async () => {
    premiumCheckoutPendingService.consumeCheckoutPending.mockResolvedValue({});

    await component.ngOnInit();

    expect(premiumCheckoutPendingService.consumeCheckoutPending).toHaveBeenCalledWith(userId);
    expect(syncService.fullSync).toHaveBeenCalledWith(true);
  });

  it("does not sync when no premium checkout was pending", async () => {
    premiumCheckoutPendingService.consumeCheckoutPending.mockResolvedValue(null);

    await component.ngOnInit();

    expect(syncService.fullSync).not.toHaveBeenCalled();
  });

  it("fails closed: ngOnInit resolves and logs when consume throws", async () => {
    const error = new Error("boom");
    premiumCheckoutPendingService.consumeCheckoutPending.mockRejectedValue(error);

    await expect(component.ngOnInit()).resolves.toBeUndefined();

    expect(syncService.fullSync).not.toHaveBeenCalled();
    expect(logService.error).toHaveBeenCalledWith(
      "Failed to sync after returning from premium checkout",
      error,
    );
  });

  it("does not consume or sync when there is no active user", async () => {
    accountService.activeAccount$ = of(null);

    await component.ngOnInit();

    expect(premiumCheckoutPendingService.consumeCheckoutPending).not.toHaveBeenCalled();
    expect(syncService.fullSync).not.toHaveBeenCalled();
  });

  describe("window refocus (popout / sidebar)", () => {
    const flushAsync = () => new Promise(process.nextTick);

    it("syncs when the window regains focus with a checkout pending", async () => {
      premiumCheckoutPendingService.consumeCheckoutPending.mockResolvedValue(null);
      await component.ngOnInit();
      expect(syncService.fullSync).not.toHaveBeenCalled();

      premiumCheckoutPendingService.consumeCheckoutPending.mockResolvedValue({});
      window.dispatchEvent(new Event("focus"));
      await flushAsync();

      expect(syncService.fullSync).toHaveBeenCalledWith(true);
    });

    it("does not sync on refocus when no checkout is pending", async () => {
      premiumCheckoutPendingService.consumeCheckoutPending.mockResolvedValue(null);
      await component.ngOnInit();

      window.dispatchEvent(new Event("focus"));
      await flushAsync();

      expect(syncService.fullSync).not.toHaveBeenCalled();
    });

    it("stops listening for focus after the component is destroyed", async () => {
      premiumCheckoutPendingService.consumeCheckoutPending.mockResolvedValue(null);
      await component.ngOnInit();
      component.ngOnDestroy();

      premiumCheckoutPendingService.consumeCheckoutPending.mockResolvedValue({});
      window.dispatchEvent(new Event("focus"));
      await flushAsync();

      expect(syncService.fullSync).not.toHaveBeenCalled();
    });
  });

  describe("doneLoggingOut", () => {
    const flushAsync = () => new Promise(process.nextTick);

    const receive = async (message: Record<string, unknown>) => {
      messageListener.allMessages$ = of({ command: "doneLoggingOut", ...message }) as any;
      authService.logOut.mockImplementation((callback: () => void) => callback());
      premiumCheckoutPendingService.consumeCheckoutPending.mockResolvedValue(null);
      await component.ngOnInit();
      await flushAsync();
    };

    it("shows the logout reason when the active account was logged out", async () => {
      await receive({ logoutReason: "sessionExpired", userId, loggedOutActiveAccount: true });

      expect(toastService.showToast).toHaveBeenCalledWith({
        variant: "warning",
        title: "loggedOut",
        message: "loginExpired",
      });
    });

    it("shows the logout reason for a message that does not say which account it was", async () => {
      await receive({ logoutReason: "sessionExpired", userId });

      expect(toastService.showToast).toHaveBeenCalled();
    });

    it("names the account and gives the reason when an account that is not active was logged out", async () => {
      await receive({
        logoutReason: "sessionExpired",
        userId: "user-2",
        loggedOutActiveAccount: false,
        email: "other@example.com",
      });

      expect(authService.logOut).toHaveBeenCalled();
      expect(toastService.showToast).toHaveBeenCalledTimes(1);
      expect(toastService.showToast).toHaveBeenCalledWith({
        variant: "warning",
        title: "accountWasLoggedOut:other@example.com",
        message: "loginExpired",
      });
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it("names the account when an account that is not active was logged out for a reason without a text", async () => {
      await receive({
        logoutReason: "logoutNotification",
        userId: "user-2",
        loggedOutActiveAccount: false,
        email: "other@example.com",
      });

      expect(toastService.showToast).toHaveBeenCalledWith({
        variant: "info",
        message: "accountWasLoggedOut:other@example.com",
      });
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it("shows no toast for an account that is not active when the message does not name it", async () => {
      await receive({
        logoutReason: "sessionExpired",
        userId: "user-2",
        loggedOutActiveAccount: false,
      });

      expect(toastService.showToast).not.toHaveBeenCalled();
    });

    it("shows nothing for an active-account logout reason without a text", async () => {
      await receive({ logoutReason: "userInitiated", userId, loggedOutActiveAccount: true });

      expect(toastService.showToast).not.toHaveBeenCalled();
    });
  });
});
