import { AccountCipherRef } from "@bitwarden/common/autofill/types/account-cipher";
import { NeverDomains } from "@bitwarden/common/models/domain/domain-service";
import { ServerConfig } from "@bitwarden/common/platform/abstractions/config/server-config";
import { CommandDefinition } from "@bitwarden/common/platform/messaging";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FolderView } from "@bitwarden/common/vault/models/view/folder.view";

import { AccountView, CollectionView, OrgView } from "../../content/components/common-types";
import { NotificationType } from "../../enums/notification-type.enum";
import AutofillPageDetails from "../../models/autofill-page-details";

/**
 * Generic notification queue message structure.
 * All notification types use this structure with type-specific data.
 */
export interface NotificationQueueMessage<T, D> {
  domain: string;
  tab: chrome.tabs.Tab;
  launchTimestamp: number;
  expires: Date;
  wasVaultLocked: boolean;
  /**
   * The account the notification acts for, fixed when it is queued: the account a new login is
   * saved to, the account that owns the cipher to update, the account that owns the at-risk
   * task, or the locked account an unlock prompt is for. Everything a queued notification reads
   * or writes belongs to this account, never to whichever account is active when the user acts.
   *
   * A save prompt may move it to another account the user picks. A change prompt with ciphers of
   * several accounts acts for the account of the picked cipher (see
   * {@link ChangePasswordNotificationData.cipherRefs}).
   */
  userId: UserId;
  type: T;
  data: D;
}

// Notification data type definitions
export type AddLoginNotificationData = {
  username: string;
  password: string;
  uri: string;
};

export type ChangePasswordNotificationData = {
  cipherIds: CipherView["id"][];
  /**
   * The ciphers of `cipherIds`, each with the account that owns it. A cipher id alone does not
   * name an account: a shared item has the same id in every member's vault.
   */
  cipherRefs: AccountCipherRef[];
  newPassword: string;
};

export type UnlockVaultNotificationData = never;

/**
 * Queue-time data for at-risk password notifications.
 * Field semantics mirror {@link AtRiskPasswordNotificationParams}.
 */
export type AtRiskPasswordNotificationData = {
  organizationName: string;
  hasPasswordChangeUri: boolean;
  /** The account the task belongs to. Absent while the active account alone serves autofill. */
  accountLabel?: string;
};

// Notification queue message types using generic pattern
export type AddLoginQueueMessage = NotificationQueueMessage<
  typeof NotificationType.AddLogin,
  AddLoginNotificationData
>;

export type AddChangePasswordNotificationQueueMessage = NotificationQueueMessage<
  typeof NotificationType.ChangePassword,
  ChangePasswordNotificationData
>;

export type AddUnlockVaultQueueMessage = NotificationQueueMessage<
  typeof NotificationType.UnlockVault,
  UnlockVaultNotificationData
>;

export type AtRiskPasswordQueueMessage = NotificationQueueMessage<
  typeof NotificationType.AtRiskPassword,
  AtRiskPasswordNotificationData
>;

export type NotificationQueueMessageItem =
  | AddLoginQueueMessage
  | AddChangePasswordNotificationQueueMessage
  | AddUnlockVaultQueueMessage
  | AtRiskPasswordQueueMessage;

/**
 * Key under which a retry carries the sender whose tab receives the retried autofill.
 *
 * Symbol-keyed so the sender cannot leave this context: serializing a message out drops the key,
 * so a retry that crosses a boundary arrives with no target rather than a forged one, and without
 * disclosing the tab it named.
 *
 * It is an ordinary enumerable property, so it does survive `{ ...commandToRetry }` within this
 * context. That is deliberate — code here already holds the sender. Judging whether a *message*
 * arrived from elsewhere stays `isExternalMessage`'s job.
 */
export const RETRY_SENDER = Symbol("retrySender");

export type LockedVaultPendingNotificationsData = {
  /**
   * The command to replay, and the tab to replay it against. Naming a tab makes this a
   * capability rather than a notification, so only the background may author one.
   */
  commandToRetry: {
    message: {
      command: string;
      contextMenuOnClickData?: chrome.contextMenus.OnClickData;
      folder?: string;
      edit?: boolean;
    };
    [RETRY_SENDER]?: chrome.runtime.MessageSender;
  };
  /** Selects the consumer that replays the command. The others ignore it. */
  target: string;
};

/**
 * Payload shared by both locked-vault retry commands.
 *
 * WARNING: never deliver this over chrome messaging. Serialization drops the
 * {@link RETRY_SENDER} naming the tab to replay against, and discloses the rest of the retry to
 * every context that can read the message.
 *
 * `data` is shared with the other consumers of the same emission, not cloned per consumer. Treat
 * it as read-only.
 */
export type LockedVaultRetryMessage = { data: LockedVaultPendingNotificationsData };

/** Queues a command to replay once the vault is unlocked. */
export const ADD_TO_LOCKED_VAULT_PENDING_NOTIFICATIONS =
  new CommandDefinition<LockedVaultRetryMessage>("addToLockedVaultPendingNotifications");

/** Replays the queued command, now that the vault is unlocked. */
export const RETRY_WHEN_UNLOCK_COMPLETED = new CommandDefinition<LockedVaultRetryMessage>(
  "unlockCompleted",
);

export type AdjustNotificationBarMessageData = {
  height: number;
};

export type AddLoginMessageData = {
  username: string;
  password: string;
  url: string;
};

export type UnlockVaultMessageData = {
  skipNotification?: boolean;
};

/**
 * @todo Extend generics to this type, see NotificationQueueMessage
 * - use new `data` types as generic
 * - eliminate optional status of properties as needed per Notification Type
 */
export type NotificationBackgroundExtensionMessage = {
  [key: string]: any;
  command: string;
  data?: Partial<AdjustNotificationBarMessageData> & Partial<UnlockVaultMessageData>;
  folder?: string;
  edit?: boolean;
  details?: AutofillPageDetails;
  tab?: chrome.tabs.Tab;
  sender?: string;
  notificationType?: string;
  organizationId?: string;
  fadeOutNotification?: boolean;
  /** The account a message names: the owner of `cipherId`, or the account to save to. */
  userId?: string;
};

type BackgroundMessageParam = { message: NotificationBackgroundExtensionMessage };
type BackgroundSenderParam = { sender: chrome.runtime.MessageSender };
type BackgroundOnMessageHandlerParams = BackgroundMessageParam & BackgroundSenderParam;

export type NotificationBackgroundExtensionMessageHandlers = {
  [key: string]: CallableFunction;
  bgGetAccountData: ({ sender }: BackgroundSenderParam) => Promise<AccountView[]>;
  bgSelectAccount: ({ message, sender }: BackgroundOnMessageHandlerParams) => Promise<boolean>;
  bgGetFolderData: ({ message, sender }: BackgroundOnMessageHandlerParams) => Promise<FolderView[]>;
  bgGetOrgData: ({ sender }: BackgroundSenderParam) => Promise<OrgView[]>;
  bgGetCollectionData: ({
    message,
    sender,
  }: BackgroundOnMessageHandlerParams) => Promise<CollectionView[]>;
  bgCloseNotificationBar: ({ message, sender }: BackgroundOnMessageHandlerParams) => Promise<void>;
  bgOpenAtRiskPasswords: ({ message, sender }: BackgroundOnMessageHandlerParams) => Promise<void>;
  bgOpenChangePasswordUrl: ({ message, sender }: BackgroundOnMessageHandlerParams) => Promise<void>;
  bgAdjustNotificationBar: ({ message, sender }: BackgroundOnMessageHandlerParams) => Promise<void>;
  bgRemoveTabFromNotificationQueue: ({ sender }: BackgroundSenderParam) => void;
  bgSaveCipher: ({ message, sender }: BackgroundOnMessageHandlerParams) => void;
  bgOpenAddEditVaultItemPopout: ({
    message,
    sender,
  }: BackgroundOnMessageHandlerParams) => Promise<void>;
  bgOpenViewVaultItemPopout: ({
    message,
    sender,
  }: BackgroundOnMessageHandlerParams) => Promise<void>;
  bgNeverSave: ({ sender }: BackgroundSenderParam) => Promise<void>;
  bgReopenUnlockPopout: ({ sender }: BackgroundSenderParam) => Promise<void>;
  checkNotificationQueue: ({ sender }: BackgroundSenderParam) => Promise<void>;
  collectPageDetailsResponse: ({ message }: BackgroundMessageParam) => Promise<void>;
  bgGetEnableChangedPasswordPrompt: () => Promise<boolean>;
  bgGetEnableAddedLoginPrompt: () => Promise<boolean>;
  bgGetExcludedDomains: () => Promise<NeverDomains>;
  bgGetActiveUserServerConfig: () => Promise<ServerConfig | null>;
  getWebVaultUrlForNotification: () => Promise<string>;
  showLoginSavedNotification: ({ message }: BackgroundMessageParam) => Promise<void>;
};
