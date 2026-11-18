import { mock, MockProxy } from "jest-mock-extended";
import {
  BehaviorSubject,
  bufferCount,
  firstValueFrom,
  Subject,
  ObservedValueOf,
  Subscription,
} from "rxjs";

import { AutomaticUserConfirmationService } from "@bitwarden/auto-confirm";
import { Measurement } from "@bitwarden/logging";

import { mockAccountInfoWith } from "../../../../spec";
import { AccountService } from "../../../auth/abstractions/account.service";
import { AuthRequestAnsweringService } from "../../../auth/abstractions/auth-request-answering/auth-request-answering.service.abstraction";
import { AuthService } from "../../../auth/abstractions/auth.service";
import { AuthenticationStatus } from "../../../auth/enums/authentication-status";
import { LogoutReason } from "../../../auth/logout";
import { BillingAccountProfileStateService } from "../../../billing/abstractions/account/billing-account-profile-state.service";
import { NotificationType, PushNotificationLogOutReasonType } from "../../../enums";
import { NotificationResponse } from "../../../models/response/notification.response";
import { UserId } from "../../../types/guid";
import { AppIdService } from "../../abstractions/app-id.service";
import { Environment, EnvironmentService } from "../../abstractions/environment.service";
import { LogService } from "../../abstractions/log.service";
import { MessagingService } from "../../abstractions/messaging.service";

import {
  DefaultServerNotificationsService,
  DefaultServerNotificationsServiceOptions,
} from "./default-server-notifications.service";
import { SignalRConnectionService } from "./signalr-connection.service";
import { WebPushConnectionService, WebPushConnector } from "./webpush-connection.service";

describe("DefaultServerNotificationsService (multi-user)", () => {
  let syncService: any;
  let appIdService: MockProxy<AppIdService>;
  let environmentConfigurationService: MockProxy<EnvironmentService>;
  let userLogoutCallback: jest.Mock<Promise<void>, [logoutReason: LogoutReason, userId: UserId]>;
  let messagingService: MockProxy<MessagingService>;
  let accountService: MockProxy<AccountService>;
  let signalRNotificationConnectionService: MockProxy<SignalRConnectionService>;
  let authService: MockProxy<AuthService>;
  let webPushNotificationConnectionService: MockProxy<WebPushConnectionService>;
  let authRequestAnsweringService: MockProxy<AuthRequestAnsweringService>;
  let autoConfirmService: MockProxy<AutomaticUserConfirmationService>;
  let billingAccountProfileStateService: MockProxy<BillingAccountProfileStateService>;

  let activeUserAccount$: BehaviorSubject<ObservedValueOf<AccountService["activeAccount$"]>>;
  let userAccounts$: BehaviorSubject<ObservedValueOf<AccountService["accounts$"]>>;

  let environmentConfiguration$: BehaviorSubject<Environment>;

  let authenticationStatusByUser: Map<UserId, BehaviorSubject<AuthenticationStatus>>;
  let webPushSupportStatusByUser: Map<
    UserId,
    BehaviorSubject<
      { type: "supported"; service: WebPushConnector } | { type: "not-supported"; reason: string }
    >
  >;

  let connectionSubjectByUser: Map<UserId, Subject<any>>;
  let defaultServerNotificationsService: DefaultServerNotificationsService;

  const mockUserId1 = "user1" as UserId;
  const mockUserId2 = "user2" as UserId;

  beforeEach(() => {
    syncService = {
      fullSync: jest.fn().mockResolvedValue(undefined),
      syncUpsertCipher: jest.fn().mockResolvedValue(undefined),
      syncDeleteCipher: jest.fn().mockResolvedValue(undefined),
      syncUpsertFolder: jest.fn().mockResolvedValue(undefined),
      syncDeleteFolder: jest.fn().mockResolvedValue(undefined),
      syncUpsertSend: jest.fn().mockResolvedValue(undefined),
      syncDeleteSend: jest.fn().mockResolvedValue(undefined),
    };

    appIdService = mock<AppIdService>();
    appIdService.getAppId.mockResolvedValue("app-id");

    environmentConfigurationService = mock<EnvironmentService>();
    environmentConfiguration$ = new BehaviorSubject<Environment>({
      getNotificationsUrl: () => "http://test.example.com",
    } as Environment);
    environmentConfigurationService.environment$ = environmentConfiguration$ as any;
    // Ensure user-scoped environment lookups return the same test environment stream
    environmentConfigurationService.getEnvironment$.mockImplementation(
      (_userId: UserId) => environmentConfiguration$.asObservable() as any,
    );

    userLogoutCallback = jest.fn<Promise<void>, [LogoutReason, UserId]>();

    messagingService = mock<MessagingService>();

    accountService = mock<AccountService>();
    activeUserAccount$ = new BehaviorSubject<ObservedValueOf<AccountService["activeAccount$"]>>(
      null,
    );
    accountService.activeAccount$ = activeUserAccount$.asObservable();
    userAccounts$ = new BehaviorSubject<ObservedValueOf<AccountService["accounts$"]>>({} as any);
    accountService.accounts$ = userAccounts$.asObservable();

    signalRNotificationConnectionService = mock<SignalRConnectionService>();
    connectionSubjectByUser = new Map();
    signalRNotificationConnectionService.connect$.mockImplementation(
      (userId: UserId, _url: string) => {
        if (!connectionSubjectByUser.has(userId)) {
          connectionSubjectByUser.set(userId, new Subject<any>());
        }
        return connectionSubjectByUser.get(userId)!.asObservable();
      },
    );

    authService = mock<AuthService>();
    authenticationStatusByUser = new Map();
    authService.authStatusFor$.mockImplementation((userId: UserId) => {
      if (!authenticationStatusByUser.has(userId)) {
        authenticationStatusByUser.set(
          userId,
          new BehaviorSubject<AuthenticationStatus>(AuthenticationStatus.LoggedOut),
        );
      }
      return authenticationStatusByUser.get(userId)!.asObservable();
    });

    webPushNotificationConnectionService = mock<WebPushConnectionService>();
    webPushSupportStatusByUser = new Map();
    webPushNotificationConnectionService.supportStatus$.mockImplementation((userId: UserId) => {
      if (!webPushSupportStatusByUser.has(userId)) {
        webPushSupportStatusByUser.set(
          userId,
          new BehaviorSubject({ type: "not-supported", reason: "init" } as any),
        );
      }
      return webPushSupportStatusByUser.get(userId)!.asObservable();
    });

    authRequestAnsweringService = mock<AuthRequestAnsweringService>();

    autoConfirmService = mock<AutomaticUserConfirmationService>();
    billingAccountProfileStateService = mock<BillingAccountProfileStateService>();

    // The browser's configuration; see "without processForNonActiveAccounts" for the default.
    defaultServerNotificationsService = createService({ processForNonActiveAccounts: true });
  });

  function createService(options?: DefaultServerNotificationsServiceOptions) {
    return new DefaultServerNotificationsService(
      mock<LogService>({ startMeasurement: () => mock<Measurement>() }),
      syncService,
      appIdService,
      environmentConfigurationService,
      userLogoutCallback,
      messagingService,
      accountService,
      signalRNotificationConnectionService,
      authService,
      webPushNotificationConnectionService,
      authRequestAnsweringService,
      autoConfirmService,
      billingAccountProfileStateService,
      options,
    );
  }

  function setActiveUserAccount(userId: UserId | null) {
    if (userId == null) {
      activeUserAccount$.next(null);
    } else {
      activeUserAccount$.next({
        id: userId,
        ...mockAccountInfoWith({
          email: "email",
          name: "Test Name",
        }),
      });
    }
  }

  function addUserAccount(userId: UserId) {
    const currentAccounts = (userAccounts$.getValue() as Record<string, any>) ?? {};
    userAccounts$.next({
      ...currentAccounts,
      [userId]: mockAccountInfoWith({
        email: "email",
        name: "Test Name",
      }),
    } as any);
  }

  function setUserUnlocked(userId: UserId) {
    if (!authenticationStatusByUser.has(userId)) {
      authenticationStatusByUser.set(
        userId,
        new BehaviorSubject<AuthenticationStatus>(AuthenticationStatus.LoggedOut),
      );
    }
    authenticationStatusByUser.get(userId)!.next(AuthenticationStatus.Unlocked);
  }

  function setUserLocked(userId: UserId) {
    if (!authenticationStatusByUser.has(userId)) {
      authenticationStatusByUser.set(
        userId,
        new BehaviorSubject<AuthenticationStatus>(AuthenticationStatus.LoggedOut),
      );
    }
    authenticationStatusByUser.get(userId)!.next(AuthenticationStatus.Locked);
  }

  function setWebPushConnectorForUser(userId: UserId) {
    const webPushConnector = mock<WebPushConnector>();
    const notificationSubject = new Subject<NotificationResponse>();
    webPushConnector.notifications$ = notificationSubject.asObservable();
    if (!webPushSupportStatusByUser.has(userId)) {
      webPushSupportStatusByUser.set(
        userId,
        new BehaviorSubject({ type: "supported", service: webPushConnector } as any),
      );
    } else {
      webPushSupportStatusByUser
        .get(userId)!
        .next({ type: "supported", service: webPushConnector } as any);
    }
    return { webPushConnector, notificationSubject } as const;
  }

  it("merges notification streams from multiple users", async () => {
    addUserAccount(mockUserId1);
    addUserAccount(mockUserId2);
    setUserUnlocked(mockUserId1);
    setUserUnlocked(mockUserId2);
    setActiveUserAccount(mockUserId1);

    const user1WebPush = setWebPushConnectorForUser(mockUserId1);
    const user2WebPush = setWebPushConnectorForUser(mockUserId2);

    const twoNotifications = firstValueFrom(
      defaultServerNotificationsService.notifications$.pipe(bufferCount(2)),
    );

    user1WebPush.notificationSubject.next(
      new NotificationResponse({ type: NotificationType.SyncFolderCreate }),
    );
    user2WebPush.notificationSubject.next(
      new NotificationResponse({ type: NotificationType.SyncFolderDelete }),
    );

    const notificationResults = await twoNotifications;
    expect(notificationResults.length).toBe(2);
    const [notification1, userA] = notificationResults[0];
    const [notification2, userB] = notificationResults[1];
    expect(userA === mockUserId1 || userA === mockUserId2).toBe(true);
    expect(userB === mockUserId1 || userB === mockUserId2).toBe(true);
    expect([NotificationType.SyncFolderCreate, NotificationType.SyncFolderDelete]).toContain(
      notification1.type,
    );
    expect([NotificationType.SyncFolderCreate, NotificationType.SyncFolderDelete]).toContain(
      notification2.type,
    );
  });

  it("processes allowed multi-user notifications for non-active users (AuthRequest)", async () => {
    addUserAccount(mockUserId1);
    addUserAccount(mockUserId2);
    setUserUnlocked(mockUserId1);
    setUserUnlocked(mockUserId2);
    setActiveUserAccount(mockUserId1);

    // Force SignalR path for user2
    if (!webPushSupportStatusByUser.has(mockUserId2)) {
      webPushSupportStatusByUser.set(
        mockUserId2,
        new BehaviorSubject({ type: "not-supported", reason: "test" } as any),
      );
    } else {
      webPushSupportStatusByUser
        .get(mockUserId2)!
        .next({ type: "not-supported", reason: "test" } as any);
    }

    authRequestAnsweringService.receivedPendingAuthRequest.mockResolvedValue(undefined as any);

    const subscription = defaultServerNotificationsService.startListening();

    // Emit via SignalR connect$ for user2
    connectionSubjectByUser.get(mockUserId2)!.next({
      type: "ReceiveMessage",
      message: new NotificationResponse({
        type: NotificationType.AuthRequest,
        payload: { id: "auth-id-2", userId: mockUserId2 },
      }),
    });

    // allow async queue to drain
    await new Promise((resolve) => setTimeout(resolve, 0));

    // When authRequestAnsweringService.receivedPendingAuthRequest exists (Extension/Desktop),
    // only that method is called. messagingService.send is only called for Web (NoopAuthRequestAnsweringService).
    expect(authRequestAnsweringService.receivedPendingAuthRequest).toHaveBeenCalledWith(
      mockUserId2,
      "auth-id-2",
    );
    expect(messagingService.send).not.toHaveBeenCalled();

    subscription.unsubscribe();
  });

  it("does not process notifications that refresh the page in view for non-active users", async () => {
    addUserAccount(mockUserId1);
    addUserAccount(mockUserId2);
    setUserUnlocked(mockUserId1);
    setUserUnlocked(mockUserId2);
    setActiveUserAccount(mockUserId1);

    const user1WebPush = setWebPushConnectorForUser(mockUserId1);
    const user2WebPush = setWebPushConnectorForUser(mockUserId2);

    const subscription = defaultServerNotificationsService.startListening();

    // Bank account verifications only refresh the page in view, which shows the active account
    user2WebPush.notificationSubject.next(
      new NotificationResponse({
        type: NotificationType.OrganizationBankAccountVerified,
        payload: { OrganizationId: "org-2" },
      }),
    );
    user1WebPush.notificationSubject.next(
      new NotificationResponse({
        type: NotificationType.OrganizationBankAccountVerified,
        payload: { OrganizationId: "org-1" },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messagingService.send).toHaveBeenCalledTimes(1);
    expect(messagingService.send).toHaveBeenCalledWith("organizationBankAccountVerified", {
      organizationId: "org-1",
    });

    subscription.unsubscribe();
  });

  describe("vault sync notifications for a non-active user", () => {
    let user2WebPush: ReturnType<typeof setWebPushConnectorForUser>;
    let subscription: Subscription;

    const emitForUser2 = async (notification: NotificationResponse) => {
      user2WebPush.notificationSubject.next(notification);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const startListening = (user2Unlocked: boolean) => {
      addUserAccount(mockUserId1);
      addUserAccount(mockUserId2);
      setUserUnlocked(mockUserId1);
      if (user2Unlocked) {
        setUserUnlocked(mockUserId2);
      } else {
        setUserLocked(mockUserId2);
      }
      setActiveUserAccount(mockUserId1);
      setWebPushConnectorForUser(mockUserId1);
      user2WebPush = setWebPushConnectorForUser(mockUserId2);
      subscription = defaultServerNotificationsService.startListening();
    };

    afterEach(() => subscription.unsubscribe());

    it("processes cipher and folder changes for that user when it is unlocked", async () => {
      startListening(true);

      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncCipherUpdate,
          payload: { Id: "cipher-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncCipherDelete,
          payload: { Id: "cipher-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncFolderCreate,
          payload: { Id: "folder-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncFolderDelete,
          payload: { Id: "folder-id", UserId: mockUserId2 },
        }),
      );

      expect(syncService.syncUpsertCipher).toHaveBeenCalledWith(
        expect.anything(),
        true,
        mockUserId2,
      );
      expect(syncService.syncDeleteCipher).toHaveBeenCalledWith(expect.anything(), mockUserId2);
      expect(syncService.syncUpsertFolder).toHaveBeenCalledWith(
        expect.anything(),
        false,
        mockUserId2,
      );
      expect(syncService.syncDeleteFolder).toHaveBeenCalledWith(expect.anything(), mockUserId2);
    });

    it.each([
      [NotificationType.SyncVault, false],
      [NotificationType.SyncCiphers, false],
      [NotificationType.SyncSettings, false],
      [NotificationType.SyncOrganizations, true],
      [NotificationType.SyncOrgKeys, true],
    ])(
      "runs a full sync of that user for notification type %s when it is unlocked",
      async (type, forceSync) => {
        startListening(true);
        syncService.fullSync.mockClear();

        await emitForUser2(new NotificationResponse({ type }));

        expect(syncService.fullSync).toHaveBeenCalledWith(forceSync, { userId: mockUserId2 });
      },
    );

    it("runs a full sync of that user for a key rotation logout when it is unlocked", async () => {
      startListening(true);
      syncService.fullSync.mockClear();

      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.LogOut,
          payload: { UserId: mockUserId2, Reason: PushNotificationLogOutReasonType.KeyRotation },
        }),
      );

      expect(userLogoutCallback).not.toHaveBeenCalled();
      expect(syncService.fullSync).toHaveBeenCalledWith(true, { userId: mockUserId2 });
    });

    it("processes send changes for that user when it is unlocked", async () => {
      startListening(true);

      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncSendCreate,
          payload: { Id: "send-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncSendUpdate,
          payload: { Id: "send-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncSendDelete,
          payload: { Id: "send-id", UserId: mockUserId2 },
        }),
      );

      expect(syncService.syncUpsertSend).toHaveBeenCalledWith(
        expect.anything(),
        false,
        mockUserId2,
      );
      expect(syncService.syncUpsertSend).toHaveBeenCalledWith(expect.anything(), true, mockUserId2);
      expect(syncService.syncDeleteSend).toHaveBeenCalledWith(expect.anything(), mockUserId2);
    });

    it.each([
      NotificationType.SyncPolicy,
      NotificationType.SyncOrganizationStatusChanged,
      NotificationType.SyncOrganizationCollectionSettingChanged,
    ])(
      "forces a full sync of that user for notification type %s when it is unlocked",
      async (type) => {
        startListening(true);
        syncService.fullSync.mockClear();

        await emitForUser2(new NotificationResponse({ type, payload: {} }));

        expect(syncService.fullSync).toHaveBeenCalledWith(true, { userId: mockUserId2 });
      },
    );

    it.each([true, false])(
      "updates the premium status of that user (unlocked: %s)",
      async (user2Unlocked) => {
        startListening(user2Unlocked);
        billingAccountProfileStateService.hasPremiumFromAnyOrganization$.mockReturnValue(
          new BehaviorSubject(false),
        );

        await emitForUser2(
          new NotificationResponse({
            type: NotificationType.PremiumStatusChanged,
            payload: { UserId: mockUserId2, Premium: true },
          }),
        );

        expect(
          billingAccountProfileStateService.hasPremiumFromAnyOrganization$,
        ).toHaveBeenCalledWith(mockUserId2);
        expect(billingAccountProfileStateService.setHasPremium).toHaveBeenCalledWith(
          true,
          false,
          mockUserId2,
        );
      },
    );

    it.each([true, false])(
      "logs out that user alone for a logout notification (unlocked: %s)",
      async (user2Unlocked) => {
        startListening(user2Unlocked);

        await emitForUser2(
          new NotificationResponse({
            type: NotificationType.LogOut,
            payload: { UserId: mockUserId2 },
          }),
        );

        expect(userLogoutCallback).toHaveBeenCalledTimes(1);
        expect(userLogoutCallback).toHaveBeenCalledWith("logoutNotification", mockUserId2);
      },
    );

    it("skips a KDF change logout for that user without logging it out", async () => {
      startListening(false);

      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.LogOut,
          payload: { UserId: mockUserId2, Reason: PushNotificationLogOutReasonType.KdfChange },
        }),
      );

      expect(userLogoutCallback).not.toHaveBeenCalled();
    });

    it("ignores a notification whose payload names another user", async () => {
      startListening(true);

      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.LogOut,
          payload: { UserId: mockUserId1 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncSendDelete,
          payload: { Id: "send-id", UserId: mockUserId1 },
        }),
      );

      expect(userLogoutCallback).not.toHaveBeenCalled();
      expect(syncService.syncDeleteSend).not.toHaveBeenCalled();
    });

    it("drops sync notifications while that user is locked", async () => {
      startListening(false);

      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncCipherUpdate,
          payload: { Id: "cipher-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(new NotificationResponse({ type: NotificationType.SyncVault }));
      await emitForUser2(new NotificationResponse({ type: NotificationType.SyncPolicy }));
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncSendCreate,
          payload: { Id: "send-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncSendDelete,
          payload: { Id: "send-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.LogOut,
          payload: { UserId: mockUserId2, Reason: PushNotificationLogOutReasonType.KeyRotation },
        }),
      );

      expect(syncService.syncUpsertCipher).not.toHaveBeenCalled();
      expect(syncService.syncUpsertSend).not.toHaveBeenCalled();
      expect(syncService.syncDeleteSend).not.toHaveBeenCalled();
      expect(userLogoutCallback).not.toHaveBeenCalled();
      expect(syncService.fullSync).not.toHaveBeenCalledWith(expect.anything(), {
        userId: mockUserId2,
      });
      // The active user's catch-up sync on connect is unaffected
      expect(syncService.fullSync).toHaveBeenCalledWith(false);
    });
  });
  describe("without processForNonActiveAccounts (default)", () => {
    let user2WebPush: ReturnType<typeof setWebPushConnectorForUser>;
    let subscription: Subscription;

    const emitForUser2 = async (notification: NotificationResponse) => {
      user2WebPush.notificationSubject.next(notification);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    beforeEach(() => {
      defaultServerNotificationsService = createService();
      addUserAccount(mockUserId1);
      addUserAccount(mockUserId2);
      setUserUnlocked(mockUserId1);
      setUserUnlocked(mockUserId2);
      setActiveUserAccount(mockUserId1);
      setWebPushConnectorForUser(mockUserId1);
      user2WebPush = setWebPushConnectorForUser(mockUserId2);
      billingAccountProfileStateService.hasPremiumFromAnyOrganization$.mockReturnValue(
        new BehaviorSubject(false),
      );
      subscription = defaultServerNotificationsService.startListening();
    });

    afterEach(() => subscription.unsubscribe());

    it("drops sync, send, policy, premium and logout notifications of an unlocked non-active user", async () => {
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncCipherUpdate,
          payload: { Id: "cipher-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncFolderCreate,
          payload: { Id: "folder-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(new NotificationResponse({ type: NotificationType.SyncVault }));
      await emitForUser2(new NotificationResponse({ type: NotificationType.SyncPolicy }));
      await emitForUser2(
        new NotificationResponse({ type: NotificationType.SyncOrganizationStatusChanged }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncSendCreate,
          payload: { Id: "send-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.SyncSendDelete,
          payload: { Id: "send-id", UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.PremiumStatusChanged,
          payload: { UserId: mockUserId2, Premium: true },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.LogOut,
          payload: { UserId: mockUserId2 },
        }),
      );
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.LogOut,
          payload: { UserId: mockUserId2, Reason: PushNotificationLogOutReasonType.KeyRotation },
        }),
      );

      expect(syncService.syncUpsertCipher).not.toHaveBeenCalled();
      expect(syncService.syncUpsertFolder).not.toHaveBeenCalled();
      expect(syncService.syncUpsertSend).not.toHaveBeenCalled();
      expect(syncService.syncDeleteSend).not.toHaveBeenCalled();
      expect(billingAccountProfileStateService.setHasPremium).not.toHaveBeenCalled();
      expect(userLogoutCallback).not.toHaveBeenCalled();
      // Only the active user's catch-up sync on connect; none for the non-active user
      expect(syncService.fullSync.mock.calls).toEqual([[false]]);
    });

    it("still processes the allowed multi-user types for a non-active user", async () => {
      await emitForUser2(
        new NotificationResponse({
          type: NotificationType.AuthRequest,
          payload: { id: "auth-id-2", userId: mockUserId2 },
        }),
      );

      expect(authRequestAnsweringService.receivedPendingAuthRequest).toHaveBeenCalledWith(
        mockUserId2,
        "auth-id-2",
      );
    });

    it("processes the active user's notifications without naming the user, as upstream", async () => {
      const user1WebPush = setWebPushConnectorForUser(mockUserId1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      syncService.fullSync.mockClear();

      user1WebPush.notificationSubject.next(
        new NotificationResponse({ type: NotificationType.SyncPolicy }),
      );
      user1WebPush.notificationSubject.next(
        new NotificationResponse({
          type: NotificationType.SyncSendUpdate,
          payload: { Id: "send-id", UserId: mockUserId1 },
        }),
      );
      user1WebPush.notificationSubject.next(
        new NotificationResponse({
          type: NotificationType.SyncSendDelete,
          payload: { Id: "send-id", UserId: mockUserId1 },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(syncService.fullSync).toHaveBeenCalledWith(true);
      expect(syncService.syncUpsertSend).toHaveBeenCalledWith(expect.anything(), true);
      expect(syncService.syncUpsertSend.mock.calls[0]).toHaveLength(2);
      expect(syncService.syncDeleteSend.mock.calls[0]).toHaveLength(1);
    });
  });
});
