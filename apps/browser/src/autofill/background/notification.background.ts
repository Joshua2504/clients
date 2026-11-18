import { filter, firstValueFrom, switchMap, map, of } from "rxjs";

import { CollectionService } from "@bitwarden/admin-console/common";
import {
  getOrganizationById,
  OrganizationService,
} from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { PolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { PolicyType } from "@bitwarden/common/admin-console/enums";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { getOptionalUserId } from "@bitwarden/common/auth/services/account.service";
import {
  ExtensionCommand,
  ExtensionCommandType,
  NOTIFICATION_BAR_LIFESPAN_MS,
  UPDATE_PASSWORD,
} from "@bitwarden/common/autofill/constants";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { DomainSettingsService } from "@bitwarden/common/autofill/services/domain-settings.service";
import { UserNotificationSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/user-notification-settings.service";
import {
  AccountCipher,
  accountCipherRef,
  AccountCipherRef,
} from "@bitwarden/common/autofill/types/account-cipher";
import { ProductTierType } from "@bitwarden/common/billing/enums/product-tier-type.enum";
import { NeverDomains } from "@bitwarden/common/models/domain/domain-service";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import { ServerConfig } from "@bitwarden/common/platform/abstractions/config/server-config";
import { EnvironmentService } from "@bitwarden/common/platform/abstractions/environment.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import {
  IntraprocessMessageSender,
  isExternalMessage,
  MessageListener,
} from "@bitwarden/common/platform/messaging";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { ThemeStateService } from "@bitwarden/common/platform/theming/theme-state.service";
import { UserId } from "@bitwarden/common/types/guid";
import { ChangeLoginPasswordService } from "@bitwarden/common/vault/abstractions/change-login-password.service";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { FolderService } from "@bitwarden/common/vault/abstractions/folder/folder.service.abstraction";
import { CipherType } from "@bitwarden/common/vault/enums";
import { VaultMessages } from "@bitwarden/common/vault/enums/vault-messages.enum";
import { buildCipherIcon } from "@bitwarden/common/vault/icon/build-cipher-icon";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { LoginUriView } from "@bitwarden/common/vault/models/view/login-uri.view";
import { LoginView } from "@bitwarden/common/vault/models/view/login.view";
import { TaskService } from "@bitwarden/common/vault/tasks";
import { SecurityTaskStatus, SecurityTaskType } from "@bitwarden/common/vault/tasks/enums";
import { SecurityTask } from "@bitwarden/common/vault/tasks/models/security-task";

// FIXME (PM-22628): Popup imports are forbidden in background
// eslint-disable-next-line no-restricted-imports
import { AuthPopoutType, openUnlockPopout } from "../../auth/popup/utils/auth-popout-window";
import { BrowserApi } from "../../platform/browser/browser-api";
// FIXME (PM-22628): Popup imports are forbidden in background
// eslint-disable-next-line no-restricted-imports
import {
  openAddEditVaultItemPopout,
  openViewVaultItemPopout,
} from "../../vault/popup/utils/vault-popout-window";
import {
  OrganizationCategory,
  OrganizationCategories,
  NotificationCipherData,
} from "../content/components/cipher/types";
import { AccountView, CollectionView } from "../content/components/common-types";
import { NotificationType } from "../enums/notification-type.enum";
import { Fido2Background } from "../fido2/background/abstractions/fido2.background";
import { AutofillService } from "../services/abstractions/autofill.service";
import { CipherUse, SaveCandidate } from "../services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../services/abstractions/multi-account-fill-cipher-policy";
import { defaultSaveAccount, showsAccountLabels } from "../utils/save-target";

import {
  AddChangePasswordNotificationQueueMessage,
  AddLoginQueueMessage,
  AddLoginMessageData,
  AtRiskPasswordQueueMessage,
  NotificationQueueMessageItem,
  ADD_TO_LOCKED_VAULT_PENDING_NOTIFICATIONS,
  LockedVaultPendingNotificationsData,
  NotificationBackgroundExtensionMessage,
  NotificationBackgroundExtensionMessageHandlers,
  RETRY_SENDER,
  RETRY_WHEN_UNLOCK_COMPLETED,
} from "./abstractions/notification.background";
import {
  LoginSecurityTaskInfo,
  ModifyLoginCipherFormData,
  NotificationTypeData,
} from "./abstractions/overlay-notifications.background";
import { OverlayBackgroundExtensionMessage } from "./abstractions/overlay.background";

const inputScenarios = {
  usernamePasswordNewPassword: "usernamePasswordNewPassword",
  usernameNewPassword: "usernameNewPassword",
  usernamePassword: "usernamePassword",
  username: "username",
  passwordNewPassword: "passwordNewPassword",
  newPassword: "newPassword",
  password: "password",
} as const;

type InputScenarioKey = keyof typeof inputScenarios;
type InputScenario = (typeof inputScenarios)[InputScenarioKey];

/** The ciphers for the submitted form's URL, across every autofill account, by what they match. */
type CiphersByInputMatchCategory = {
  allFieldMatches: AccountCipherRef[];
  newPasswordOnlyMatches: AccountCipherRef[];
  noFieldMatches: AccountCipherRef[];
  passwordNewPasswordMatches: AccountCipherRef[];
  passwordOnlyMatches: AccountCipherRef[];
  usernameNewPasswordMatches: AccountCipherRef[];
  usernameOnlyMatches: AccountCipherRef[];
  usernamePasswordMatches: AccountCipherRef[];
};

/** The form values a save of this queue message would write to a cipher. */
function saveCandidateFor(
  queueMessage: AddLoginQueueMessage | AddChangePasswordNotificationQueueMessage,
  tab: chrome.tabs.Tab,
): SaveCandidate {
  if (queueMessage.type === NotificationType.AddLogin) {
    return queueMessage.data;
  }
  return { uri: tab.url ?? "", newPassword: queueMessage.data.newPassword };
}

export default class NotificationBackground {
  private openUnlockPopout = openUnlockPopout;
  private openAddEditVaultItemPopout = openAddEditVaultItemPopout;
  private openViewVaultItemPopout = openViewVaultItemPopout;
  private notificationQueue: NotificationQueueMessageItem[] = [];
  private allowedRetryCommands: Set<ExtensionCommandType> = new Set([
    ExtensionCommand.AutofillLogin,
    ExtensionCommand.AutofillCard,
    ExtensionCommand.AutofillIdentity,
  ]);
  private unlockPopoutTabId?: number;
  /**
   * The cipher a notification last saved on a tab, with its account. The confirmation's "view"
   * and "open tasks" actions name no account, and a cipher id alone does not identify one.
   */
  private savedCiphers = new Map<number, AccountCipherRef>();
  /** The account whose cipher awaits a master password reprompt before an update, per tab. */
  private pendingRepromptAccounts = new Map<number, UserId>();
  private readonly extensionMessageHandlers: NotificationBackgroundExtensionMessageHandlers = {
    bgAdjustNotificationBar: ({ message, sender }) =>
      this.handleAdjustNotificationBarMessage(message, sender),
    bgCloseNotificationBar: ({ message, sender }) =>
      this.handleCloseNotificationBarMessage(message, sender),
    bgOpenAtRiskPasswords: ({ message, sender }) =>
      this.handleOpenAtRiskPasswordsMessage(message, sender),
    bgOpenChangePasswordUrl: ({ message, sender }) =>
      this.handleOpenChangePasswordUrlMessage(message, sender),
    bgGetActiveUserServerConfig: () => this.getActiveUserServerConfig(),
    bgGetDecryptedCiphers: () => this.getNotificationCipherData(),
    bgGetEnableChangedPasswordPrompt: () => this.getEnableChangedPasswordPrompt(),
    bgGetEnableAddedLoginPrompt: () => this.getEnableAddedLoginPrompt(),
    bgGetExcludedDomains: () => this.getExcludedDomains(),
    bgGetAccountData: ({ sender }) => this.getAccountData(sender),
    bgSelectAccount: ({ message, sender }) => this.selectAccount(message, sender),
    bgGetFolderData: async ({ sender }) => this.getFolderData(await this.dataAccountFor(sender)),
    bgGetCollectionData: async ({ message, sender }) =>
      this.getCollectionData(message, await this.dataAccountFor(sender)),
    bgGetOrgData: async ({ sender }) => this.getOrgData(await this.dataAccountFor(sender)),
    bgNeverSave: ({ sender }) => this.withSenderTab(sender, (tab) => this.saveNever(tab)),
    bgOpenAddEditVaultItemPopout: ({ message, sender }) =>
      this.withSenderTab(sender, (tab) => this.openAddEditVaultItem(message, tab)),
    bgOpenViewVaultItemPopout: ({ message, sender }) =>
      this.withSenderTab(sender, (tab) => this.viewItem(message, tab)),
    bgRemoveTabFromNotificationQueue: ({ sender }) =>
      this.withSenderTab(sender, (tab) => this.removeTabFromNotificationQueue(tab)),
    bgReopenUnlockPopout: ({ sender }) =>
      this.withSenderTab(sender, (tab) => this.openUnlockPopout(tab)),
    bgSaveCipher: ({ message, sender }) => this.handleSaveCipherMessage(message, sender),
    bgHandleReprompt: ({ message, sender }: any) =>
      this.handleCipherUpdateRepromptResponse(message),
    checkNotificationQueue: ({ sender }) => this.checkNotificationQueue(sender.tab ?? null),
    collectPageDetailsResponse: ({ message }) =>
      this.handleCollectPageDetailsResponseMessage(message),
    getWebVaultUrlForNotification: () => this.getWebVaultUrl(),
    showLoginSavedNotification: ({ message }) => this.handleShowLoginSavedNotification(message),
  };

  constructor(
    private accountService: AccountService,
    private authService: AuthService,
    private autofillService: AutofillService,
    private cipherService: CipherService,
    private collectionService: CollectionService,
    private configService: ConfigService,
    private domainSettingsService: DomainSettingsService,
    private environmentService: EnvironmentService,
    private folderService: FolderService,
    private logService: LogService,
    private organizationService: OrganizationService,
    private policyService: PolicyService,
    private themeStateService: ThemeStateService,
    private userNotificationSettingsService: UserNotificationSettingsServiceAbstraction,
    private taskService: TaskService,
    private changeLoginPasswordService: ChangeLoginPasswordService,
    protected messagingService: MessagingService,
    private fido2Background: Fido2Background,
    private intraprocessMessageSender: IntraprocessMessageSender,
    private messageListener: MessageListener,
    private multiAccountFillCipherPolicy: MultiAccountFillCipherPolicy,
    private autofillAccountsService: AutofillAccountsService,
    /** Makes an account the active one. A popout shows the active account's vault. */
    private switchAccount: (userId: UserId) => Promise<void>,
  ) {}

  init() {
    if (chrome.runtime == null) {
      return;
    }

    this.setupExtensionMessageListener();
    this.setupUnlockCompletedListener();
    this.setupUnlockPopoutCloseListener();

    this.cleanupNotificationQueue();
  }

  private async withSenderTab(
    sender: chrome.runtime.MessageSender,
    action: (tab: chrome.tabs.Tab) => void | Promise<void>,
  ): Promise<void> {
    if (!sender.tab) {
      // eslint-disable-next-line no-console
      console.warn(`Extension message handler called without sender.tab:${sender.tab}`);
      return;
    }
    await action(sender.tab);
  }

  /**
   * Gets the enableChangedPasswordPrompt setting from the user notification settings service.
   */
  async getEnableChangedPasswordPrompt(): Promise<boolean> {
    return await firstValueFrom(this.userNotificationSettingsService.enableChangedPasswordPrompt$);
  }

  /**
   * Gets the enableAddedLoginPrompt setting from the user notification settings service.
   */
  async getEnableAddedLoginPrompt(): Promise<boolean> {
    return await firstValueFrom(this.userNotificationSettingsService.enableAddedLoginPrompt$);
  }

  /**
   * Gets the neverDomains setting from the domain settings service.
   */
  async getExcludedDomains(): Promise<NeverDomains> {
    return await firstValueFrom(this.domainSettingsService.neverDomains$);
  }

  /**
   *
   * Gets the current active tab and retrieves the relevant decrypted cipher
   * for the tab's URL. It constructs and returns an array of `NotificationCipherData` objects or a singular object.
   * If no active tab or URL is found, it returns an empty array.
   * If new login, returns a preview of the cipher.
   *
   * @returns {Promise<NotificationCipherData[]>}
   */

  async getNotificationCipherData(): Promise<NotificationCipherData[]> {
    const [currentTab, showFavicons, autofillUserIds, activeUserId] = await Promise.all([
      BrowserApi.getTabFromCurrentWindow(),
      firstValueFrom(this.domainSettingsService.showFavicons$),
      this.getAutofillUserIds(),
      this.getActiveUserId(),
    ]);

    if (!currentTab?.url || autofillUserIds.length === 0) {
      return [];
    }

    const cipherQueueMessage = this.notificationQueue.find(
      (message): message is AddChangePasswordNotificationQueueMessage | AddLoginQueueMessage =>
        (message.type === NotificationType.ChangePassword ||
          message.type === NotificationType.AddLogin) &&
        currentTab.id != null &&
        message.tab.id === currentTab.id &&
        this.queueMessageIsFromTabOrigin(message, currentTab),
    );

    let accountCiphers: AccountCipher[];
    if (cipherQueueMessage?.type === NotificationType.ChangePassword) {
      accountCiphers = await this.multiAccountFillCipherPolicy.ciphersForRefs(
        cipherQueueMessage.data.cipherRefs,
        CipherUse.SavePrompt,
      );
    } else if (cipherQueueMessage?.type === NotificationType.AddLogin) {
      accountCiphers = [
        {
          userId: cipherQueueMessage.userId,
          cipher: this.convertAddLoginQueueMessageToCipherView(cipherQueueMessage),
        },
      ];
    } else {
      accountCiphers = await this.multiAccountFillCipherPolicy.ciphersForUrl(
        currentTab.url,
        CipherUse.SavePrompt,
      );
    }

    // Icons, organizations and the label all belong to the account that owns the cipher.
    const accounts = await firstValueFrom(this.accountService.accounts$);
    const showAccountLabel = showsAccountLabels(autofillUserIds, activeUserId);
    const displayByAccount = new Map<
      UserId,
      {
        iconsServerUrl: string | null;
        organizations: { id: string; productTierType?: ProductTierType }[];
      }
    >();
    for (const userId of new Set(accountCiphers.map((accountCipher) => accountCipher.userId))) {
      const [env, organizations] = await Promise.all([
        firstValueFrom(this.environmentService.getEnvironment$(userId)),
        firstValueFrom(this.organizationService.organizations$(userId)),
      ]);
      displayByAccount.set(userId, { iconsServerUrl: env.getIconsUrl() ?? null, organizations });
    }

    return accountCiphers.map(({ userId, cipher }) => {
      const display = displayByAccount.get(userId);
      const organizationType = display?.organizations.find(
        (org) => org.id === cipher.organizationId,
      )?.productTierType;
      return {
        ...this.convertToNotificationCipherData(
          cipher,
          display?.iconsServerUrl ?? null,
          showFavicons,
          organizationType,
        ),
        userId,
        ...(showAccountLabel ? { accountLabel: accounts[userId]?.email ?? "" } : {}),
      };
    });
  }

  /**
   * Converts a CipherView and organization type into a NotificationCipherData object
   * for use in the notification bar.
   *
   * @returns A NotificationCipherData object containing the relevant cipher information.
   */

  convertToNotificationCipherData(
    view: CipherView,
    iconsServerUrl: string | null,
    showFavicons: boolean,
    organizationType?: ProductTierType,
  ): NotificationCipherData {
    const { id, name, reprompt, favorite, login } = view;

    const organizationCategories: OrganizationCategory[] = [];

    if (organizationType != null) {
      if (
        [ProductTierType.Teams, ProductTierType.Enterprise, ProductTierType.TeamsStarter].includes(
          organizationType,
        )
      ) {
        organizationCategories.push(OrganizationCategories.business);
      }

      if ([ProductTierType.Families, ProductTierType.Free].includes(organizationType)) {
        organizationCategories.push(OrganizationCategories.family);
      }
    }

    return {
      id,
      name,
      type: CipherType.Login,
      reprompt,
      favorite,
      ...(organizationCategories.length > 0 ? { organizationCategories } : {}),
      icon: buildCipherIcon(iconsServerUrl, view, showFavicons),
      login: login?.username ? { username: login.username } : undefined,
    };
  }

  /**
   * If there is a security task for this cipher at login, return the task, cipher view, uri and
   * the account that owns both. Each autofill account is asked for its own tasks and ciphers.
   *
   * @param modifyLoginData - The modified login form data
   */
  private async getSecurityTaskAndCipherForLoginData(
    modifyLoginData: ModifyLoginCipherFormData,
  ): Promise<LoginSecurityTaskInfo | null> {
    let urlCiphers: AccountCipher[] | undefined;

    for (const userId of await this.getAutofillUserIds()) {
      const tasks: SecurityTask[] = await this.getSecurityTasks(userId);
      if (!(tasks?.length > 0)) {
        continue;
      }

      urlCiphers ??= await this.multiAccountFillCipherPolicy.ciphersForUrl(
        modifyLoginData.uri,
        CipherUse.SecurityTask,
      );

      for (const { userId: cipherUserId, cipher } of urlCiphers) {
        if (
          cipherUserId !== userId ||
          // skip if the cipher was deleted
          cipher.deletedDate ||
          // skip if the entered login info doesn't match an existing cipher
          modifyLoginData.username !== cipher.login.username ||
          modifyLoginData.password !== cipher.login.password
        ) {
          continue;
        }

        // Find the first security task for the cipherId belonging to the entered login
        const cipherSecurityTask = tasks.find(
          ({ cipherId, status }) =>
            cipher.id === cipherId && // match security task cipher id to url cipher id
            status === SecurityTaskStatus.Pending, // security task has not been completed
        );

        if (cipherSecurityTask) {
          return { securityTask: cipherSecurityTask, cipher, uri: modifyLoginData.uri, userId };
        }
      }
    }

    return null;
  }

  /**
   * Gets the active user server config from the config service.
   */
  async getActiveUserServerConfig(): Promise<ServerConfig | null> {
    return await firstValueFrom(this.configService.serverConfig$);
  }

  /**
   * Gets the current authentication status of the user.
   * @returns Promise<AuthenticationStatus> - The current authentication status of the user.
   */
  private async getAuthStatus() {
    return await firstValueFrom(this.authService.activeAccountStatus$);
  }

  private async getActiveUserId(): Promise<UserId | null> {
    return await firstValueFrom(this.accountService.activeAccount$.pipe(getOptionalUserId));
  }

  private async getAutofillUserIds(): Promise<UserId[]> {
    return await firstValueFrom(this.autofillAccountsService.autofillUserIds$);
  }

  private async isAutofillUser(userId: UserId): Promise<boolean> {
    return await firstValueFrom(this.autofillAccountsService.isAutofillUser$(userId));
  }

  /**
   * Whether a queued notification can still act for `userId`: the account serves autofill, or it
   * is the active account, whose lock leads to the unlock prompt. Any other account has locked,
   * logged out or opted out since the notification was queued, and the notification is dropped.
   */
  private async canActFor(userId: UserId): Promise<boolean> {
    return userId === (await this.getActiveUserId()) || (await this.isAutofillUser(userId));
  }

  /** The accounts a queued notification acts for. Several only for a change across accounts. */
  private accountsOf(queueMessage: NotificationQueueMessageItem): UserId[] {
    if (queueMessage.type !== NotificationType.ChangePassword) {
      return [queueMessage.userId];
    }
    const owners = queueMessage.data.cipherRefs.map((ref) => ref.userId);
    return owners.length > 0 ? [...new Set(owners)] : [queueMessage.userId];
  }

  /**
   * Makes `userId` the active account, so a popout shows its vault.
   *
   * @returns false when the account no longer serves autofill; the popout must not open.
   */
  private async activateAccount(userId: UserId): Promise<boolean> {
    if (userId === (await this.getActiveUserId())) {
      return true;
    }
    if (!(await this.isAutofillUser(userId))) {
      return false;
    }
    await this.switchAccount(userId);
    return true;
  }

  /** Removes a queued notification that can no longer act for its account and closes its bar. */
  private async dropNotification(queueMessage: NotificationQueueMessageItem, tab: chrome.tabs.Tab) {
    const index = this.notificationQueue.indexOf(queueMessage);
    if (index >= 0) {
      this.notificationQueue.splice(index, 1);
    }
    await BrowserApi.tabSendMessageData(tab, "closeNotificationBar", { closedByUser: false });
  }

  /**
   * Checks the notification queue for any messages that need to be sent to the
   * specified tab. If no tab is specified, the current tab will be used.
   *
   * @param tab - The tab to check the notification queue for
   */
  async checkNotificationQueue(tab: chrome.tabs.Tab | null = null): Promise<void> {
    if (this.notificationQueue.length === 0) {
      return;
    }

    if (tab != null) {
      await this.doNotificationQueueCheck(tab);
      return;
    }

    const currentTab = await BrowserApi.getTabFromCurrentWindow();
    if (currentTab != null) {
      await this.doNotificationQueueCheck(currentTab);
    }
  }

  private cleanupNotificationQueue() {
    for (let i = this.notificationQueue.length - 1; i >= 0; i--) {
      if (this.notificationQueue[i].expires < new Date()) {
        BrowserApi.tabSendMessageData(this.notificationQueue[i].tab, "closeNotificationBar").catch(
          (error) => this.logService.error(error),
        );
        this.notificationQueue.splice(i, 1);
      }
    }
    setTimeout(() => this.cleanupNotificationQueue(), 30000); // check every 30 seconds
  }

  private async doNotificationQueueCheck(tab: chrome.tabs.Tab): Promise<void> {
    const queueMessage = this.notificationQueue.find(
      (message) => message.tab.id === tab.id && this.queueMessageIsFromTabOrigin(message, tab),
    );
    if (queueMessage) {
      await this.sendNotificationQueueMessage(tab, queueMessage);
    }
  }

  /**
   * Sends a queued notification message to the notification bar iframe in the given tab.
   *
   * This method merges type-specific data elements into the message body. System fields
   * always take precedence over type-specific data when there is a conflict.
   *
   * @param tab - The tab hosting the notification bar iframe.
   * @param notificationQueueMessage - The queued notification message to transmit.
   */
  private async sendNotificationQueueMessage(
    tab: chrome.tabs.Tab,
    notificationQueueMessage: NotificationQueueMessageItem,
  ) {
    const servedAccounts = await Promise.all(
      this.accountsOf(notificationQueueMessage).map((userId) => this.canActFor(userId)),
    );
    if (!servedAccounts.some(Boolean)) {
      await this.dropNotification(notificationQueueMessage, tab);
      return;
    }

    const {
      type: notificationType,
      wasVaultLocked: isVaultLocked,
      launchTimestamp,
      data,
      ...rest
    } = notificationQueueMessage;

    const typeData: NotificationTypeData = {
      isVaultLocked,
      theme: await firstValueFrom(this.themeStateService.selectedTheme$),
      launchTimestamp,
      showAnimations:
        (await firstValueFrom(this.autofillService.enableNotificationAnimation$)) ?? true,
    };

    switch (notificationType) {
      case NotificationType.AddLogin:
        typeData.removeIndividualVault = await this.removeIndividualVault(
          notificationQueueMessage.userId,
        );
        break;
    }

    await BrowserApi.tabSendMessageData(tab, "openNotificationBar", {
      type: notificationType,
      typeData,
      // `data` carries the type-specific payload from the queue message, with an arbitrary shape.
      // `rest` carries metadata resolved by the autofill subsystem. `rest` spreads last so these
      // trusted system fields always win on key collision.
      params: { ...data, ...rest },
    });
  }

  /**
   * Removes any login messages from the notification queue that
   * are associated with the specified tab.
   *
   * @param tab - The tab to remove messages for
   */
  private removeTabFromNotificationQueue(tab: chrome.tabs.Tab) {
    for (let i = this.notificationQueue.length - 1; i >= 0; i--) {
      if (this.notificationQueue[i].tab.id === tab.id) {
        this.notificationQueue.splice(i, 1);
      }
    }
    if (tab.id != null) {
      this.savedCiphers.delete(tab.id);
      this.pendingRepromptAccounts.delete(tab.id);
    }
  }

  /**
   * Sends a message to trigger the at risk password notification
   *
   * @param message - The extension message
   * @param sender - The contextual sender of the message
   */
  async triggerAtRiskPasswordNotification(
    data: ModifyLoginCipherFormData,
    tab: chrome.tabs.Tab,
  ): Promise<boolean> {
    const loginSecurityTaskInfo = await this.getSecurityTaskAndCipherForLoginData(data);

    if (!loginSecurityTaskInfo) {
      return false;
    }

    // The task, its cipher and its organization belong to this account, active or not.
    const { securityTask, cipher, userId } = loginSecurityTaskInfo;
    const domain = Utils.getDomain(tab.url);
    const passwordChangeUri = await this.changeLoginPasswordService.getChangePasswordUrl(cipher);

    const authStatus = await firstValueFrom(this.authService.authStatusFor$(userId));

    const wasVaultLocked = authStatus === AuthenticationStatus.Locked;

    const organization = await firstValueFrom(
      this.organizationService
        .organizations$(userId)
        .pipe(getOrganizationById(securityTask.organizationId)),
    );

    // The bar names the account the task belongs to whenever that is not plain from the popup.
    const accountLabel = showsAccountLabels(
      await this.getAutofillUserIds(),
      await this.getActiveUserId(),
    )
      ? (await firstValueFrom(this.accountService.accounts$))[userId]?.email
      : undefined;

    this.removeTabFromNotificationQueue(tab);
    const launchTimestamp = new Date().getTime();
    const queueMessage: AtRiskPasswordQueueMessage = {
      domain,
      wasVaultLocked,
      userId,
      type: NotificationType.AtRiskPassword,
      data: {
        hasPasswordChangeUri: passwordChangeUri != null,
        organizationName: organization?.name ?? "",
        ...(accountLabel ? { accountLabel } : {}),
      },
      tab: tab,
      launchTimestamp,
      expires: new Date(launchTimestamp + NOTIFICATION_BAR_LIFESPAN_MS),
    };
    this.notificationQueue.push(queueMessage);
    await this.checkNotificationQueue(tab);
    return true;
  }

  /**
   * Sends a "Login saved" confirmation notification bar directly to the given tab.
   * Used after a cipher is saved via the inline menu "Save and fill" flow,
   * where no notification bar is already open on the originating tab.
   *
   * @param cipherName - The name of the saved cipher, shown in the confirmation bar.
   * @param cipherId - The ID of the saved cipher, used by the "View" action in the bar.
   * @param tab - The tab to show the notification bar on.
   * @param userId - The account the cipher was saved to. "View" opens the cipher in that account,
   * or not at all once it no longer serves autofill, whichever account is active by then.
   */
  async triggerLoginSavedNotification(
    cipherName: string,
    cipherId: string,
    tab: chrome.tabs.Tab,
    userId: UserId,
  ): Promise<void> {
    this.rememberSavedCipher(tab, userId, cipherId);

    const theme = await firstValueFrom(this.themeStateService.selectedTheme$);
    const showAnimations =
      (await firstValueFrom(this.autofillService.enableNotificationAnimation$)) ?? true;

    await BrowserApi.tabSendMessageData(tab, "openNotificationBar", {
      type: "add",
      typeData: {
        isVaultLocked: false,
        theme,
        launchTimestamp: new Date().getTime(),
        showAnimations,
      },
      params: {},
      isConfirmation: true,
      confirmationData: { cipherId, itemName: cipherName },
    });
  }

  private async handleShowLoginSavedNotification(
    message: NotificationBackgroundExtensionMessage,
  ): Promise<void> {
    const { senderTabId, cipherId, itemName, userId } = message;
    // Without the account it was saved to, "View" could only guess at the active account.
    if (!senderTabId || !cipherId || typeof userId !== "string" || !userId) {
      return;
    }
    const tab = await BrowserApi.getTab(senderTabId);
    if (!tab) {
      return;
    }
    await this.triggerLoginSavedNotification(itemName ?? "", cipherId, tab, userId as UserId);
  }

  /**
   * Queues a save prompt for the account {@link defaultSaveAccount} names.
   *
   * @returns false when no account may save the login, so nothing was queued.
   */
  private async pushAddLoginToQueue(
    loginDomain: string,
    loginInfo: AddLoginMessageData,
    tab: chrome.tabs.Tab,
    isVaultLocked = false,
  ): Promise<boolean> {
    const userId = await this.defaultSaveAccount({
      uri: loginInfo.url,
      username: loginInfo.username,
      password: loginInfo.password,
    });
    if (userId == null) {
      return false;
    }

    // remove any old messages for this tab
    this.removeTabFromNotificationQueue(tab);
    const launchTimestamp = new Date().getTime();
    const message: AddLoginQueueMessage = {
      type: NotificationType.AddLogin,
      data: {
        username: loginInfo.username,
        password: loginInfo.password,
        uri: loginInfo.url,
      },
      domain: loginDomain,
      tab: tab,
      launchTimestamp,
      expires: new Date(launchTimestamp + NOTIFICATION_BAR_LIFESPAN_MS),
      wasVaultLocked: isVaultLocked,
      userId,
    };
    this.notificationQueue.push(message);
    await this.checkNotificationQueue(tab);
    return true;
  }

  /**
   * The account a new login is saved to unless the user picks another: the active account while
   * it alone serves autofill or none does, otherwise the first of the accounts serving autofill,
   * in their order of precedence, whose policy takes the login. That is the active account
   * whenever it serves and may save. See {@link defaultSaveAccount}.
   *
   * @returns null when no account may save the login.
   */
  private async defaultSaveAccount(candidate: SaveCandidate): Promise<UserId | null> {
    return await defaultSaveAccount(
      candidate,
      await this.getAutofillUserIds(),
      await this.getActiveUserId(),
      this.multiAccountFillCipherPolicy,
    );
  }

  /**
   * The accounts a queued new login can be saved to: the accounts that serve autofill. While
   * there are several, only those whose policy takes the login.
   */
  private async saveAccountsFor(queueMessage: AddLoginQueueMessage): Promise<UserId[]> {
    const userIds = await this.getAutofillUserIds();
    if (userIds.length < 2 && userIds[0] === (await this.getActiveUserId())) {
      return userIds;
    }

    const maySave = await Promise.all(
      userIds.map((userId) =>
        this.multiAccountFillCipherPolicy.canOfferSave(queueMessage.data, userId),
      ),
    );
    return userIds.filter((_, index) => maySave[index]);
  }

  /** The save prompt queued for `tab`, if the tab still shows the site it was queued for. */
  private queuedAddLoginFor(tab: chrome.tabs.Tab | undefined): AddLoginQueueMessage | undefined {
    if (tab == null) {
      return undefined;
    }
    return this.notificationQueue.find(
      (message): message is AddLoginQueueMessage =>
        message.type === NotificationType.AddLogin &&
        message.tab.id === tab.id &&
        this.queueMessageIsFromTabOrigin(message, tab),
    );
  }

  /**
   * The accounts the save prompt on the sender's tab offers, for its account selector. Empty
   * unless more than one account can save the login, so a single account sees no selector.
   */
  private async getAccountData(sender: chrome.runtime.MessageSender): Promise<AccountView[]> {
    const queueMessage = this.queuedAddLoginFor(sender?.tab);
    if (queueMessage == null || queueMessage.wasVaultLocked) {
      return [];
    }

    const userIds = await this.saveAccountsFor(queueMessage);
    if (userIds.length < 2 || !userIds.includes(queueMessage.userId)) {
      return [];
    }

    const accounts = await firstValueFrom(this.accountService.accounts$);
    return await Promise.all(
      userIds.map(async (userId) => ({
        id: userId,
        email: accounts[userId]?.email ?? "",
        selected: userId === queueMessage.userId,
        removeIndividualVault: await this.removeIndividualVault(userId),
      })),
    );
  }

  /**
   * Moves the save prompt on the sender's tab to the account the user picked. The account must
   * be one {@link getAccountData} offers at this moment.
   *
   * @returns whether the save now goes to the named account.
   */
  private async selectAccount(
    message: NotificationBackgroundExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<boolean> {
    const queueMessage = this.queuedAddLoginFor(sender?.tab);
    if (queueMessage == null || queueMessage.wasVaultLocked || message.userId == null) {
      return false;
    }

    const userIds = await this.saveAccountsFor(queueMessage);
    const userId = userIds.find((offered) => offered === message.userId);
    if (userIds.length < 2 || userId == null) {
      return false;
    }

    queueMessage.userId = userId;
    return true;
  }

  /**
   * Receives filled form values and determines if a notification should be
   * triggered, and if so, what kind and with what data.
   *
   * If an update scenario is identified, a change password message is added to the
   * notification queue, prompting the user to update a stored login that has changed.
   *
   * A new cipher notification is triggered in other defined scenarios
   * with the user's form input.
   *
   * Returns `true` or `false` to indicate if such a notification was
   * triggered or not.
   *
   * For the purposes of this function, form field inputs should be assumed to be
   * qualified accurately.
   */
  async triggerCipherNotification(
    data: ModifyLoginCipherFormData,
    tab: chrome.tabs.Tab,
  ): Promise<boolean> {
    const usernameFieldValue: string | null = data.username || null;
    const currentPasswordFieldValue = data.password || null;
    const newPasswordFieldValue = data.newPassword || null;

    // If no values were entered, exit early
    if (!usernameFieldValue && !currentPasswordFieldValue && !newPasswordFieldValue) {
      return false;
    }

    // If the entered data doesn't have an associated URI, exit early
    const loginDomain = Utils.getDomain(data.uri);
    if (loginDomain === null) {
      return false;
    }

    // If there is an active passkey prompt, exit early
    if (
      tab.id !== undefined &&
      this.fido2Background.shouldDeferVaultNotificationsForPasskeyUi(tab.id)
    ) {
      return false;
    }

    // If no cipher add/update notifications are enabled, we can exit early
    const changePasswordNotificationIsEnabled = await this.getEnableChangedPasswordPrompt();
    const newLoginNotificationIsEnabled = await this.getEnableAddedLoginPrompt();
    if (!changePasswordNotificationIsEnabled && !newLoginNotificationIsEnabled) {
      return false;
    }

    // An account that serves autofill takes the notification whatever the active account's
    // state. With none serving, only a locked active account is left, for the unlock prompt.
    const servesAutofill = (await this.getAutofillUserIds()).length > 0;

    // If there is no account logged in (as opposed to only being locked), exit early
    const authStatus = await this.getAuthStatus();
    if (authStatus === AuthenticationStatus.LoggedOut && !servesAutofill) {
      return false;
    }

    // If there is no active user, exit early
    const activeUserId = await firstValueFrom(
      this.accountService.activeAccount$.pipe(getOptionalUserId),
    );
    if (activeUserId === null && !servesAutofill) {
      return false;
    }

    const normalizedUsername: string = usernameFieldValue ? usernameFieldValue.toLowerCase() : "";
    const currentPasswordFieldHasValue =
      typeof currentPasswordFieldValue === "string" && currentPasswordFieldValue.length > 0;
    const newPasswordFieldHasValue =
      typeof newPasswordFieldValue === "string" && newPasswordFieldValue.length > 0;
    const usernameFieldHasValue =
      typeof usernameFieldValue === "string" && usernameFieldValue.length > 0;

    // If the current and new password inputs both have values and those values
    // match, return early, since no change was made
    if (
      currentPasswordFieldHasValue &&
      newPasswordFieldHasValue &&
      currentPasswordFieldValue === newPasswordFieldValue
    ) {
      return false;
    }

    /*
     * We only show the unlock notification if a new password field was filled, since
     * it's very likely to blindly represent an updated cipher value whereas other
     * scenarios below require the vault to be unlocked in order to determine
     * if an update has been made.
     */
    const promptToUnlock = async () => {
      if (!newPasswordFieldHasValue) {
        return false;
      }
      // This needs to be the call that includes the full form data
      return await this.pushChangePasswordToQueue(
        null,
        loginDomain,
        newPasswordFieldValue,
        tab,
        true,
      );
    };

    // While the active account is locked, other accounts may still serve autofill. Their ciphers
    // are matched below, and a new login is offered to them; with none serving, only the unlock
    // prompt remains.
    if (!servesAutofill) {
      return await promptToUnlock();
    }

    // The submitted login is looked up in every account that serves autofill, so a login one of
    // them already holds is not offered to another.
    const ciphersForURL: AccountCipher[] = await this.multiAccountFillCipherPolicy.ciphersForUrl(
      data.uri,
      CipherUse.SavePrompt,
    );

    // Reducer structured to avoid subsequent array iterations
    const ciphersByInputMatchCategory = ciphersForURL.reduce<CiphersByInputMatchCategory>(
      (acc, accountCipher) => {
        const { login } = accountCipher.cipher;
        const ref = accountCipherRef(accountCipher);
        const usernameInputMatchesCipher =
          usernameFieldHasValue && login.username?.toLowerCase() === normalizedUsername;
        const passwordInputMatchesCipher =
          currentPasswordFieldHasValue && login.password === currentPasswordFieldValue;
        const newPasswordInputMatchesCipher =
          newPasswordFieldHasValue && login.password === newPasswordFieldValue;

        if (
          !newPasswordInputMatchesCipher &&
          !usernameInputMatchesCipher &&
          !passwordInputMatchesCipher
        ) {
          return { ...acc, noFieldMatches: [...acc.noFieldMatches, ref] };
        } else if (
          newPasswordInputMatchesCipher &&
          usernameInputMatchesCipher &&
          passwordInputMatchesCipher
        ) {
          // Note: this case should be unreachable due to the early exit comparing
          // the password input values against each other, but leaving this bit here
          // as a defense against future changes to the pre-match checks.
          return { ...acc, allFieldMatches: [...acc.allFieldMatches, ref] };
        } else if (
          newPasswordInputMatchesCipher &&
          !usernameInputMatchesCipher &&
          !passwordInputMatchesCipher
        ) {
          return { ...acc, newPasswordOnlyMatches: [...acc.newPasswordOnlyMatches, ref] };
        } else if (
          passwordInputMatchesCipher &&
          !usernameInputMatchesCipher &&
          !newPasswordInputMatchesCipher
        ) {
          return { ...acc, passwordOnlyMatches: [...acc.passwordOnlyMatches, ref] };
        } else if (
          passwordInputMatchesCipher &&
          newPasswordInputMatchesCipher &&
          !usernameInputMatchesCipher
        ) {
          // Note: this case should be unreachable due to the early exit comparing
          // the password input values against each other, but leaving this bit here
          // as a defense against future changes to the pre-match checks.
          return { ...acc, passwordNewPasswordMatches: [...acc.passwordNewPasswordMatches, ref] };
        } else if (
          usernameInputMatchesCipher &&
          !passwordInputMatchesCipher &&
          !newPasswordInputMatchesCipher
        ) {
          return { ...acc, usernameOnlyMatches: [...acc.usernameOnlyMatches, ref] };
        } else if (
          usernameInputMatchesCipher &&
          passwordInputMatchesCipher &&
          !newPasswordInputMatchesCipher
        ) {
          return { ...acc, usernamePasswordMatches: [...acc.usernamePasswordMatches, ref] };
        } else if (
          usernameInputMatchesCipher &&
          newPasswordInputMatchesCipher &&
          !passwordInputMatchesCipher
        ) {
          return { ...acc, usernameNewPasswordMatches: [...acc.usernameNewPasswordMatches, ref] };
        }

        return acc;
      },
      {
        allFieldMatches: [],
        newPasswordOnlyMatches: [],
        noFieldMatches: [],
        passwordNewPasswordMatches: [],
        passwordOnlyMatches: [],
        usernameNewPasswordMatches: [],
        usernameOnlyMatches: [],
        usernamePasswordMatches: [],
      } as CiphersByInputMatchCategory,
    );

    // Handle different field fill combinations and determine the input scenario
    const inputScenariosByKey = {
      upn: inputScenarios.usernamePasswordNewPassword,
      un: inputScenarios.usernameNewPassword,
      up: inputScenarios.usernamePassword,
      u: inputScenarios.username,
      pn: inputScenarios.passwordNewPassword,
      n: inputScenarios.newPassword,
      p: inputScenarios.password,
    } as const;

    type InputScenarioKeys = keyof typeof inputScenariosByKey;

    const key = ((usernameFieldHasValue ? "u" : "") +
      (currentPasswordFieldHasValue ? "p" : "") +
      (newPasswordFieldHasValue ? "n" : "")) as InputScenarioKeys;

    const inputScenario = key in inputScenariosByKey ? inputScenariosByKey[key] : null;

    if (inputScenario) {
      return await this.handleInputMatchScenario({
        ciphersByInputMatchCategory,
        ciphersForURL,
        loginDomain,
        tab,
        data,
        inputScenario,
        changePasswordNotificationIsEnabled,
        newLoginNotificationIsEnabled,
      });
    }

    return false;
  }

  private async handleInputMatchScenario({
    inputScenario,
    ciphersByInputMatchCategory,
    ciphersForURL,
    loginDomain,
    tab,
    data,
    changePasswordNotificationIsEnabled,
    newLoginNotificationIsEnabled,
  }: {
    ciphersByInputMatchCategory: CiphersByInputMatchCategory;
    ciphersForURL: AccountCipher[];
    loginDomain: string;
    tab: chrome.tabs.Tab;
    data: ModifyLoginCipherFormData;
    inputScenario: InputScenario;
    changePasswordNotificationIsEnabled: boolean;
    newLoginNotificationIsEnabled: boolean;
  }): Promise<boolean> {
    const {
      newPasswordOnlyMatches,
      noFieldMatches,
      passwordOnlyMatches,
      usernameNewPasswordMatches,
      usernameOnlyMatches,
      usernamePasswordMatches,
    } = ciphersByInputMatchCategory;
    // IMPORTANT! The order of statements matters here; later evaluations
    // depend on the assumptions of the early exits in preceding logic

    // If no ciphers match any filled input values
    // (Note, this block may uniquely exit early since this match scenario
    // involves all ciphers, making it mutually exclusive from any other scenario)
    if (noFieldMatches.length === ciphersForURL.length) {
      // trigger a new cipher notification in these input scenarios
      // Note: username-only is excluded because a username with no password is insufficient
      // signal to assume a new login is being created. Multistep login forms accumulate
      // username + password across steps, so the combined data will trigger on form submission.
      if (
        (
          [
            inputScenarios.usernamePasswordNewPassword,
            inputScenarios.usernameNewPassword,
            inputScenarios.usernamePassword,
            inputScenarios.passwordNewPassword,
          ] as InputScenario[]
        ).includes(inputScenario) &&
        newLoginNotificationIsEnabled
      ) {
        const scenarioRequiresUsername = inputScenario !== inputScenarios.passwordNewPassword;
        if (
          scenarioRequiresUsername &&
          (data?.username === null || data?.username === undefined || data.username === "")
        ) {
          return false;
        }
        return await this.pushAddLoginToQueue(
          loginDomain,
          {
            username: data.username,
            url: data.uri,
            password: data.newPassword || data.password,
          },
          tab,
        );
      }

      // Trigger an update or new cipher notification for password-only input scenarios
      if (
        ([inputScenarios.password, inputScenarios.newPassword] as InputScenario[]).includes(
          inputScenario,
        )
      ) {
        if (ciphersForURL.length > 0 && changePasswordNotificationIsEnabled) {
          return await this.pushChangePasswordToQueue(
            ciphersForURL.map((accountCipher) => accountCipherRef(accountCipher)),
            loginDomain,
            // @TODO handle empty strings / incomplete data structure
            data.newPassword || data.password,
            tab,
          );
        }

        // No existing ciphers for this URL — offer to save the generated password as a new login.
        // The cipher may lack a username, but that is easier for the user to fix than losing
        // a generated password they cannot easily retrieve.
        if (ciphersForURL.length === 0 && newLoginNotificationIsEnabled) {
          return await this.pushAddLoginToQueue(
            loginDomain,
            {
              username: data.username,
              url: data.uri,
              password: data.newPassword || data.password,
            },
            tab,
          );
        }
      }

      return false;
    }

    // If ciphers match entered username and new password values
    if (usernameNewPasswordMatches.length > 0) {
      // Early exit in these scenarios as they represent "no change"
      if (
        (
          [
            inputScenarios.usernamePasswordNewPassword,
            inputScenarios.usernameNewPassword,
          ] as InputScenario[]
        ).includes(inputScenario)
      ) {
        return false;
      }
    }

    // If ciphers match entered username and password values
    if (usernamePasswordMatches.length > 0) {
      // and username, password, and new password values were entered
      if (
        inputScenario === inputScenarios.usernamePasswordNewPassword &&
        changePasswordNotificationIsEnabled
      ) {
        return await this.pushChangePasswordToQueue(
          usernamePasswordMatches,
          loginDomain,
          // @TODO handle empty strings / incomplete data structure
          data.newPassword || data.password,
          tab,
        );
      }

      if (inputScenario === inputScenarios.usernamePassword) {
        return false;
      }
    }

    // If ciphers match entered username value (only)
    if (usernameOnlyMatches.length > 0) {
      if (
        (
          [
            inputScenarios.usernamePasswordNewPassword,
            inputScenarios.usernameNewPassword,
            inputScenarios.usernamePassword,
          ] as InputScenario[]
        ).includes(inputScenario) &&
        changePasswordNotificationIsEnabled
      ) {
        return await this.pushChangePasswordToQueue(
          usernameOnlyMatches,
          loginDomain,
          // @TODO handle empty strings / incomplete data structure
          data.newPassword || data.password,
          tab,
        );
      }

      // Early exit in this scenario as it represents "no change"
      if (inputScenario === inputScenarios.username) {
        return false;
      }
    }

    // If ciphers match entered new password value (only)
    if (newPasswordOnlyMatches.length > 0) {
      // Early exit in these scenarios
      if (
        (
          [
            inputScenarios.usernameNewPassword, // unclear user expectation
            inputScenarios.password, // likely nothing to change
            inputScenarios.newPassword, // nothing to change
          ] as InputScenario[]
        ).includes(inputScenario)
      ) {
        return false;
      }

      // and username, password, and new password values were entered
      if (
        inputScenario === inputScenarios.usernamePasswordNewPassword &&
        newLoginNotificationIsEnabled
      ) {
        if (data?.username === null || data?.username === undefined || data.username === "") {
          return false;
        }
        return await this.pushAddLoginToQueue(
          loginDomain,
          {
            username: data.username,
            url: data.uri,
            password: data.newPassword || data.password,
          },
          tab,
        );
      }
    }

    // If ciphers match entered password value (only)
    if (passwordOnlyMatches.length > 0) {
      if (
        (
          [
            inputScenarios.usernamePasswordNewPassword,
            inputScenarios.usernamePassword,
            inputScenarios.passwordNewPassword,
          ] as InputScenario[]
        ).includes(inputScenario) &&
        changePasswordNotificationIsEnabled
      ) {
        return await this.pushChangePasswordToQueue(
          passwordOnlyMatches,
          loginDomain,
          // @TODO handle empty strings / incomplete data structure
          data.newPassword || data.password,
          tab,
        );
      }

      // Early exit in this scenario as it represents "no change"
      if (inputScenario === inputScenarios.password) {
        return false;
      }
    }

    return false;
  }

  /**
   * Sends the page details to the notification bar. Will query all
   * forms with a password field and pass them to the notification bar.
   *
   * @param message - The extension message
   */
  private async handleCollectPageDetailsResponseMessage(
    message: NotificationBackgroundExtensionMessage,
  ) {
    if (message.sender !== "notificationBar") {
      return;
    }
    const details = message.details;
    const tab = message.tab;
    if (details == null || tab == null) {
      return;
    }

    const forms = this.autofillService.getFormsWithPasswordFields(details);
    await BrowserApi.tabSendMessageData(tab, "notificationBarPageDetails", {
      details,
      forms,
    });
  }

  /**
   * Queues an update prompt for `cipherRefs`. An update goes to the account that owns the picked
   * cipher. While several accounts serve autofill, only ciphers of accounts whose policy takes
   * the update are offered.
   *
   * @param cipherRefs - The ciphers the user may update, each with its account. Null queues the
   * unlock prompt for the locked active account.
   * @returns false when nothing was queued: no account takes the update.
   */
  // @TODO this needs the whole input record, and not just newPassword
  private async pushChangePasswordToQueue(
    cipherRefs: AccountCipherRef[] | null,
    loginDomain: string,
    newPassword: string,
    tab: chrome.tabs.Tab,
    isVaultLocked = false,
  ): Promise<boolean> {
    let ciphers = cipherRefs ?? [];
    if (ciphers.length > 0 && (await this.getAutofillUserIds()).length > 1) {
      const candidate: SaveCandidate = { uri: tab.url ?? "", newPassword };
      const takesUpdate = new Map<UserId, boolean>();
      for (const userId of new Set(ciphers.map((ref) => ref.userId))) {
        takesUpdate.set(
          userId,
          await this.multiAccountFillCipherPolicy.canOfferSave(candidate, userId),
        );
      }
      ciphers = ciphers.filter((ref) => takesUpdate.get(ref.userId));
      if (ciphers.length === 0) {
        return false;
      }
    }

    const userId = ciphers[0]?.userId ?? (await this.getActiveUserId());
    if (userId == null) {
      return false;
    }

    // remove any old messages for this tab
    this.removeTabFromNotificationQueue(tab);
    const launchTimestamp = new Date().getTime();
    const message: AddChangePasswordNotificationQueueMessage = {
      type: NotificationType.ChangePassword,
      data: {
        cipherIds: ciphers.map((ref) => ref.cipherId),
        cipherRefs: ciphers,
        newPassword: newPassword,
      },
      domain: loginDomain,
      tab: tab,
      launchTimestamp,
      expires: new Date(launchTimestamp + NOTIFICATION_BAR_LIFESPAN_MS),
      wasVaultLocked: isVaultLocked,
      userId,
    };
    this.notificationQueue.push(message);
    await this.checkNotificationQueue(tab);
    return true;
  }

  /**
   * Saves a cipher based on the message sent from the notification bar. If the vault
   * is locked, the message will be added to the notification queue and the unlock
   * popout will be opened.
   *
   * @param message - The extension message
   * @param sender - The contextual sender of the message
   */
  private async handleSaveCipherMessage(
    message: NotificationBackgroundExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ) {
    if (!sender.tab) {
      return;
    }
    const tab = sender.tab;
    // Only the active account is asked to unlock. A notification for another account is saved to
    // that account or dropped by `saveOrUpdateCredentials`, whatever the active account's state.
    const targetUserId = this.saveTargetFor(tab, message.cipherId, message.userId);
    const targetIsActiveAccount =
      targetUserId == null || targetUserId === (await this.getActiveUserId());
    if (targetIsActiveAccount && (await this.getAuthStatus()) < AuthenticationStatus.Unlocked) {
      await this.openUnlockPopout(tab, () =>
        this.intraprocessMessageSender.send(ADD_TO_LOCKED_VAULT_PENDING_NOTIFICATIONS, {
          data: {
            commandToRetry: {
              message: {
                command: message.command,
                edit: message.edit,
                folder: message.folder,
              },
              [RETRY_SENDER]: sender,
            },
            target: "notification.background",
          },
        }),
      );
      return;
    }

    await this.saveOrUpdateCredentials(
      tab,
      message.cipherId,
      message?.edit,
      message.folder,
      false,
      message.userId,
    );
  }

  /**
   * The account a save from `tab` goes to, as its queued notification names it.
   *
   * @returns undefined when no notification is queued for the tab, or its account cannot be told.
   */
  private saveTargetFor(
    tab: chrome.tabs.Tab,
    cipherId: CipherView["id"],
    messageUserId?: string,
  ): UserId | undefined {
    for (let i = this.notificationQueue.length - 1; i >= 0; i--) {
      const queueMessage = this.notificationQueue[i];
      if (
        queueMessage.tab.id === tab.id &&
        (queueMessage.type === NotificationType.AddLogin ||
          queueMessage.type === NotificationType.ChangePassword) &&
        this.queueMessageIsFromTabOrigin(queueMessage, tab)
      ) {
        return this.targetOf(queueMessage, cipherId, messageUserId);
      }
    }
    return undefined;
  }

  /**
   * The account a queued save or update writes to. A new login goes to the notification's
   * account. An update goes to the account that owns the picked cipher: a cipher id that several
   * of the offered accounts hold, such as a shared item, needs the account named with it.
   *
   * It never yields the active account for want of a better answer.
   */
  private targetOf(
    queueMessage: AddLoginQueueMessage | AddChangePasswordNotificationQueueMessage,
    cipherId: CipherView["id"],
    messageUserId?: string,
  ): UserId | undefined {
    if (queueMessage.type === NotificationType.AddLogin) {
      return queueMessage.userId;
    }

    const owners = [
      ...new Set(
        queueMessage.data.cipherRefs
          .filter((ref) => ref.cipherId === cipherId)
          .map((ref) => ref.userId),
      ),
    ];
    if (owners.length === 0) {
      // Not a cipher the notification offered. It can only be one of the notification's account.
      return messageUserId == null || messageUserId === queueMessage.userId
        ? queueMessage.userId
        : undefined;
    }
    if (messageUserId != null) {
      return owners.find((owner) => owner === messageUserId);
    }
    return owners.length === 1 ? owners[0] : undefined;
  }

  async handleCipherUpdateRepromptResponse(message: NotificationBackgroundExtensionMessage) {
    if (message.tab === null || message.tab === undefined) {
      return;
    }
    const tab = message.tab;
    // The reprompt answers for the account whose cipher asked for it.
    const repromptUserId = tab.id != null ? this.pendingRepromptAccounts.get(tab.id) : undefined;
    if (tab.id != null) {
      this.pendingRepromptAccounts.delete(tab.id);
    }
    if (message.success) {
      await this.saveOrUpdateCredentials(
        tab,
        message.cipherId,
        false,
        undefined,
        true,
        repromptUserId,
      );
    } else {
      await BrowserApi.tabSendMessageData(tab, "saveCipherAttemptCompleted", {
        error: "Password reprompt failed",
      });
    }
  }

  /**
   * Saves or updates credentials based on the message within the
   * notification queue that is associated with the specified tab.
   *
   * @param tab - The tab to save or update credentials for
   * @param edit - Identifies if the credentials should be edited or simply added
   * @param folderId - The folder to add the cipher to
   */
  private async saveOrUpdateCredentials(
    tab: chrome.tabs.Tab,
    cipherId: CipherView["id"],
    edit?: boolean,
    folderId?: string,
    skipReprompt: boolean = false,
    messageUserId?: string,
  ) {
    const resolvedEdit = edit ?? false;
    for (let i = this.notificationQueue.length - 1; i >= 0; i--) {
      const queueMessage = this.notificationQueue[i];
      if (
        queueMessage.tab.id !== tab.id ||
        (queueMessage.type !== NotificationType.AddLogin &&
          queueMessage.type !== NotificationType.ChangePassword)
      ) {
        continue;
      }

      if (!this.queueMessageIsFromTabOrigin(queueMessage, tab)) {
        continue;
      }

      // Everything below reads and writes this account, whichever account is active by now.
      const userId = this.targetOf(queueMessage, cipherId, messageUserId);
      if (userId == null) {
        continue;
      }

      // The account locked, logged out or opted out since the notification was queued. Nothing
      // is saved, and nothing is saved to another account in its place.
      if (!(await this.isAutofillUser(userId))) {
        await this.dropNotification(queueMessage, tab);
        return;
      }

      if (
        !(await this.multiAccountFillCipherPolicy.canOfferSave(
          saveCandidateFor(queueMessage, tab),
          userId,
        ))
      ) {
        this.notificationQueue.splice(i, 1);
        await BrowserApi.tabSendMessageData(tab, "closeNotificationBar", { closedByUser: false });
        return;
      }

      if (queueMessage.type === NotificationType.ChangePassword) {
        const {
          data: { newPassword },
        } = queueMessage;
        const cipherView = await this.getDecryptedCipherById(cipherId, userId);
        if (cipherView == null) {
          continue;
        }

        await this.updatePassword(cipherView, newPassword, resolvedEdit, tab, userId, skipReprompt);
        return;
      }

      this.notificationQueue.splice(i, 1);

      // If the vault was locked, check if a cipher needs updating instead of creating a new one
      if (queueMessage.wasVaultLocked) {
        const allCiphers = await this.multiAccountFillCipherPolicy.ciphersForUrl(
          queueMessage.data.uri,
          CipherUse.SavePrompt,
        );
        const existingCipher = allCiphers.find(
          ({ userId: cipherUserId, cipher }) =>
            cipherUserId === userId &&
            cipher.login?.username != null &&
            cipher.login.username.toLowerCase() === queueMessage.data.username,
        )?.cipher;

        if (existingCipher != null) {
          const password = queueMessage.data.password;
          if (password == null) {
            continue;
          }
          await this.updatePassword(existingCipher, password, resolvedEdit, tab, userId);
          return;
        }
      }

      folderId =
        folderId != null && (await this.folderExists(folderId, userId)) ? folderId : undefined;
      const newCipher = this.convertAddLoginQueueMessageToCipherView(queueMessage, folderId);

      if (resolvedEdit) {
        await this.editItem(newCipher, userId, tab);
        await BrowserApi.tabSendMessage(tab, { command: "closeNotificationBar" });
        return;
      }

      try {
        const resultCipher = await this.cipherService.createWithServer(newCipher, userId);
        this.rememberSavedCipher(tab, userId, resultCipher?.id);
        await BrowserApi.tabSendMessageData(tab, "saveCipherAttemptCompleted", {
          itemName: newCipher?.name && String(newCipher?.name),
          cipherId: resultCipher?.id && String(resultCipher?.id),
        });
        await BrowserApi.tabSendMessage(tab, { command: "addedCipher" });
      } catch (error) {
        await BrowserApi.tabSendMessageData(tab, "saveCipherAttemptCompleted", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private rememberSavedCipher(tab: chrome.tabs.Tab, userId: UserId, cipherId?: string) {
    if (tab.id != null && cipherId) {
      this.savedCiphers.set(tab.id, { userId, cipherId: String(cipherId) });
    }
  }

  /**
   * Handles updating an existing cipher's password. If the cipher
   * is being edited, a popup will be opened to allow the user to
   * edit the cipher.
   *
   * @param cipherView - The cipher to update
   * @param newPassword - The new password to update the cipher with
   * @param edit - Identifies if the cipher should be edited or simply updated
   * @param tab - The tab that the message was sent from
   * @param userId - The account that owns the cipher
   */
  private async updatePassword(
    cipherView: CipherView,
    newPassword: string,
    edit: boolean,
    tab: chrome.tabs.Tab,
    userId: UserId,
    skipReprompt: boolean = false,
  ) {
    cipherView.login.password = newPassword;

    if (edit) {
      await this.editItem(cipherView, userId, tab);
      await BrowserApi.tabSendMessage(tab, { command: "closeNotificationBar" });
      await BrowserApi.tabSendMessage(tab, { command: "editedCipher" });
      return;
    }

    try {
      if (!cipherView.edit) {
        throw new Error("You do not have permission to edit this cipher.");
      }
      const tasks = await this.getSecurityTasks(userId);
      const updatedCipherTask = tasks.find((task) => task.cipherId === cipherView?.id);
      const cipherHasTask = !!updatedCipherTask?.id;

      let taskOrgName: string | undefined;
      if (cipherHasTask && updatedCipherTask?.organizationId) {
        const userOrgs = await this.getOrgData(userId);
        taskOrgName = userOrgs.find(({ id }) => id === updatedCipherTask.organizationId)?.name;
      }

      const taskData = cipherHasTask
        ? {
            remainingTasksCount: tasks.length - 1,
            orgName: taskOrgName,
          }
        : undefined;

      if (cipherView.reprompt && !skipReprompt) {
        // The reprompt popout shows the cipher in the active account's vault and verifies that
        // account's master password, so the cipher's account becomes the active one first.
        if (!(await this.activateAccount(userId))) {
          return;
        }
        if (tab.id != null) {
          this.pendingRepromptAccounts.set(tab.id, userId);
        }
        await this.autofillService.isPasswordRepromptRequired(
          cipherView,
          tab,
          userId,
          UPDATE_PASSWORD,
        );

        return;
      }

      await this.cipherService.updateWithServer(cipherView, userId);
      this.rememberSavedCipher(tab, userId, cipherView?.id);

      await BrowserApi.tabSendMessageData(tab, "saveCipherAttemptCompleted", {
        itemName: cipherView?.name && String(cipherView?.name),
        cipherId: cipherView?.id && String(cipherView.id),
        task: taskData,
      });

      // If the cipher had a security task, mark it as complete
      if (cipherHasTask) {
        // guard against multiple (redundant) security tasks per cipher
        await Promise.all(
          tasks.map((task) => {
            if (task.cipherId === cipherView?.id) {
              return this.taskService.markAsComplete(task.id, userId);
            }
          }),
        );
      }
    } catch (error) {
      await BrowserApi.tabSendMessageData(tab, "saveCipherAttemptCompleted", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sets the add/edit cipher info in the cipher service
   * and opens the add/edit vault item popout.
   *
   * @param cipherView - The cipher to edit
   * @param userId - The account the cipher belongs or is saved to. It becomes the active account,
   * since the popout edits the active account's vault.
   * @param senderTab - The tab that the message was sent from
   */
  private async editItem(cipherView: CipherView, userId: UserId, senderTab: chrome.tabs.Tab) {
    if (!(await this.activateAccount(userId))) {
      return;
    }

    await this.cipherService.setAddEditCipherInfo(
      {
        cipher: cipherView,
        collectionIds: cipherView.collectionIds,
      },
      userId,
    );

    await this.openAddEditVaultItemPopout(senderTab, { cipherId: cipherView?.id });
  }

  private async openAddEditVaultItem(
    message: NotificationBackgroundExtensionMessage,
    senderTab: chrome.tabs.Tab,
  ) {
    const { cipherId, organizationId, folder } = message;
    if (cipherId) {
      await this.openAddEditVaultItemPopout(senderTab, { cipherId });
      return;
    }

    const queueItem = this.notificationQueue.find((item) => item.tab.id === senderTab.id);

    if (queueItem?.type === NotificationType.AddLogin) {
      // The draft is for the notification's account. The popout edits the active account's
      // vault, so that account becomes the active one first.
      const userId = queueItem.userId;
      if (!(await this.activateAccount(userId))) {
        await this.dropNotification(queueItem, senderTab);
        return;
      }

      const cipherView = this.convertAddLoginQueueMessageToCipherView(queueItem);
      cipherView.organizationId = organizationId;
      cipherView.folderId = folder;
      if (!(await this.multiAccountFillCipherPolicy.canOfferSave(queueItem.data, userId))) {
        cipherView.login.password = "";
      }

      await this.cipherService.setAddEditCipherInfo({ cipher: cipherView }, userId);

      await this.openAddEditVaultItemPopout(senderTab);
      this.removeTabFromNotificationQueue(senderTab);
      return;
    }

    await this.openAddEditVaultItemPopout(senderTab);
  }

  private async viewItem(
    message: NotificationBackgroundExtensionMessage,
    senderTab: chrome.tabs.Tab,
  ) {
    if (!(await this.activateSavedCipherAccount(senderTab, message?.cipherId))) {
      await BrowserApi.tabSendMessageData(senderTab, "closeNotificationBar", {
        fadeOutNotification: !!message.fadeOutNotification,
      });
      return;
    }

    await Promise.all([
      this.openViewVaultItemPopout(senderTab, {
        cipherId: message?.cipherId || "",
        action: "",
      }),
      BrowserApi.tabSendMessageData(senderTab, "closeNotificationBar", {
        fadeOutNotification: !!message.fadeOutNotification,
      }),
    ]);
  }

  private async folderExists(folderId: string, userId: UserId) {
    if (Utils.isNullOrWhitespace(folderId) || folderId === "null") {
      return false;
    }
    const folders = await firstValueFrom(this.folderService.folderViews$(userId));
    return folders.some((x) => x.id === folderId);
  }

  /**
   * Makes the account of the cipher a notification last saved on `tab` the active one, so the
   * popup shows that cipher or its tasks.
   *
   * @param cipherId - When given, only if this is the cipher that was saved.
   * @returns false when that account no longer serves autofill; nothing of it must be shown.
   */
  private async activateSavedCipherAccount(
    tab: chrome.tabs.Tab,
    cipherId?: string,
  ): Promise<boolean> {
    const saved = tab.id != null ? this.savedCiphers.get(tab.id) : undefined;
    if (saved == null || (cipherId != null && saved.cipherId !== cipherId)) {
      return true;
    }
    return await this.activateAccount(saved.userId);
  }

  /**
   * The login `cipherId` of `userId`, or null. An account that does not serve autofill has none.
   */
  private async getDecryptedCipherById(cipherId: string, userId: UserId) {
    const [accountCipher] = await this.multiAccountFillCipherPolicy.ciphersForRefs(
      [{ userId, cipherId }],
      CipherUse.SavePrompt,
    );
    if (accountCipher != null && accountCipher.cipher.type === CipherType.Login) {
      return accountCipher.cipher;
    }
    return null;
  }

  async getSecurityTasks(userId: UserId) {
    let tasks: SecurityTask[] = [];

    if (userId) {
      tasks = await firstValueFrom(
        this.taskService.tasksEnabled$(userId).pipe(
          switchMap((tasksEnabled) => {
            if (!tasksEnabled) {
              return of([]);
            }

            return this.taskService
              .pendingTasks$(userId)
              .pipe(
                map((tasks) =>
                  tasks.filter(({ type }) => type === SecurityTaskType.UpdateAtRiskCredential),
                ),
              );
          }),
        ),
      );
    }

    return tasks;
  }

  /**
   * Saves the hostname of the frame the login was submitted from to the never save list. The
   * submitting frame's hostname is used rather than the tab's because exclusions are checked
   * against the origin of the frame reporting the submission.
   *
   * @param tab - The tab that sent the neverSave message
   */
  private async saveNever(tab: chrome.tabs.Tab) {
    for (let i = this.notificationQueue.length - 1; i >= 0; i--) {
      const queueMessage = this.notificationQueue[i];
      if (queueMessage.tab.id !== tab.id || queueMessage.type !== NotificationType.AddLogin) {
        continue;
      }

      if (!this.queueMessageIsFromTabOrigin(queueMessage, tab)) {
        continue;
      }

      this.notificationQueue.splice(i, 1);
      await BrowserApi.tabSendMessageData(tab, "closeNotificationBar");

      const hostname = Utils.getHostname(queueMessage.data.uri ?? "") ?? "";
      if (hostname) {
        await this.cipherService.saveNeverDomain(hostname);
      }
    }
  }

  /**
   * The account whose folders, organizations and collections the notification bar on the
   * sender's tab shows: the account its queued save goes to, or the active account when no save
   * is queued for the tab.
   *
   * @returns null when there is no such account, or the queued save can no longer go to it.
   */
  private async dataAccountFor(sender: chrome.runtime.MessageSender): Promise<UserId | null> {
    const queueMessage = this.queuedAddLoginFor(sender?.tab);
    if (queueMessage == null) {
      return await this.getActiveUserId();
    }
    return (await this.canActFor(queueMessage.userId)) ? queueMessage.userId : null;
  }

  /**
   * Returns the first value found from the folder service's folderViews$ observable.
   */
  private async getFolderData(userId: UserId | null) {
    if (userId == null) {
      return [];
    }
    return await firstValueFrom(this.folderService.folderViews$(userId));
  }

  private async getCollectionData(
    message: NotificationBackgroundExtensionMessage,
    userId: UserId | null,
  ): Promise<CollectionView[]> {
    if (userId == null) {
      return [];
    }
    const collections = await firstValueFrom(
      this.collectionService.decryptedCollections$(userId).pipe(
        map((collections) =>
          collections.reduce<CollectionView[]>((acc, collection) => {
            if (collection.organizationId === message?.orgId) {
              acc.push({
                id: collection.id,
                name: collection.name,
                organizationId: collection.organizationId,
              });
            }
            return acc;
          }, []),
        ),
      ),
    );
    return collections;
  }

  private async getWebVaultUrl(): Promise<string> {
    const env = await firstValueFrom(this.environmentService.environment$);
    return env.getWebVaultUrl();
  }

  /**
   * The web vault origins of the accounts that serve autofill besides the active one. A login
   * to any of them is a master password, which no account is offered to save.
   */
  async getOtherAutofillAccountVaultOrigins(): Promise<string[]> {
    const activeUserId = await this.getActiveUserId();
    const origins: string[] = [];
    for (const userId of await this.getAutofillUserIds()) {
      if (userId === activeUserId) {
        continue;
      }
      const env = await firstValueFrom(this.environmentService.getEnvironment$(userId));
      const origin = Utils.getUrl(env.getWebVaultUrl())?.origin;
      if (origin) {
        origins.push(origin);
      }
    }
    return origins;
  }

  private async removeIndividualVault(userId: UserId): Promise<boolean> {
    return await firstValueFrom(
      this.policyService.policyAppliesToUser$(PolicyType.OrganizationDataOwnership, userId),
    );
  }

  /**
   * Returns enabled organizations from `organizations$` for the notification bar vault selector.
   */
  private async getOrgData(userId: UserId | null) {
    if (userId == null) {
      return [];
    }
    const organizations = await firstValueFrom(this.organizationService.organizations$(userId));

    return organizations
      .filter((org) => org.enabled)
      .map((org) => {
        const { id, name, productTierType } = org;
        return {
          id,
          name,
          productTierType,
        };
      });
  }

  /**
   * @see {@link RETRY_WHEN_UNLOCK_COMPLETED}
   */
  private setupUnlockCompletedListener() {
    this.messageListener
      .messages$(RETRY_WHEN_UNLOCK_COMPLETED)
      .pipe(filter((message) => !isExternalMessage(message)))
      .subscribe(({ data }) => {
        this.handleUnlockCompleted(data).catch((error) => this.logService.error(error));
      });
  }

  /**
   * Closes the notification bar after an attempted autofill action, and retries the autofill
   * action if the retained command carries a follow-up command.
   *
   * A retry whose {@link RETRY_SENDER} names no tab is dropped: both the bar it closes and the
   * handlers it dispatches to act on that tab.
   *
   * @param data - The command the background retained when it opened the unlock popout
   */
  private async handleUnlockCompleted(data: LockedVaultPendingNotificationsData): Promise<void> {
    this.unlockPopoutTabId = undefined;

    const sender = data?.commandToRetry?.[RETRY_SENDER];
    if (!sender?.tab) {
      return;
    }

    const retryCommand = data.commandToRetry.message.command as ExtensionCommandType;
    if (this.allowedRetryCommands.has(retryCommand) && sender.tab != null) {
      await BrowserApi.tabSendMessageData(sender.tab, "closeNotificationBar");
    }

    if (data.target !== "notification.background") {
      return;
    }

    const retryHandler: CallableFunction | undefined = this.extensionMessageHandlers[retryCommand];
    if (retryHandler) {
      retryHandler({ message: data.commandToRetry.message, sender });
    }
  }

  /**
   * Sends a message back to the sender tab which
   * triggers closure of the notification bar.
   *
   * @param message - The extension message
   * @param sender - The contextual sender of the message
   */
  private async handleCloseNotificationBarMessage(
    message: NotificationBackgroundExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ) {
    await this.withSenderTab(sender, (tab) =>
      BrowserApi.tabSendMessageData(tab, "closeNotificationBar", {
        fadeOutNotification: !!message.fadeOutNotification,
      }),
    );
  }

  /**
   * Sends a message to the background to open the
   * at-risk passwords extension view. Triggers
   * notification closure as a side-effect.
   *
   * @param message - The extension message
   * @param sender - The contextual sender of the message
   */
  private async handleOpenAtRiskPasswordsMessage(
    message: NotificationBackgroundExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ) {
    await this.withSenderTab(sender, async (tab) => {
      // The tasks are those of the account whose cipher was just updated.
      if (!(await this.activateSavedCipherAccount(tab))) {
        await BrowserApi.tabSendMessageData(tab, "closeNotificationBar", {
          fadeOutNotification: !!message.fadeOutNotification,
        });
        return;
      }

      const browserAction = BrowserApi.getBrowserAction();
      try {
        // Set route of the popup before attempting to open it.
        // If the vault is locked, this won't have an effect as the auth guards will
        // redirect the user to the login page.
        await browserAction.setPopup({ popup: "popup/index.html#/at-risk-passwords" });

        await Promise.all([
          this.messagingService.send(VaultMessages.OpenAtRiskPasswords),
          BrowserApi.tabSendMessageData(tab, "closeNotificationBar", {
            fadeOutNotification: !!message.fadeOutNotification,
          }),
        ]);
      } finally {
        // Reset the popup route to the default route so any subsequent
        // popup openings will not open to the at-risk-passwords page.
        await browserAction.setPopup({
          popup: "popup/index.html#/",
        });
      }
    });
  }

  /**
   * Opens the trusted password-change URL for an at-risk credential on the sender tab.
   *
   * The URL is never read from the notification iframe message. Instead, the handler
   * re-derives it from the cipher's URIs via the well-known change-password protocol,
   * preventing an attacker-controlled iframe from injecting a malicious URL.
   *
   * @param _message - The extension message (unused)
   * @param sender - The contextual sender of the message
   */
  private async handleOpenChangePasswordUrlMessage(
    _message: NotificationBackgroundExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ) {
    await this.withSenderTab(sender, async (tab) => {
      if (!tab.url) {
        return;
      }

      try {
        // The notification queued for the tab names the account that owns the task.
        const queueMessage = this.notificationQueue.find(
          (message) =>
            message.type === NotificationType.AtRiskPassword &&
            message.tab.id === tab.id &&
            this.queueMessageIsFromTabOrigin(message, tab),
        );
        const ciphers = (
          await this.multiAccountFillCipherPolicy.ciphersForUrl(tab.url, CipherUse.SecurityTask)
        ).filter(({ userId }) => queueMessage == null || userId === queueMessage.userId);

        const tasksByAccount = new Map<UserId, SecurityTask[]>();
        for (const userId of new Set(ciphers.map((accountCipher) => accountCipher.userId))) {
          tasksByAccount.set(userId, await this.getSecurityTasks(userId));
        }
        if (![...tasksByAccount.values()].some((tasks) => tasks?.length)) {
          return;
        }

        // FIXME: When multiple ciphers match the tab URL and each has a pending security
        // task, this returns the first match — which may not be the cipher the user was
        // originally notified about. Consider carrying cipher ID through a trusted
        // side-channel (e.g., a background-scoped map keyed by tab ID) so the handler
        // can correlate to the exact cipher.
        const atRisk = ciphers.find(
          ({ userId, cipher }) =>
            !cipher.deletedDate &&
            tasksByAccount
              .get(userId)
              ?.some((t) => t.cipherId === cipher.id && t.status === SecurityTaskStatus.Pending),
        );

        if (!atRisk) {
          throw new Error("No at-risk cipher found for tab URL");
        }

        const passwordChangeUrl = await this.changeLoginPasswordService.getChangePasswordUrl(
          atRisk.cipher,
        );
        if (!passwordChangeUrl) {
          throw new Error("No change-password URL found for cipher");
        }

        this.logService.info("Opening change-password URL for at-risk credential");
        await BrowserApi.createNewTab(passwordChangeUrl);
      } catch (e: unknown) {
        this.logService.warning((e as Error).message);
      }
    });
  }

  /**
   * Sends a message back to the sender tab which triggers
   * an CSS adjustment of the notification bar.
   *
   * @param message - The extension message
   * @param sender - The contextual sender of the message
   */
  private async handleAdjustNotificationBarMessage(
    message: NotificationBackgroundExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ) {
    await this.withSenderTab(sender, (tab) =>
      BrowserApi.tabSendMessageData(tab, "adjustNotificationBar", message.data),
    );
  }

  /**
   * Accepts a login queue message and converts it into a
   * login uri view, login view, and cipher view.
   *
   * @param message - The message to convert to a cipher view
   * @param folderId - The folder to add the cipher to
   */
  private convertAddLoginQueueMessageToCipherView(
    message: AddLoginQueueMessage,
    folderId?: string,
  ): CipherView {
    const uriView = new LoginUriView();
    uriView.uri = message.data.uri;

    const loginView = new LoginView();
    loginView.uris = [uriView];
    loginView.username = message.data.username;
    loginView.password = message.data.password;

    const cipherView = new CipherView();
    cipherView.name = (Utils.getHostname(message.data.uri) || message.domain).replace(/^www\./, "");
    cipherView.folderId = folderId;
    cipherView.type = CipherType.Login;
    cipherView.login = loginView;

    return cipherView;
  }

  private setupExtensionMessageListener() {
    BrowserApi.messageListener("notification.background", this.handleExtensionMessage);
  }

  private handleExtensionMessage = (
    message: OverlayBackgroundExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ): boolean | void => {
    const handler: CallableFunction | undefined = this.extensionMessageHandlers[message?.command];
    if (!handler) {
      return;
    }

    const messageResponse = handler({ message, sender });
    if (typeof messageResponse === "undefined") {
      return;
    }

    Promise.resolve(messageResponse)
      .then((response) => sendResponse(response))
      .catch((error) => this.logService.error(error));
    return true;
  };

  /**
   * Validates whether the queue message is associated with the passed tab.
   * The tab's current URL must match the domain the notification was queued for.
   *
   * @param queueMessage - The queue message to check
   * @param tab - The tab to check the queue message against
   */
  private queueMessageIsFromTabOrigin(
    queueMessage: NotificationQueueMessageItem,
    tab: chrome.tabs.Tab,
  ) {
    const tabDomain = Utils.getDomain(tab.url);
    if (tabDomain == null) {
      return false;
    }

    return tabDomain === queueMessage.domain;
  }

  private setupUnlockPopoutCloseListener() {
    chrome.tabs.onRemoved.addListener(async (tabId: number) => {
      await this.handleUnlockPopoutClosed(tabId);
    });
  }

  /**
   * If the unlock popout is closed while the vault
   * is still locked and there are pending autofill notifications, abandon them.
   */
  private async handleUnlockPopoutClosed(removedTabId: number) {
    const authStatus = await this.getAuthStatus();
    if (authStatus >= AuthenticationStatus.Unlocked) {
      this.unlockPopoutTabId = undefined;
      return;
    }

    if (this.unlockPopoutTabId === removedTabId) {
      this.unlockPopoutTabId = undefined;
      this.messagingService.send("abandonAutofillPendingNotifications");
      return;
    }

    if (this.unlockPopoutTabId) {
      return;
    }

    const extensionUrl = BrowserApi.getRuntimeURL("popup/index.html");
    const extensionTabs = await BrowserApi.tabsQuery({ url: `${extensionUrl}*` });
    const unlockPopoutTabs = extensionTabs.filter((tab) =>
      tab.url?.includes(`singleActionPopout=${AuthPopoutType.unlockExtension}`),
    );

    if (unlockPopoutTabs.length === 0) {
      this.messagingService.send("abandonAutofillPendingNotifications");
    } else if (unlockPopoutTabs[0].id) {
      this.unlockPopoutTabId = unlockPopoutTabs[0].id;
    }
  }
}
