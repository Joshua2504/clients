import {
  BehaviorSubject,
  catchError,
  distinctUntilChanged,
  EMPTY,
  filter,
  firstValueFrom,
  map,
  mergeMap,
  Observable,
  share,
  switchMap,
  tap,
} from "rxjs";

import { AutomaticUserConfirmationService } from "@bitwarden/auto-confirm";
import { PerfTrackGroup } from "@bitwarden/logging";

import { AccountInfo, AccountService } from "../../../auth/abstractions/account.service";
import { AuthRequestAnsweringService } from "../../../auth/abstractions/auth-request-answering/auth-request-answering.service.abstraction";
import { AuthService } from "../../../auth/abstractions/auth.service";
import { AuthenticationStatus } from "../../../auth/enums/authentication-status";
import { LogoutReason } from "../../../auth/logout";
import { BillingAccountProfileStateService } from "../../../billing/abstractions/account/billing-account-profile-state.service";
import { NotificationType, PushNotificationLogOutReasonType } from "../../../enums";
import {
  LogOutNotification,
  NotificationResponse,
  PremiumStatusChangedNotification,
  SyncCipherNotification,
  SyncFolderNotification,
  SyncSendNotification,
} from "../../../models/response/notification.response";
import { UserId } from "../../../types/guid";
import { SyncService } from "../../../vault/abstractions/sync/sync.service.abstraction";
import { AppIdService } from "../../abstractions/app-id.service";
import { EnvironmentService } from "../../abstractions/environment.service";
import { LogService } from "../../abstractions/log.service";
import { MessagingService } from "../../abstractions/messaging.service";
import { trackedMerge } from "../../misc";
import { supportSwitch } from "../../misc/support-status";
import { ServerNotificationsService } from "../server-notifications.service";

import { ReceiveMessage, SignalRConnectionService } from "./signalr-connection.service";
import { WebPushConnectionService } from "./webpush-connection.service";

export const DISABLED_NOTIFICATIONS_URL = "http://-";

export const AllowedMultiUserNotificationTypes = new Set<NotificationType>([
  NotificationType.AuthRequest,
  NotificationType.AutoConfirmMember,
]);

/** Options for {@link DefaultServerNotificationsService}. */
export type DefaultServerNotificationsServiceOptions = {
  /**
   * Whether notifications for an account that is not active are processed beyond
   * {@link AllowedMultiUserNotificationTypes}: the types in
   * {@link UnlockedMultiUserNotificationTypes} while that account is unlocked, the types in
   * {@link AnyLockStateMultiUserNotificationTypes} and logouts whatever its lock state, and the
   * catch-up sync when that account's connection is established.
   * Off, only the active account's notifications are processed, as without this option.
   * @default false
   */
  processForNonActiveAccounts?: boolean;
};

/**
 * With {@link DefaultServerNotificationsServiceOptions.processForNonActiveAccounts}, notification
 * types processed for a non-active account whatever its lock state: their handlers act on that
 * account by id and do not decrypt anything.
 * {@link NotificationType.PremiumStatusChanged} writes the account's own premium flags.
 */
export const AnyLockStateMultiUserNotificationTypes = new Set<NotificationType>([
  NotificationType.PremiumStatusChanged,
]);

/**
 * With {@link DefaultServerNotificationsServiceOptions.processForNonActiveAccounts}, sync
 * notification types that are also processed for a non-active account, as long as that
 * account is unlocked. Their handlers sync the account, which needs its keys (the crypto sync
 * handler, send decryption); a locked account cannot do that and syncs on unlock instead.
 * {@link NotificationType.LogOut} is decided by its reason, see `processesForNonActiveUser`.
 */
export const UnlockedMultiUserNotificationTypes = new Set<NotificationType>([
  NotificationType.SyncCipherCreate,
  NotificationType.SyncCipherUpdate,
  NotificationType.SyncCipherDelete,
  NotificationType.SyncLoginDelete,
  NotificationType.SyncFolderCreate,
  NotificationType.SyncFolderUpdate,
  NotificationType.SyncFolderDelete,
  NotificationType.SyncVault,
  NotificationType.SyncCiphers,
  NotificationType.SyncSettings,
  NotificationType.SyncOrganizations,
  NotificationType.SyncOrgKeys,
  NotificationType.SyncSendCreate,
  NotificationType.SyncSendUpdate,
  NotificationType.SyncSendDelete,
  NotificationType.SyncOrganizationStatusChanged,
  NotificationType.SyncOrganizationCollectionSettingChanged,
  NotificationType.SyncPolicy,
]);

export class DefaultServerNotificationsService implements ServerNotificationsService {
  notifications$: Observable<readonly [NotificationResponse, UserId]>;

  private activitySubject = new BehaviorSubject<"active" | "inactive">("active");

  constructor(
    private readonly logService: LogService,
    private syncService: SyncService,
    private appIdService: AppIdService,
    private environmentService: EnvironmentService,
    private logoutCallback: (logoutReason: LogoutReason, userId: UserId) => Promise<void>,
    private messagingService: MessagingService,
    private readonly accountService: AccountService,
    private readonly signalRConnectionService: SignalRConnectionService,
    private readonly authService: AuthService,
    private readonly webPushConnectionService: WebPushConnectionService,
    private readonly authRequestAnsweringService: AuthRequestAnsweringService,
    private autoConfirmService: AutomaticUserConfirmationService,
    private readonly billingAccountProfileStateService: BillingAccountProfileStateService,
    private readonly options: DefaultServerNotificationsServiceOptions = {},
  ) {
    this.notifications$ = this.accountService.accounts$.pipe(
      map((accounts: Record<UserId, AccountInfo>): Set<UserId> => {
        const validUserIds = Object.entries(accounts)
          .filter(([_, accountInfo]) => accountInfo.email !== "" || accountInfo.emailVerified)
          .map(([userId, _]) => userId as UserId);
        return new Set(validUserIds);
      }),
      trackedMerge((id: UserId) => {
        return this.userNotifications$(id as UserId).pipe(
          map((notification: NotificationResponse) => [notification, id as UserId] as const),
        );
      }),
      share(), // Multiple subscribers should only create a single connection to the server
    );
  }

  /**
   * Retrieves a stream of push server notifications for the given user.
   * @param userId The user id of the user to get the push server notifications for.
   */
  private userNotifications$(userId: UserId) {
    return this.environmentService.getEnvironment$(userId).pipe(
      map((env) => env.getNotificationsUrl()),
      distinctUntilChanged(),
      switchMap((notificationsUrl) => {
        if (notificationsUrl === DISABLED_NOTIFICATIONS_URL) {
          return EMPTY;
        }

        return this.userNotificationsHelper$(userId, notificationsUrl);
      }),
    );
  }

  private userNotificationsHelper$(userId: UserId, notificationsUrl: string) {
    return this.hasAccessToken$(userId).pipe(
      switchMap((hasAccessToken) => {
        if (!hasAccessToken) {
          return EMPTY;
        }

        return this.activitySubject;
      }),
      switchMap((activityStatus) => {
        if (activityStatus === "inactive") {
          return EMPTY;
        }

        return this.webPushConnectionService.supportStatus$(userId);
      }),
      supportSwitch({
        supported: (service) => {
          this.logService.info("Using WebPush for server notifications");
          // Catch up on anything missed before this stream was (re)established
          // (e.g. an MV3 service worker suspension dropping earlier deliveries).
          void this.syncOnConnected(userId);
          return service.notifications$.pipe(
            catchError((err: unknown) => {
              this.logService.warning("Issue with web push, falling back to SignalR", err);
              return this.connectSignalR$(userId, notificationsUrl);
            }),
          );
        },
        notSupported: () => {
          this.logService.info("Using SignalR for server notifications");
          return this.connectSignalR$(userId, notificationsUrl);
        },
      }),
    );
  }

  private connectSignalR$(userId: UserId, notificationsUrl: string) {
    return this.signalRConnectionService.connect$(userId, notificationsUrl).pipe(
      tap((n) => {
        if (n.type === "Connected") {
          void this.syncOnConnected(userId);
        }
      }),
      filter((n) => n.type === "ReceiveMessage"),
      map((n) => (n as ReceiveMessage).message),
    );
  }

  private async syncOnConnected(userId: UserId) {
    try {
      const activeAccountId = await firstValueFrom(
        this.accountService.activeAccount$.pipe(map((a) => a?.id)),
      );
      if (activeAccountId !== userId) {
        // A locked non-active account cannot decrypt; it syncs on unlock instead.
        if (!this.options.processForNonActiveAccounts || !(await this.isUnlocked(userId))) {
          return;
        }
        await this.syncService.fullSync(false, { userId });
        return;
      }
      await this.syncService.fullSync(false);
    } catch (e) {
      this.logService.error("Failed to catch-up sync after notifications connected", e);
    }
  }

  private async isUnlocked(userId: UserId): Promise<boolean> {
    const authStatus = await firstValueFrom(this.authService.authStatusFor$(userId));
    return authStatus === AuthenticationStatus.Unlocked;
  }

  /**
   * Whether a notification for a non-active account is processed: the allowed multi-user types
   * always. With `processForNonActiveAccounts` also the any-lock-state types, the unlocked types
   * only while that account is unlocked, and a logout always, except a key rotation, which syncs
   * and so needs the account unlocked. Bank account verifications only refresh the page in view,
   * which shows the active account.
   */
  private async processesForNonActiveUser(
    notification: NotificationResponse,
    userId: UserId,
  ): Promise<boolean> {
    if (AllowedMultiUserNotificationTypes.has(notification.type)) {
      return true;
    }
    if (!this.options.processForNonActiveAccounts) {
      return false;
    }
    if (AnyLockStateMultiUserNotificationTypes.has(notification.type)) {
      return true;
    }
    if (notification.type === NotificationType.LogOut) {
      return (
        (notification.payload as LogOutNotification)?.reason !==
          PushNotificationLogOutReasonType.KeyRotation || (await this.isUnlocked(userId))
      );
    }
    if (!UnlockedMultiUserNotificationTypes.has(notification.type)) {
      return false;
    }
    return await this.isUnlocked(userId);
  }

  private hasAccessToken$(userId: UserId) {
    return this.authService.authStatusFor$(userId).pipe(
      map(
        (authStatus) =>
          authStatus === AuthenticationStatus.Locked ||
          authStatus === AuthenticationStatus.Unlocked,
      ),
      distinctUntilChanged(),
    );
  }

  /**
   * Runs a full sync of `userId`. Without `processForNonActiveAccounts` only the active account's
   * notifications get here, and it syncs the active account as it did before that option existed.
   */
  private fullSyncFor(forceSync: boolean, userId: UserId): Promise<boolean> {
    return this.options.processForNonActiveAccounts
      ? this.syncService.fullSync(forceSync, { userId })
      : this.syncService.fullSync(forceSync);
  }

  private async processNotification(notification: NotificationResponse, userId: UserId) {
    const appId = await this.appIdService.getAppId();
    if (notification == null || notification.contextId === appId) {
      return;
    }

    const payloadUserId = notification.payload?.userId || notification.payload?.UserId;
    if (payloadUserId != null && payloadUserId !== userId) {
      return;
    }

    const activeAccountId = await firstValueFrom(
      this.accountService.activeAccount$.pipe(map((a) => a?.id)),
    );

    const notificationIsForActiveUser = activeAccountId === userId;
    if (
      !notificationIsForActiveUser &&
      !(await this.processesForNonActiveUser(notification, userId))
    ) {
      return;
    }

    switch (notification.type) {
      case NotificationType.SyncCipherCreate:
      case NotificationType.SyncCipherUpdate:
        await this.syncService.syncUpsertCipher(
          notification.payload as SyncCipherNotification,
          notification.type === NotificationType.SyncCipherUpdate,
          userId,
        );
        break;
      case NotificationType.SyncCipherDelete:
      case NotificationType.SyncLoginDelete:
        await this.syncService.syncDeleteCipher(
          notification.payload as SyncCipherNotification,
          userId,
        );
        break;
      case NotificationType.SyncFolderCreate:
      case NotificationType.SyncFolderUpdate:
        await this.syncService.syncUpsertFolder(
          notification.payload as SyncFolderNotification,
          notification.type === NotificationType.SyncFolderUpdate,
          userId,
        );
        break;
      case NotificationType.SyncFolderDelete:
        await this.syncService.syncDeleteFolder(
          notification.payload as SyncFolderNotification,
          userId,
        );
        break;
      case NotificationType.SyncVault:
      case NotificationType.SyncCiphers:
      case NotificationType.SyncSettings:
        await this.fullSyncFor(false, userId);
        break;
      case NotificationType.SyncOrganizations:
        // An organization update may not have bumped the user's account revision date, so force a sync
        await this.fullSyncFor(true, userId);
        break;
      case NotificationType.SyncOrgKeys:
        await this.fullSyncFor(true, userId);
        this.activitySubject.next("inactive"); // Force a disconnect
        this.activitySubject.next("active"); // Allow a reconnect
        break;
      case NotificationType.LogOut: {
        this.logService.info("[Notifications Service] Received logout notification");

        const logOutNotification = notification.payload as LogOutNotification;
        if (logOutNotification.reason === PushNotificationLogOutReasonType.KdfChange) {
          this.logService.info(
            "[Notifications Service] Skipping logout due to no logout KDF change",
          );
        } else if (logOutNotification.reason === PushNotificationLogOutReasonType.KeyRotation) {
          this.logService.info(
            "[Notifications Service] Skipping logout due to no logout key rotation. Performing full sync.",
          );
          await this.fullSyncFor(true, userId);
        } else {
          await this.logoutCallback("logoutNotification", userId);
        }
        break;
      }
      case NotificationType.SyncSendCreate:
      case NotificationType.SyncSendUpdate:
        if (this.options.processForNonActiveAccounts) {
          await this.syncService.syncUpsertSend(
            notification.payload as SyncSendNotification,
            notification.type === NotificationType.SyncSendUpdate,
            userId,
          );
        } else {
          await this.syncService.syncUpsertSend(
            notification.payload as SyncSendNotification,
            notification.type === NotificationType.SyncSendUpdate,
          );
        }
        break;
      case NotificationType.SyncSendDelete:
        if (this.options.processForNonActiveAccounts) {
          await this.syncService.syncDeleteSend(
            notification.payload as SyncSendNotification,
            userId,
          );
        } else {
          await this.syncService.syncDeleteSend(notification.payload as SyncSendNotification);
        }
        break;
      case NotificationType.AuthRequest: {
        // Only Extension and Desktop implement the AuthRequestAnsweringService
        if (this.authRequestAnsweringService.receivedPendingAuthRequest) {
          try {
            await this.authRequestAnsweringService.receivedPendingAuthRequest(
              notification.payload.userId,
              notification.payload.id,
            );
          } catch (error) {
            this.logService.error(`Failed to process auth request notification: ${error}`);
          }
        } else {
          // This call is necessary for Web, which uses a NoopAuthRequestAnsweringService
          // that does not have a receivedPendingAuthRequest() method
          this.messagingService.send("openLoginApproval", {
            // Include the authRequestId so the DeviceManagementComponent can upsert the correct device.
            // This will only matter if the user is on the /device-management screen when the auth request is received.
            notificationId: notification.payload.id,
          });
        }
        break;
      }
      case NotificationType.SyncOrganizationStatusChanged:
        await this.fullSyncFor(true, userId);
        break;
      case NotificationType.SyncOrganizationCollectionSettingChanged:
        await this.fullSyncFor(true, userId);
        break;
      case NotificationType.OrganizationBankAccountVerified:
        this.messagingService.send("organizationBankAccountVerified", {
          organizationId: notification.payload.organizationId,
        });
        break;
      case NotificationType.ProviderBankAccountVerified:
        this.messagingService.send("providerBankAccountVerified", {
          providerId: notification.payload.providerId,
          adminId: notification.payload.adminId,
        });
        break;
      case NotificationType.SyncPolicy:
        // TODO (PM-38875): this should compare against local data and only fetch the specific
        // policy if required. For now just force a sync.
        await this.fullSyncFor(true, userId);
        break;
      case NotificationType.AutoConfirmMember:
        await this.autoConfirmService.autoConfirmUser(
          notification.payload.userId,
          notification.payload.targetUserId,
          notification.payload.targetOrganizationUserId,
          notification.payload.organizationId,
        );
        break;
      case NotificationType.PremiumStatusChanged: {
        const premiumPayload = notification.payload as PremiumStatusChangedNotification;
        // The payload's user, when it names one, is `userId` (checked above).
        const premiumUserId = this.options.processForNonActiveAccounts
          ? userId
          : (premiumPayload.userId as UserId);
        const hasPremiumFromAnyOrganization = await firstValueFrom(
          this.billingAccountProfileStateService.hasPremiumFromAnyOrganization$(premiumUserId),
        );
        await this.billingAccountProfileStateService.setHasPremium(
          premiumPayload.premium,
          hasPremiumFromAnyOrganization,
          premiumUserId,
        );
        break;
      }
      default:
        break;
    }
  }

  startListening() {
    return this.notifications$
      .pipe(
        mergeMap(async ([notification, userId]) => {
          // Instant event per incoming notification, e.g. "SyncCipherUpdate"
          this.logService
            .startMeasurement(
              PerfTrackGroup.Notifications,
              "Incoming",
              NotificationType[notification.type],
            )
            .finishWithDefaultTime();

          try {
            await this.processNotification(notification, userId);
          } catch (err: unknown) {
            this.logService.error(
              `Problem processing notification of type ${notification.type}`,
              err,
            );
          }
        }),
      )
      .subscribe({
        error: (err: unknown) =>
          this.logService.error(
            "Fatal error in server notifications$ observable, notifications won't be recieved anymore.",
            err,
          ),
      });
  }

  reconnectFromActivity(): void {
    this.activitySubject.next("active");
  }

  disconnectFromInactivity(): void {
    this.activitySubject.next("inactive");
  }
}
