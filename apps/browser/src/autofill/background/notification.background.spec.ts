import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, combineLatest, firstValueFrom, map, of, Subject } from "rxjs";

import { CollectionService } from "@bitwarden/admin-console/common";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { PolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { Organization } from "@bitwarden/common/admin-console/models/domain/organization";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { AuthService } from "@bitwarden/common/auth/services/auth.service";
import { ExtensionCommand } from "@bitwarden/common/autofill/constants";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { AutofillSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/autofill-settings.service";
import { DomainSettingsService } from "@bitwarden/common/autofill/services/domain-settings.service";
import { UserNotificationSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/user-notification-settings.service";
import { ProductTierType } from "@bitwarden/common/billing/enums";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import { EnvironmentService } from "@bitwarden/common/platform/abstractions/environment.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { ThemeTypes } from "@bitwarden/common/platform/enums";
import {
  IntraprocessMessageSender,
  Message,
  MessageListener,
} from "@bitwarden/common/platform/messaging";
import { SelfHostedEnvironment } from "@bitwarden/common/platform/services/default-environment.service";
import { ThemeStateService } from "@bitwarden/common/platform/theming/theme-state.service";
import { mockAccountInfoWith } from "@bitwarden/common/spec";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { ChangeLoginPasswordService } from "@bitwarden/common/vault/abstractions/change-login-password.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherRepromptType } from "@bitwarden/common/vault/enums/cipher-reprompt-type";
import { VaultMessages } from "@bitwarden/common/vault/enums/vault-messages.enum";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FolderView } from "@bitwarden/common/vault/models/view/folder.view";
import { CipherService } from "@bitwarden/common/vault/services/cipher.service";
import { FolderService } from "@bitwarden/common/vault/services/folder/folder.service";
import { TaskService, SecurityTask } from "@bitwarden/common/vault/tasks";
import { SecurityTaskStatus, SecurityTaskType } from "@bitwarden/common/vault/tasks/enums";

import { BrowserApi } from "../../platform/browser/browser-api";
import { NotificationType } from "../enums/notification-type.enum";
import { Fido2Background } from "../fido2/background/abstractions/fido2.background";
import { FormData } from "../services/abstractions/autofill.service";
import { CipherUse, FillCipherPolicy } from "../services/abstractions/fill-cipher-policy";
import AutofillService from "../services/autofill.service";
import { DefaultFillCipherPolicy } from "../services/default-fill-cipher-policy";
import { DefaultMultiAccountFillCipherPolicy } from "../services/default-multi-account-fill-cipher-policy";
import { createAutofillPageDetailsMock, createChromeTabMock } from "../spec/autofill-mocks";
import {
  crossContextBoundary,
  flushPromises,
  sendMockExtensionMessage,
} from "../spec/testing-utils";

import {
  AddChangePasswordNotificationQueueMessage,
  AddLoginQueueMessage,
  AddUnlockVaultQueueMessage,
  ADD_TO_LOCKED_VAULT_PENDING_NOTIFICATIONS,
  LockedVaultPendingNotificationsData,
  NotificationBackgroundExtensionMessage,
  RETRY_SENDER,
  RETRY_WHEN_UNLOCK_COMPLETED,
} from "./abstractions/notification.background";
import { ModifyLoginCipherFormData } from "./abstractions/overlay-notifications.background";
import NotificationBackground from "./notification.background";

jest.mock("rxjs", () => {
  const rxjs = jest.requireActual("rxjs");
  const { firstValueFrom } = rxjs;
  return {
    ...rxjs,
    firstValueFrom: jest.fn(firstValueFrom),
  };
});

describe("NotificationBackground", () => {
  const messagingService = mock<MessagingService>();
  const taskService = mock<TaskService>();
  let notificationBackground: NotificationBackground;
  // A real channel rather than a mock: what is under test is that the class reads the
  // channel's own messages, which no mocked listener would demonstrate.
  let intraprocessMessageSender: IntraprocessMessageSender;
  let externalMessages: Subject<Message<Record<string, unknown>>>;
  const autofillService = mock<AutofillService>();
  const cipherService = mock<CipherService>();
  const fillCipherPolicy = mock<FillCipherPolicy>();
  const collectionService = mock<CollectionService>();
  let activeAccountStatusMock$: BehaviorSubject<AuthenticationStatus>;
  let authService: MockProxy<AuthService>;
  const policyAppliesToUser$ = new BehaviorSubject<boolean>(true);
  const policyService = mock<PolicyService>({
    policyAppliesToUser$: jest.fn().mockReturnValue(policyAppliesToUser$),
  });
  const folderService = mock<FolderService>();
  const enableChangedPasswordPromptMock$ = new BehaviorSubject(true);
  const enableAddedLoginPromptMock$ = new BehaviorSubject(true);
  const userNotificationSettingsService = mock<UserNotificationSettingsServiceAbstraction>();
  userNotificationSettingsService.enableChangedPasswordPrompt$ = enableChangedPasswordPromptMock$;
  userNotificationSettingsService.enableAddedLoginPrompt$ = enableAddedLoginPromptMock$;

  const domainSettingsService = mock<DomainSettingsService>();
  const environmentService = mock<EnvironmentService>();
  const logService = mock<LogService>();
  const selectedThemeMock$ = new BehaviorSubject(ThemeTypes.Light);
  const themeStateService = mock<ThemeStateService>();
  themeStateService.selectedTheme$ = selectedThemeMock$;
  const enableNotificationAnimationMock$ = new BehaviorSubject(true);
  autofillService.enableNotificationAnimation$ = enableNotificationAnimationMock$;
  const configService = mock<ConfigService>();
  const accountService = mock<AccountService>();
  const organizationService = mock<OrganizationService>();
  const fido2Background = mock<Fido2Background>();
  fido2Background.shouldDeferVaultNotificationsForPasskeyUi.mockReturnValue(false);
  const changeLoginPasswordService = mock<ChangeLoginPasswordService>();

  const userId = "testId" as UserId;
  const activeAccountSubject = new BehaviorSubject({
    id: userId,
    ...mockAccountInfoWith({
      email: "test@example.com",
      name: "Test User",
    }),
  });
  // The accounts that serve autofill besides the active one. Empty unless a test opts one in.
  let otherAutofillUserIds$: BehaviorSubject<UserId[]>;
  /** The ciphers of the active account, as a notification names them. */
  const cipherRefs = (...cipherIds: string[]) =>
    cipherIds.map((cipherId) => ({ userId, cipherId }));
  const autofillAccountsService = mock<AutofillAccountsService>();
  // Nothing the notification bar does may change the active account.
  const switchAccount = accountService.switchAccount;

  beforeEach(() => {
    intraprocessMessageSender = new IntraprocessMessageSender();
    externalMessages = new Subject<Message<Record<string, unknown>>>();
    activeAccountStatusMock$ = new BehaviorSubject(
      AuthenticationStatus.Locked as AuthenticationStatus,
    );
    authService = mock<AuthService>();
    authService.activeAccountStatus$ = activeAccountStatusMock$;
    accountService.activeAccount$ = activeAccountSubject;
    const storedCipherPolicy = new DefaultFillCipherPolicy(cipherService);
    fillCipherPolicy.ciphers.mockImplementation((...args) => storedCipherPolicy.ciphers(...args));
    fillCipherPolicy.ciphersForIds.mockImplementation((...args) =>
      storedCipherPolicy.ciphersForIds(...args),
    );
    fillCipherPolicy.ciphersForUrl.mockImplementation((...args) =>
      storedCipherPolicy.ciphersForUrl(...args),
    );
    fillCipherPolicy.canOfferSave.mockResolvedValue(true);
    otherAutofillUserIds$ = new BehaviorSubject<UserId[]>([]);
    // As `AutofillAccountsService` lists them: the active account while it is unlocked, then
    // the others.
    const autofillUserIds$ = combineLatest([
      activeAccountSubject,
      activeAccountStatusMock$,
      otherAutofillUserIds$,
    ]).pipe(
      map(([activeAccount, status, others]) => [
        ...(activeAccount && status === AuthenticationStatus.Unlocked ? [activeAccount.id] : []),
        ...others,
      ]),
    );
    (autofillAccountsService as any).autofillUserIds$ = autofillUserIds$;
    autofillAccountsService.isAutofillUser$.mockImplementation((id) =>
      autofillUserIds$.pipe(map((userIds) => userIds.includes(id))),
    );
    authService.authStatusFor$.mockReturnValue(of(AuthenticationStatus.Unlocked));
    notificationBackground = new NotificationBackground(
      accountService,
      authService,
      autofillService,
      cipherService,
      collectionService,
      configService,
      domainSettingsService,
      environmentService,
      folderService,
      logService,
      organizationService,
      policyService,
      themeStateService,
      userNotificationSettingsService,
      taskService,
      changeLoginPasswordService,
      messagingService,
      fido2Background,
      intraprocessMessageSender,
      // Wired as `MainBackground` wires it, so ingest tagging is exercised rather than faked.
      new MessageListener(intraprocessMessageSender.messages$({ external$: externalMessages })),
      new DefaultMultiAccountFillCipherPolicy(
        fillCipherPolicy,
        autofillAccountsService,
        mock<AutofillSettingsServiceAbstraction>(),
      ),
      autofillAccountsService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("convertAddLoginQueueMessageToCipherView", () => {
    it("returns a cipher view when passed an `AddLoginQueueMessage`", () => {
      const message: AddLoginQueueMessage = {
        type: "add",
        data: {
          username: "test",
          password: "password",
          uri: "https://example.com",
        },
        domain: "",
        tab: createChromeTabMock(),
        expires: new Date(),
        wasVaultLocked: false,
        userId,
        launchTimestamp: 0,
      };
      const cipherView = notificationBackground["convertAddLoginQueueMessageToCipherView"](message);

      expect(cipherView.name).toEqual("example.com");
      expect(cipherView.login).toEqual({
        fido2Credentials: [],
        password: message.data.password,
        uris: [
          {
            _uri: message.data.uri,
          },
        ],
        username: message.data.username,
      });
    });

    it("returns a cipher view assigned to an existing folder id", () => {
      const folderId = "folder-id";
      const message: AddLoginQueueMessage = {
        type: "add",
        data: {
          username: "test",
          password: "password",
          uri: "https://example.com",
        },
        domain: "example.com",
        tab: createChromeTabMock(),
        expires: new Date(),
        wasVaultLocked: false,
        userId,
        launchTimestamp: 0,
      };
      const cipherView = notificationBackground["convertAddLoginQueueMessageToCipherView"](
        message,
        folderId,
      );

      expect(cipherView.folderId).toEqual(folderId);
    });

    it("removes 'www.' prefix from hostname when generating cipher name", () => {
      const message: AddLoginQueueMessage = {
        type: "add",
        data: {
          username: "test",
          password: "password",
          uri: "https://www.example.com",
        },
        domain: "www.example.com",
        tab: createChromeTabMock(),
        expires: new Date(),
        wasVaultLocked: false,
        userId,
        launchTimestamp: 0,
      };
      const cipherView = notificationBackground["convertAddLoginQueueMessageToCipherView"](message);

      expect(cipherView.name).toEqual("example.com");
    });

    it("uses domain as fallback when hostname cannot be extracted from uri", () => {
      const message: AddLoginQueueMessage = {
        type: "add",
        data: {
          username: "test",
          password: "password",
          uri: "",
        },
        domain: "fallback-domain.com",
        tab: createChromeTabMock(),
        expires: new Date(),
        wasVaultLocked: false,
        userId,
        launchTimestamp: 0,
      };
      const cipherView = notificationBackground["convertAddLoginQueueMessageToCipherView"](message);

      expect(cipherView.name).toEqual("fallback-domain.com");
    });
  });

  describe("queueMessageIsFromTabOrigin", () => {
    const createQueueMessage = (tab: chrome.tabs.Tab, domain = "example.com") =>
      mock<AddLoginQueueMessage>({
        type: NotificationType.AddLogin,
        domain,
        tab,
        data: { username: "", password: "", uri: "" },
        expires: new Date(),
        wasVaultLocked: false,
        userId,
        launchTimestamp: 0,
      });

    it.each([
      {
        name: "returns false when the tab navigated away from the queued domain (shared tab reference)",
        tab: createChromeTabMock({ id: 1, url: "https://example.net" }),
        expected: false,
      },
      {
        name: "returns true when the tab URL matches the queued domain",
        tab: createChromeTabMock({ id: 1, url: "https://example.com/login" }),
        expected: true,
      },
      {
        name: "returns false when the tab URL has no extractable domain",
        tab: createChromeTabMock({ id: 1, url: undefined }),
        expected: false,
      },
    ])("$name", ({ tab, expected }) => {
      const message = createQueueMessage(tab);
      expect(notificationBackground["queueMessageIsFromTabOrigin"](message, tab)).toBe(expected);
    });
  });

  describe("getOrgData", () => {
    it("omits disabled organizations from the notification bar vault list for cipher flows", async () => {
      organizationService.organizations$.mockReturnValue(
        of([
          {
            id: "enabledOrg",
            name: "On",
            enabled: true,
            productTierType: ProductTierType.Teams,
          } as Organization,
          {
            id: "disabledOrg",
            name: "Off",
            enabled: false,
            productTierType: ProductTierType.Free,
          } as Organization,
        ]),
      );

      await expect(notificationBackground["getOrgData"](userId)).resolves.toEqual([
        { id: "enabledOrg", name: "On", productTierType: ProductTierType.Teams },
      ]);
    });

    it("returns an empty array when every organization is disabled", async () => {
      organizationService.organizations$.mockReturnValue(
        of([
          {
            id: "disabledOrgA",
            name: "Disabled Org A",
            enabled: false,
            productTierType: ProductTierType.Free,
          } as Organization,
          {
            id: "disabledOrgB",
            name: "Disabled Org B",
            enabled: false,
            productTierType: ProductTierType.Teams,
          } as Organization,
        ]),
      );

      await expect(notificationBackground["getOrgData"](userId)).resolves.toEqual([]);
    });

    it("returns every organization when all are enabled", async () => {
      organizationService.organizations$.mockReturnValue(
        of([
          {
            id: "firstEnabledOrg",
            name: "FirstOrg",
            enabled: true,
            productTierType: ProductTierType.Teams,
          } as Organization,
          {
            id: "secondEnabledOrg",
            name: "SecondOrg",
            enabled: true,
            productTierType: ProductTierType.Families,
          } as Organization,
          {
            id: "thirdDisabledOrg",
            name: "ThirdOrg",
            enabled: false,
            productTierType: ProductTierType.Families,
          } as Organization,
        ]),
      );

      await expect(notificationBackground["getOrgData"](userId)).resolves.toEqual([
        { id: "firstEnabledOrg", name: "FirstOrg", productTierType: ProductTierType.Teams },
        { id: "secondEnabledOrg", name: "SecondOrg", productTierType: ProductTierType.Families },
      ]);
    });
  });

  describe("notification bar extension message handlers and triggers", () => {
    beforeEach(() => {
      notificationBackground.init();
    });

    it("ignores messages whose command does not match the expected handlers", () => {
      const message: NotificationBackgroundExtensionMessage = { command: "unknown" };
      jest.spyOn(notificationBackground as any, "handleSaveCipherMessage");

      sendMockExtensionMessage(message);

      expect(notificationBackground["handleSaveCipherMessage"]).not.toHaveBeenCalled();
    });

    describe("unlockCompleted subscription", () => {
      it("sends a `closeNotificationBar` message if the retryCommand is for `autofill_login", async () => {
        const retrySender = mock<chrome.runtime.MessageSender>({ tab: { id: 1 } });
        const data = {
          commandToRetry: {
            message: { command: ExtensionCommand.AutofillLogin },
            [RETRY_SENDER]: retrySender,
          },
        } as LockedVaultPendingNotificationsData;
        jest.spyOn(BrowserApi, "tabSendMessageData").mockImplementation();

        intraprocessMessageSender.send(RETRY_WHEN_UNLOCK_COMPLETED, { data });
        await flushPromises();

        // The bar is closed in the tab the retry was queued for, which the background retained;
        // there is no `chrome.runtime` sender on an intraprocess message to fall back to.
        expect(BrowserApi.tabSendMessageData).toHaveBeenCalledWith(
          retrySender.tab,
          "closeNotificationBar",
        );
      });

      it("triggers a retryHandler if the message target is `notification.background` and a handler exists", async () => {
        const retrySender = mock<chrome.runtime.MessageSender>({
          tab: { id: 1 } as chrome.tabs.Tab,
        });
        const data = {
          commandToRetry: {
            message: { command: "bgSaveCipher" },
            [RETRY_SENDER]: retrySender,
          },
          target: "notification.background",
        } as LockedVaultPendingNotificationsData;
        jest.spyOn(notificationBackground as any, "handleSaveCipherMessage").mockImplementation();

        intraprocessMessageSender.send(RETRY_WHEN_UNLOCK_COMPLETED, { data });
        await flushPromises();

        expect(notificationBackground["handleSaveCipherMessage"]).toHaveBeenCalledWith(
          data.commandToRetry.message,
          data.commandToRetry[RETRY_SENDER],
        );
      });

      // Both effects of `handleUnlockCompleted` need a sender, and one fixture can only reach
      // one of them: an allowed retry command closes the bar but has no `extensionMessageHandlers`
      // entry, and `bgSaveCipher` has a handler but is not an allowed command.
      it.each([
        {
          effect: "closes the notification bar",
          command: ExtensionCommand.AutofillLogin,
        },
        {
          effect: "dispatches the retry handler",
          command: "bgSaveCipher",
        },
      ])(
        "security: drops a retry whose sender did not survive leaving this context, so it never $effect",
        async ({ command }) => {
          const data = crossContextBoundary({
            commandToRetry: {
              message: { command },
              [RETRY_SENDER]: { tab: createChromeTabMock({ id: 1 }) },
            },
            target: "notification.background",
          });
          jest.spyOn(BrowserApi, "tabSendMessageData").mockImplementation();
          jest.spyOn(notificationBackground as any, "handleSaveCipherMessage").mockImplementation();

          intraprocessMessageSender.send(RETRY_WHEN_UNLOCK_COMPLETED, { data });
          await flushPromises();

          expect(BrowserApi.tabSendMessageData).not.toHaveBeenCalled();
          expect(notificationBackground["handleSaveCipherMessage"]).not.toHaveBeenCalled();
        },
      );

      it("security: drops a retry whose sender names no tab", async () => {
        // Both effects act on the tab: the bar is closed in it, and the dispatched handlers read
        // it. A sender without one would reach `retryHandler` regardless.
        jest.spyOn(BrowserApi, "tabSendMessageData").mockImplementation();
        jest.spyOn(notificationBackground as any, "handleSaveCipherMessage").mockImplementation();

        intraprocessMessageSender.send(RETRY_WHEN_UNLOCK_COMPLETED, {
          data: {
            commandToRetry: {
              message: { command: "bgSaveCipher" },
              [RETRY_SENDER]: { frameId: 0 },
            },
            target: "notification.background",
          },
        });
        await flushPromises();

        expect(BrowserApi.tabSendMessageData).not.toHaveBeenCalled();
        expect(notificationBackground["handleSaveCipherMessage"]).not.toHaveBeenCalled();
      });

      it("security: ignores a retry that arrived from another context", async () => {
        // `commandToRetry.message.command` is dispatched through `extensionMessageHandlers`, so
        // honouring a payload from outside the background would be arbitrary handler dispatch
        // with an attacker-authored sender.
        jest.spyOn(notificationBackground as any, "handleSaveCipherMessage").mockImplementation();

        externalMessages.next({
          command: RETRY_WHEN_UNLOCK_COMPLETED.command,
          data: {
            commandToRetry: {
              message: { command: "bgSaveCipher" },
              [RETRY_SENDER]: { tab: createChromeTabMock({ id: 1 }) },
            },
            target: "notification.background",
          },
        } as unknown as Message<Record<string, unknown>>);
        await flushPromises();

        expect(notificationBackground["handleSaveCipherMessage"]).not.toHaveBeenCalled();
      });
    });

    describe("bgGetFolderData message handler", () => {
      it("returns a list of folders", async () => {
        const folderView = mock<FolderView>({ id: "folder-id" });
        const folderViews = [folderView];
        const message: NotificationBackgroundExtensionMessage = {
          command: "bgGetFolderData",
        };
        jest.spyOn(notificationBackground as any, "getFolderData");
        (firstValueFrom as jest.Mock).mockResolvedValueOnce(folderViews);

        sendMockExtensionMessage(message);
        await flushPromises();

        expect(notificationBackground["getFolderData"]).toHaveBeenCalled();
        expect(firstValueFrom).toHaveBeenCalled();
      });
    });

    describe("bgCloseNotificationBar message handler", () => {
      it("sends a `closeNotificationBar` message to the sender tab", async () => {
        const sender = mock<chrome.runtime.MessageSender>({ tab: { id: 1 } });
        const message: NotificationBackgroundExtensionMessage = {
          command: "bgCloseNotificationBar",
        };
        jest.spyOn(BrowserApi, "tabSendMessageData").mockImplementation();

        sendMockExtensionMessage(message, sender);
        await flushPromises();

        expect(BrowserApi.tabSendMessageData).toHaveBeenCalledWith(
          sender.tab,
          "closeNotificationBar",
          { fadeOutNotification: false },
        );
      });
    });

    describe("bgAdjustNotificationBar message handler", () => {
      it("sends a `adjustNotificationBar` message to the sender tab", async () => {
        const sender = mock<chrome.runtime.MessageSender>({ tab: { id: 1 } });
        const message: NotificationBackgroundExtensionMessage = {
          command: "bgAdjustNotificationBar",
          data: { height: 100 },
        };
        jest.spyOn(BrowserApi, "tabSendMessageData").mockImplementation();

        sendMockExtensionMessage(message, sender);
        await flushPromises();

        expect(BrowserApi.tabSendMessageData).toHaveBeenCalledWith(
          sender.tab,
          "adjustNotificationBar",
          message.data,
        );
      });
    });

    describe("bgOpenChangePasswordUrl message handler", () => {
      const tabUrl = "https://jest-testing-website.com";

      function createMockCipher(overrides: Partial<CipherView> = {}): CipherView {
        return {
          id: "cipher-1",
          deletedDate: null,
          ...overrides,
        } as CipherView;
      }

      function createMockSecurityTask(overrides: Partial<SecurityTask> = {}): SecurityTask {
        return {
          cipherId: "cipher-1",
          status: SecurityTaskStatus.Pending,
          type: SecurityTaskType.UpdateAtRiskCredential,
          ...overrides,
        } as SecurityTask;
      }

      let createNewTabSpy: jest.SpyInstance;

      beforeEach(() => {
        activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
        changeLoginPasswordService.getChangePasswordUrl.mockReset();
        taskService.tasksEnabled$.mockReturnValue(of(true));
        taskService.pendingTasks$.mockReturnValue(of([]));
        createNewTabSpy = jest.spyOn(BrowserApi, "createNewTab").mockResolvedValue(null as any);
      });

      it("opens a new tab with the trusted change-password URL when a matching cipher and task exist", async () => {
        const cipher = createMockCipher();
        const task = createMockSecurityTask();
        const sender = mock<chrome.runtime.MessageSender>({
          tab: { id: 1, url: tabUrl },
        });
        cipherService.getAllDecryptedForUrl.mockResolvedValue([cipher]);
        taskService.pendingTasks$.mockReturnValue(of([task]));
        changeLoginPasswordService.getChangePasswordUrl.mockResolvedValue(
          "https://jest-testing-website.com/.well-known/change-password",
        );

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledWith(
          tabUrl,
          userId,
          CipherUse.SecurityTask,
          undefined,
        );
        expect(changeLoginPasswordService.getChangePasswordUrl).toHaveBeenCalledWith(cipher);
        expect(createNewTabSpy).toHaveBeenCalledWith(
          "https://jest-testing-website.com/.well-known/change-password",
        );
      });

      it("does nothing when the sender tab has no URL", async () => {
        const sender = mock<chrome.runtime.MessageSender>({
          tab: { id: 1, url: undefined },
        });

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(cipherService.getAllDecryptedForUrl).not.toHaveBeenCalled();
        expect(createNewTabSpy).not.toHaveBeenCalled();
      });

      it("does nothing when there is no active user", async () => {
        const sender = mock<chrome.runtime.MessageSender>({
          tab: { id: 1, url: tabUrl },
        });
        activeAccountSubject.next(null as any);

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(cipherService.getAllDecryptedForUrl).not.toHaveBeenCalled();
        expect(createNewTabSpy).not.toHaveBeenCalled();

        // Restore active account for subsequent tests
        activeAccountSubject.next({
          id: userId,
          ...mockAccountInfoWith({ email: "test@example.com", name: "Test User" }),
        });
      });

      it("does nothing when no ciphers match the tab URL", async () => {
        const sender = mock<chrome.runtime.MessageSender>({
          tab: { id: 1, url: tabUrl },
        });
        cipherService.getAllDecryptedForUrl.mockResolvedValue([]);

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledWith(
          tabUrl,
          userId,
          CipherUse.SecurityTask,
          undefined,
        );
        expect(createNewTabSpy).not.toHaveBeenCalled();
      });

      it("does nothing when no pending security tasks exist", async () => {
        const cipher = createMockCipher();
        const sender = mock<chrome.runtime.MessageSender>({
          tab: { id: 1, url: tabUrl },
        });
        cipherService.getAllDecryptedForUrl.mockResolvedValue([cipher]);
        taskService.pendingTasks$.mockReturnValue(of([]));

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(cipherService.getAllDecryptedForUrl).toHaveBeenCalled();
        expect(createNewTabSpy).not.toHaveBeenCalled();
      });

      it("skips soft-deleted ciphers", async () => {
        const cipher = createMockCipher({ deletedDate: new Date() });
        const task = createMockSecurityTask();
        const sender = mock<chrome.runtime.MessageSender>({
          tab: { id: 1, url: tabUrl },
        });
        cipherService.getAllDecryptedForUrl.mockResolvedValue([cipher]);
        taskService.pendingTasks$.mockReturnValue(of([task]));

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(changeLoginPasswordService.getChangePasswordUrl).not.toHaveBeenCalled();
        expect(createNewTabSpy).not.toHaveBeenCalled();
      });

      it("does nothing when no task references any matched cipher", async () => {
        const cipher = createMockCipher({ id: "cipher-1" });
        const task = createMockSecurityTask({ cipherId: "cipher-999" as CipherId });
        const sender = mock<chrome.runtime.MessageSender>({
          tab: { id: 1, url: tabUrl },
        });
        cipherService.getAllDecryptedForUrl.mockResolvedValue([cipher]);
        taskService.pendingTasks$.mockReturnValue(of([task]));

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(changeLoginPasswordService.getChangePasswordUrl).not.toHaveBeenCalled();
        expect(createNewTabSpy).not.toHaveBeenCalled();
      });

      it("does nothing when getChangePasswordUrl returns null", async () => {
        const cipher = createMockCipher();
        const task = createMockSecurityTask();
        const sender = mock<chrome.runtime.MessageSender>({
          tab: { id: 1, url: tabUrl },
        });
        cipherService.getAllDecryptedForUrl.mockResolvedValue([cipher]);
        taskService.pendingTasks$.mockReturnValue(of([task]));
        changeLoginPasswordService.getChangePasswordUrl.mockResolvedValue(null);

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(changeLoginPasswordService.getChangePasswordUrl).toHaveBeenCalledWith(cipher);
        expect(createNewTabSpy).not.toHaveBeenCalled();
      });

      it("does nothing when sender has no tab", async () => {
        const sender = mock<chrome.runtime.MessageSender>({ tab: undefined });

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(createNewTabSpy).not.toHaveBeenCalled();
      });
    });

    describe("triggerCipherNotification message handler", () => {
      let tab: chrome.tabs.Tab;
      let sender: chrome.runtime.MessageSender;
      let getEnableChangedPasswordPromptSpy: jest.SpyInstance;
      let getEnableAddedLoginPromptSpy: jest.SpyInstance;
      let pushChangePasswordToQueueSpy: jest.SpyInstance;
      let pushAddLoginToQueueSpy: jest.SpyInstance;
      let getAllDecryptedForUrlSpy: jest.SpyInstance;
      const mockFormattedURI = "archive.org";
      const mockFormURI = "https://www.archive.org";
      const expectSkippedCheckingNotification = () => {
        expect(getAllDecryptedForUrlSpy).not.toHaveBeenCalled();
        expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
      };

      beforeEach(() => {
        tab = createChromeTabMock();
        sender = mock<chrome.runtime.MessageSender>({ tab });
        getEnableAddedLoginPromptSpy = jest.spyOn(
          notificationBackground as any,
          "getEnableAddedLoginPrompt",
        );
        getEnableChangedPasswordPromptSpy = jest.spyOn(
          notificationBackground as any,
          "getEnableChangedPasswordPrompt",
        );
        pushChangePasswordToQueueSpy = jest.spyOn(
          notificationBackground as any,
          "pushChangePasswordToQueue",
        );
        pushAddLoginToQueueSpy = jest.spyOn(notificationBackground as any, "pushAddLoginToQueue");
        getAllDecryptedForUrlSpy = jest.spyOn(cipherService, "getAllDecryptedForUrl");
      });

      afterEach(() => {
        getEnableAddedLoginPromptSpy.mockRestore();
        getEnableChangedPasswordPromptSpy.mockRestore();
        pushChangePasswordToQueueSpy.mockRestore();
        pushAddLoginToQueueSpy.mockRestore();
        getAllDecryptedForUrlSpy.mockRestore();
      });

      it("skips checking if a notification should trigger if no fields were filled", async () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "",
          password: "",
          uri: mockFormURI,
          username: "",
        };

        const storedCiphersForURL = [
          mock<CipherView>({
            id: "cipher-id-1",
            login: { password: "I<3VogonPoetry", username: "ADent" },
          }),
        ];

        activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
        getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

        await notificationBackground.triggerCipherNotification(formEntryData, tab);

        expectSkippedCheckingNotification();
      });

      it("skips checking if a notification should trigger if the passed url is not valid", async () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "Bab3lPhs5h",
          password: "I<3VogonPoetry",
          uri: "",
          username: "ADent",
        };

        const storedCiphersForURL = [
          mock<CipherView>({
            id: "cipher-id-1",
            login: { password: "I<3VogonPoetry", username: "ADent" },
          }),
        ];

        activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
        getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

        await notificationBackground.triggerCipherNotification(formEntryData, tab);

        expectSkippedCheckingNotification();
      });

      it("skips checking if a notification should trigger when a passkey picker is active for the tab", async () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "",
          password: "",
          uri: mockFormURI,
          username: "ADent",
        };

        activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
        fido2Background.shouldDeferVaultNotificationsForPasskeyUi.mockReturnValueOnce(true);

        await notificationBackground.triggerCipherNotification(formEntryData, tab);

        expectSkippedCheckingNotification();
      });

      it("skips checking if a notification should trigger if the user has disabled both the new login and update password notification", async () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "Bab3lPhs5h",
          password: "I<3VogonPoetry",
          uri: mockFormURI,
          username: "ADent",
        };

        const storedCiphersForURL = [
          mock<CipherView>({ login: { username: "ADent", password: "I<3VogonPoetry" } }),
        ];

        activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
        getEnableChangedPasswordPromptSpy.mockReturnValueOnce(false);
        getEnableAddedLoginPromptSpy.mockReturnValueOnce(false);
        getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

        await notificationBackground.triggerCipherNotification(formEntryData, tab);

        expectSkippedCheckingNotification();
      });

      it("skips checking if a notification should trigger if the user is logged out", async () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "Bab3lPhs5h",
          password: "I<3VogonPoetry",
          uri: mockFormURI,
          username: "ADent",
        };

        const storedCiphersForURL = [
          mock<CipherView>({ login: { username: "ADent", password: "I<3VogonPoetry" } }),
        ];

        activeAccountStatusMock$.next(AuthenticationStatus.LoggedOut);
        getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

        await notificationBackground.triggerCipherNotification(formEntryData, tab);

        expectSkippedCheckingNotification();
      });

      it("skips checking if a notification should trigger if there is no active account", async () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "Bab3lPhs5h",
          password: "I<3VogonPoetry",
          uri: mockFormURI,
          username: "ADent",
        };

        const storedCiphersForURL = [
          mock<CipherView>({ login: { username: "ADent", password: "I<3VogonPoetry" } }),
        ];

        accountService.activeAccount$ = new BehaviorSubject(null);
        getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

        await notificationBackground.triggerCipherNotification(formEntryData, tab);

        expectSkippedCheckingNotification();
      });

      it("skips checking if a notification should trigger if the values for the `password` and `newPassword` fields match (no change)", async () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "Beeblebrox4Prez",
          password: "Beeblebrox4Prez",
          uri: mockFormURI,
          username: "ADent",
        };

        const storedCiphersForURL = [
          mock<CipherView>({ login: { username: "ADent", password: "I<3VogonPoetry" } }),
        ];

        getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

        await notificationBackground.triggerCipherNotification(formEntryData, tab);

        expectSkippedCheckingNotification();
      });

      it("skips checking if a notification should trigger if the vault is locked and there is no value for the `newPassword` field", async () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "",
          password: "Beeblebrox4Prez",
          uri: mockFormURI,
          username: "ADent",
        };

        const storedCiphersForURL = [
          mock<CipherView>({ login: { username: "ADent", password: "I<3VogonPoetry" } }),
        ];

        activeAccountStatusMock$.next(AuthenticationStatus.Locked);
        getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

        await notificationBackground.triggerCipherNotification(formEntryData, tab);

        expectSkippedCheckingNotification();
      });

      describe("when `username` and `password` and `newPassword` fields are filled, ", () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "Edro2x",
          password: "UShallKnotPassword",
          uri: mockFormURI,
          username: "gandalfG",
        };

        it("and the user vault is locked, trigger an unlock notification", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "Edro2x", username: "shadowfax" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Locked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(getAllDecryptedForUrlSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();

          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            null,
            mockFormattedURI,
            formEntryData.newPassword,
            tab,
            true, // will yield an unlock prompt followed by an update password prompt
          );
        });

        it("and cipher update candidates match `newPassword` only, trigger a new cipher notification", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "Edro2x", username: "shadowfax" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledWith(
            formEntryData.uri,
            userId,
            CipherUse.SavePrompt,
            undefined,
          );

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).toHaveBeenCalledWith(
            mockFormattedURI,
            {
              password: formEntryData.newPassword,
              url: formEntryData.uri,
              username: formEntryData.username,
            },
            sender.tab,
          );
        });

        it("and cipher update candidates match `newPassword` only, do not trigger a new cipher notification if the new cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "Edro2x", username: "shadowfax" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableAddedLoginPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates match `password` only, trigger an update cipher notification with those candidates", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "UShallKnotPassword", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "UShallKnotPassword", username: "shadowfax" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-1", "cipher-id-2"),
            mockFormattedURI,
            formEntryData.newPassword,
            sender.tab,
          );
        });

        it("and cipher update candidates match `password` only, do not trigger an update cipher notification if the update notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "UShallKnotPassword", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "UShallKnotPassword", username: "shadowfax" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableChangedPasswordPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates match `password` only, as well as `newPassword` only, trigger a new cipher notification", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "UShallKnotPassword", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "Edro2x", username: "TBombadil" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "UShallKnotPassword", username: "shadowfax" },
            }),
            mock<CipherView>({
              id: "cipher-id-4",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).toHaveBeenCalledWith(
            mockFormattedURI,
            {
              password: formEntryData.newPassword,
              url: formEntryData.uri,
              username: formEntryData.username,
            },
            sender.tab,
          );
        });

        it("and cipher update candidates match `username` only, trigger an update cipher notification with those candidates", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "EdroEdro", username: "gandalfG" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-2"),
            mockFormattedURI,
            formEntryData.newPassword,
            sender.tab,
          );
        });

        it("and cipher update candidates match `username` only, do not trigger an update cipher notification if the update notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "EdroEdro", username: "gandalfG" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableChangedPasswordPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates match `username` only, as well as `password` or `newPassword` only, trigger an update cipher notification with the candidates `username`", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "UShallKnotPassword", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "Edro2x", username: "BBaggins" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "EdroEdro", username: "gandalfG" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-3"),
            mockFormattedURI,
            formEntryData.newPassword,
            sender.tab,
          );
        });

        it("and cipher update candidates match `username` and `newPassword`, do not trigger an update (nothing to change)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "sting123", username: "BBaggins" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "Edro2x", username: "gandalfG" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates match `username` and `newPassword` as well as any other combination of `username`, `password`, and/or `newPassword`, do not trigger an update (nothing to change)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "sting123", username: "BBaggins" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "Edro2x", username: "gandalfG" },
            }),
            mock<CipherView>({
              id: "cipher-id-4",
              login: { password: "UShallKnotPassword", username: "gandalfG" },
            }),
            mock<CipherView>({
              id: "cipher-id-5",
              login: { password: "Edro2x", username: "FBaggins" },
            }),
            mock<CipherView>({
              id: "cipher-id-6",
              login: { password: "UShallKnotPassword", username: "TBombadil" },
            }),
            mock<CipherView>({
              id: "cipher-id-7",
              login: { password: "ShyerH1re", username: "gandalfG" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates match `username` and `password`, trigger an update cipher notification with those candidates", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "UShallKnotPassword", username: "gandalfG" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-1"),
            mockFormattedURI,
            formEntryData.newPassword,
            sender.tab,
          );
        });

        it("and cipher update candidates match `username` and `password`, do not trigger an update cipher notification if the update notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "UShallKnotPassword", username: "gandalfG" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableChangedPasswordPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates match `username` AND `password` as well as any OTHER combination of `username`, `password`, and/or `newPassword` (excluding `username` AND `newPassword`), trigger an update cipher notification with the candidates matching `username` AND `password`", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "UShallKnotPassword", username: "TBombadil" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "Edro2x", username: "shadowfax" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "UShallKnotPassword", username: "gandalfG" },
            }),
            mock<CipherView>({
              id: "cipher-id-4",
              login: { password: "flyUPh00lz", username: "gandalfG" },
            }),
            mock<CipherView>({
              id: "cipher-id-5",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-6",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-3"),
            mockFormattedURI,
            formEntryData.newPassword,
            sender.tab,
          );
        });

        it("and no cipher update candidates match `username`, `password`, nor `newPassword`, trigger a new cipher notification", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "EdroEdro", username: "shadowfax" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).toHaveBeenCalledWith(
            mockFormattedURI,
            {
              password: formEntryData.newPassword,
              url: formEntryData.uri,
              username: formEntryData.username,
            },
            sender.tab,
          );
        });

        it("and no cipher update candidates match `username`, `password`, nor `newPassword`, do not trigger a new cipher notification if the new cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { password: "galadriel4Eva", username: "gandalfW" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { password: "EdroEdro", username: "shadowfax" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { password: "sting123", username: "BBaggins" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableAddedLoginPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });
      });

      describe("when `username` and `newPassword` fields are filled, ", () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "2ndBreakf4st",
          password: "",
          uri: mockFormURI,
          username: "BBaggins",
        };

        it("and the user vault is locked, trigger an unlock notification", async () => {
          activeAccountStatusMock$.next(AuthenticationStatus.Locked);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(getAllDecryptedForUrlSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();

          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            null,
            mockFormattedURI,
            formEntryData.newPassword,
            tab,
            true, // will yield an unlock followed by an update password notification
          );
        });

        it("and cipher update candidates match only `newPassword`, do not trigger a notification", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "Frodo", password: "oldPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "Pippin", password: "2ndBreakf4st" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates match only `username`, trigger an update cipher notification with those candidates", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "BBaggins", password: "oldPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "Frodo", password: "differentPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "Pippin", password: "2ndBreakf4st" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-1"),
            mockFormattedURI,
            formEntryData.newPassword,
            sender.tab,
          );
        });

        it("and at least one cipher update candidate matches both `username` and `newPassword`, do not trigger an update (nothing to change)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "BBaggins", password: "oldPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "BBaggins", password: "2ndBreakf4st" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "Frodo", password: "differentPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and no cipher update candidates match `username` nor `newPassword`, trigger a new cipher notification", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "Frodo", password: "oldPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "Pippin", password: "differentPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).toHaveBeenCalledWith(
            mockFormattedURI,
            {
              password: formEntryData.newPassword,
              url: formEntryData.uri,
              username: formEntryData.username,
            },
            sender.tab,
          );
        });

        it("and no cipher update candidates match `username` nor `newPassword`, do not trigger a new cipher notification if the new cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "Frodo", password: "oldPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "Pippin", password: "differentPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableAddedLoginPromptSpy.mockReturnValueOnce(false);
          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });
      });

      describe("when only `username` field is filled, ", () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "",
          password: "",
          uri: mockFormURI,
          username: "BBaggins",
        };

        it("and the user vault is locked, do not trigger a notification", async () => {
          activeAccountStatusMock$.next(AuthenticationStatus.Locked);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expectSkippedCheckingNotification();
        });

        it("and at least one cipher update candidate matches `username`, do not trigger a notification (nothing to change)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "BBaggins", password: "password1" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "Frodo", password: "password2" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and no cipher update candidates match `username`, do not trigger a notification (username alone is insufficient signal)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "Frodo", password: "password1" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "Pippin", password: "password2" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and no cipher update candidates match `username`, do not trigger a new cipher notification if the new cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "Frodo", password: "password1" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "Pippin", password: "password2" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableAddedLoginPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });
      });

      describe("when `password` and `newPassword` fields are filled, ", () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "4WzrdIzN0tLa7e",
          password: "UShallKnotPassword",
          username: "",
          uri: mockFormURI,
        };

        it("and the user vault is locked, trigger an unlock notification", async () => {
          activeAccountStatusMock$.next(AuthenticationStatus.Locked);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(getAllDecryptedForUrlSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();

          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            null,
            mockFormattedURI,
            formEntryData.newPassword,
            tab,
            true, // will yield an unlock followed by an update password notification
          );
        });

        it("and cipher update candidates only match `newPassword`, do not trigger a notification (nothing to change)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "GaldalfG", password: "4WzrdIzN0tLa7e" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "GaldalfW", password: "4WzrdIzN0tLa7e" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates only match `password`, trigger an update cipher notification with those candidates", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "Frodo", password: "PutAR1ngOnIt" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "Pippin", password: "UShallKnotPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "Merry", password: "UShallKnotPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-2", "cipher-id-3"),
            mockFormattedURI,
            formEntryData.newPassword,
            sender.tab,
          );
        });

        it("and cipher update candidates only match `password`, do not trigger an update cipher notification if the update cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "Frodo", password: "PutAR1ngOnIt" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "Pippin", password: "UShallKnotPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "Merry", password: "UShallKnotPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableChangedPasswordPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and no cipher update candidates match `password` or `newPassword`, trigger a new cipher notification", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "Frodo", password: "PutAR1ngOnIt" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "PTook", password: "11sies" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).toHaveBeenCalledWith(
            mockFormattedURI,
            {
              password: formEntryData.newPassword,
              url: formEntryData.uri,
              username: formEntryData.username,
            },
            sender.tab,
          );
        });
      });

      describe("when only `password` field is filled, ", () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "",
          password: "UShallKnotPassword",
          uri: mockFormURI,
          username: "",
        };

        it("and the user vault is locked, do not trigger an unlock notification", async () => {
          activeAccountStatusMock$.next(AuthenticationStatus.Locked);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expectSkippedCheckingNotification();
        });

        it("and cipher update candidates only match `password`, do not trigger a notification (nothing to change)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "UShallKnotPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "BBaggins", password: "UShallKnotPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and no cipher update candidates match `password`, trigger an update cipher notification with ALL cipher update candidates", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "PutAR1ngOnIt" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "BBaggins", password: "MahPr3c10us" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "PTook", password: "f00lOfAT00k" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-1", "cipher-id-2", "cipher-id-3"),
            mockFormattedURI,
            formEntryData.password,
            sender.tab,
          );
        });

        it("and no cipher update candidates match `password`, do not trigger an update cipher notification if the update cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "PutAR1ngOnIt" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "BBaggins", password: "MahPr3c10us" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "PTook", password: "f00lOfAT00k" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableChangedPasswordPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and no ciphers are saved for the URL, trigger a new cipher notification", async () => {
          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce([]);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).toHaveBeenCalledWith(
            mockFormattedURI,
            {
              username: formEntryData.username,
              url: formEntryData.uri,
              password: formEntryData.password,
            },
            sender.tab,
          );
        });
      });

      describe("when `username` and `password` fields are filled, ", () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "",
          password: "ShyerH1re",
          uri: mockFormURI,
          username: "BBaggins",
        };

        it("and cipher update candidates only match `password`, trigger an update cipher notification with those candidates", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "ShyerH1re" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "PTook", password: "ShyerH1re" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "FrodoB", password: "UShallKnotPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-1", "cipher-id-2"),
            mockFormattedURI,
            formEntryData.password,
            sender.tab,
          );
        });

        it("and cipher update candidates only match `password`, do not trigger an update cipher notification if the update cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "ShyerH1re" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "PTook", password: "ShyerH1re" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "FrodoB", password: "UShallKnotPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableChangedPasswordPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates only match `username`, trigger an update cipher notification with those candidates", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "BBaggins", password: "W0nWr1ng" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "BBaggins", password: "UShallKnotPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "BilboB", password: "UShallKnotPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-1", "cipher-id-2"),
            mockFormattedURI,
            formEntryData.password,
            sender.tab,
          );
        });

        it("and cipher update candidates only match `username`, do not trigger an update cipher notification if the update cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "BBaggins", password: "W0nWr1ng" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "BBaggins", password: "UShallKnotPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "BilboB", password: "UShallKnotPassword" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableChangedPasswordPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates match `username` and `password`, do not trigger a notification (nothing to change)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "BBaggins", password: "ShyerH1re" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "FBaggins", password: "W0nWr1ng" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "BBaggins", password: "ShyerH1re" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and cipher update candidates match `username` AND `password` and additionally `username` OR `password`, do not trigger a notification (nothing to change)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "BBaggins", password: "UShallKnotPassword" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "BBaggins", password: "ShyerH1re" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "FBaggins", password: "W0nWr1ng" },
            }),
            mock<CipherView>({
              id: "cipher-id-4",
              login: { username: "TBombadil", password: "ShyerH1re" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and no cipher update candidates match `username` or `password`, trigger a new cipher notification", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "W0nWr1ng" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "BilboB", password: "PutAR1ngOnIt" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).toHaveBeenCalledWith(
            mockFormattedURI,
            {
              password: formEntryData.password,
              url: formEntryData.uri,
              username: formEntryData.username,
            },
            sender.tab,
          );
        });

        it("and no cipher update candidates match `username` or `password`, do not trigger a new cipher notification if the new cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "W0nWr1ng" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "BilboB", password: "PutAR1ngOnIt" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableAddedLoginPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });
      });

      describe("when only `newPassword` field is filled, ", () => {
        const formEntryData: ModifyLoginCipherFormData = {
          newPassword: "ShyerH1re",
          password: "",
          uri: mockFormURI,
          username: "",
        };

        it("and the user vault is locked, trigger an unlock notification", async () => {
          activeAccountStatusMock$.next(AuthenticationStatus.Locked);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(getAllDecryptedForUrlSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();

          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            null,
            mockFormattedURI,
            formEntryData.newPassword,
            tab,
            true, // will yield an unlock followed by an update password notification
          );
        });

        it("and cipher update candidates only match `newPassword`, do not trigger a notification (nothing to change)", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "ShyerH1re" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "PTook", password: "ShyerH1re" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and no cipher update candidates match `newPassword`, trigger an update cipher notification with ALL cipher update candidates", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "W0nWr1ng" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "PTook", password: "PutAR1ngOnIt" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "SamwiseG", password: "P0t4toes" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
          expect(pushChangePasswordToQueueSpy).toHaveBeenCalledWith(
            cipherRefs("cipher-id-1", "cipher-id-2", "cipher-id-3"),
            mockFormattedURI,
            formEntryData.newPassword,
            sender.tab,
          );
        });

        it("and no cipher update candidates match `newPassword`, do not trigger an update cipher notification if the update cipher notification setting is disabled", async () => {
          const storedCiphersForURL = [
            mock<CipherView>({
              id: "cipher-id-1",
              login: { username: "FBaggins", password: "W0nWr1ng" },
            }),
            mock<CipherView>({
              id: "cipher-id-2",
              login: { username: "PTook", password: "PutAR1ngOnIt" },
            }),
            mock<CipherView>({
              id: "cipher-id-3",
              login: { username: "SamwiseG", password: "P0t4toes" },
            }),
          ];

          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce(storedCiphersForURL);
          getEnableChangedPasswordPromptSpy.mockReturnValueOnce(false);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).not.toHaveBeenCalled();
        });

        it("and no ciphers are saved for the URL, trigger a new cipher notification", async () => {
          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getAllDecryptedForUrlSpy.mockResolvedValueOnce([]);

          await notificationBackground.triggerCipherNotification(formEntryData, tab);

          expect(pushChangePasswordToQueueSpy).not.toHaveBeenCalled();
          expect(pushAddLoginToQueueSpy).toHaveBeenCalledWith(
            mockFormattedURI,
            {
              username: formEntryData.username,
              url: formEntryData.uri,
              password: formEntryData.newPassword,
            },
            sender.tab,
          );
        });
      });
    });

    describe("bgRemoveTabFromNotificationQueue message handler", () => {
      it("splices a notification queue item based on the passed tab", async () => {
        const tab = createChromeTabMock({ id: 2 });
        const sender = mock<chrome.runtime.MessageSender>({ tab });
        const message: NotificationBackgroundExtensionMessage = {
          command: "bgRemoveTabFromNotificationQueue",
        };
        const removeTabFromNotificationQueueSpy = jest.spyOn(
          notificationBackground as any,
          "removeTabFromNotificationQueue",
        );
        const firstQueueMessage = mock<AddLoginQueueMessage>({
          userId,
          tab: createChromeTabMock({ id: 1 }),
        });
        const secondQueueMessage = mock<AddLoginQueueMessage>({ tab });
        const thirdQueueMessage = mock<AddLoginQueueMessage>({
          userId,
          tab: createChromeTabMock({ id: 3 }),
        });
        notificationBackground["notificationQueue"] = [
          firstQueueMessage,
          secondQueueMessage,
          thirdQueueMessage,
        ];

        sendMockExtensionMessage(message, sender);
        await flushPromises();

        expect(removeTabFromNotificationQueueSpy).toHaveBeenCalledWith(tab);
        expect(notificationBackground["notificationQueue"]).toEqual([
          firstQueueMessage,
          thirdQueueMessage,
        ]);
      });
    });

    describe("bgSaveCipher message handler", () => {
      let tabSendMessageDataSpy: jest.SpyInstance;
      let openUnlockPopoutSpy: jest.SpyInstance;

      beforeEach(() => {
        tabSendMessageDataSpy = jest.spyOn(BrowserApi, "tabSendMessageData").mockImplementation();
        openUnlockPopoutSpy = jest
          .spyOn(notificationBackground as any, "openUnlockPopout")
          .mockImplementation();
      });

      it("skips saving the cipher and opens an unlock popout if the extension is not unlocked", async () => {
        const sender = mock<chrome.runtime.MessageSender>({ tab: { id: 1 } });
        const message: NotificationBackgroundExtensionMessage = {
          command: "bgSaveCipher",
          edit: false,
          folder: "folder-id",
        };
        activeAccountStatusMock$.next(AuthenticationStatus.Locked);

        sendMockExtensionMessage(message, sender);
        await flushPromises();

        // The retry is queued by the callback `openUnlockPopout` runs once the popout exists,
        // so invoking it here is what proves the payload reaches the intraprocess channel.
        expect(openUnlockPopoutSpy).toHaveBeenCalledWith(sender.tab, expect.any(Function));
        const queued: unknown[] = [];
        intraprocessMessageSender.messages$().subscribe((published) => queued.push(published));
        openUnlockPopoutSpy.mock.calls[0][1]();

        expect(queued).toEqual([
          {
            command: ADD_TO_LOCKED_VAULT_PENDING_NOTIFICATIONS.command,
            data: {
              commandToRetry: { message, [RETRY_SENDER]: sender },
              target: "notification.background",
            },
          },
        ]);
      });

      describe("saveOrUpdateCredentials", () => {
        let getDecryptedCipherByIdSpy: jest.SpyInstance;
        let getAllDecryptedForUrlSpy: jest.SpyInstance;
        let updatePasswordSpy: jest.SpyInstance;
        let convertAddLoginQueueMessageToCipherViewSpy: jest.SpyInstance;
        let tabSendMessageSpy: jest.SpyInstance;
        let editItemSpy: jest.SpyInstance;
        let setAddEditCipherInfoSpy: jest.SpyInstance;
        let openAddEditVaultItemPopoutSpy: jest.SpyInstance;
        let createWithServerSpy: jest.SpyInstance;
        let updateWithServerSpy: jest.SpyInstance;
        let folderExistsSpy: jest.SpyInstance;

        beforeEach(() => {
          activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
          getDecryptedCipherByIdSpy = jest.spyOn(
            notificationBackground as any,
            "getDecryptedCipherById",
          );
          getAllDecryptedForUrlSpy = jest.spyOn(cipherService, "getAllDecryptedForUrl");
          updatePasswordSpy = jest.spyOn(notificationBackground as any, "updatePassword");
          convertAddLoginQueueMessageToCipherViewSpy = jest.spyOn(
            notificationBackground as any,
            "convertAddLoginQueueMessageToCipherView",
          );
          tabSendMessageSpy = jest.spyOn(BrowserApi, "tabSendMessage").mockImplementation();
          editItemSpy = jest.spyOn(notificationBackground as any, "editItem");
          setAddEditCipherInfoSpy = jest.spyOn(cipherService, "setAddEditCipherInfo");
          openAddEditVaultItemPopoutSpy = jest.spyOn(
            notificationBackground as any,
            "openAddEditVaultItemPopout",
          );
          createWithServerSpy = jest.spyOn(cipherService, "createWithServer");
          updateWithServerSpy = jest.spyOn(cipherService, "updateWithServer");
          folderExistsSpy = jest.spyOn(notificationBackground as any, "folderExists");

          accountService.activeAccount$ = activeAccountSubject;
        });

        it("skips saving the cipher if the notification queue does not have a tab that is related to the sender", async () => {
          const sender = mock<chrome.runtime.MessageSender>({ tab: { id: 2 } });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          notificationBackground["notificationQueue"] = [
            mock<AddLoginQueueMessage>({
              userId,
              tab: createChromeTabMock({ id: 1 }),
            }),
          ];

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(updatePasswordSpy).not.toHaveBeenCalled();
          expect(editItemSpy).not.toHaveBeenCalled();
          expect(createWithServerSpy).not.toHaveBeenCalled();
        });

        it("skips saving the cipher if the notification queue does not contain an AddLogin or ChangePassword type", async () => {
          const tab = createChromeTabMock({ id: 1 });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          notificationBackground["notificationQueue"] = [
            mock<AddUnlockVaultQueueMessage>({
              userId,
              tab,
              type: NotificationType.UnlockVault,
            }),
          ];

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(updatePasswordSpy).not.toHaveBeenCalled();
          expect(editItemSpy).not.toHaveBeenCalled();
          expect(createWithServerSpy).not.toHaveBeenCalled();
        });

        it("skips saving the cipher if the notification queue message has a different domain than the passed tab", () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          notificationBackground["notificationQueue"] = [
            mock<AddLoginQueueMessage>({
              userId,
              type: NotificationType.AddLogin,
              tab,
              domain: "another.com",
            }),
          ];

          sendMockExtensionMessage(message, sender);
          expect(updatePasswordSpy).not.toHaveBeenCalled();
          expect(editItemSpy).not.toHaveBeenCalled();
          expect(createWithServerSpy).not.toHaveBeenCalled();
        });

        it("updates the password if the notification message type is for ChangePassword", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          const queueMessage = mock<AddChangePasswordNotificationQueueMessage>({
            userId,
            type: NotificationType.ChangePassword,
            tab,
            domain: "example.com",
            data: { newPassword: "newPassword", cipherIds: [], cipherRefs: [] },
          });
          notificationBackground["notificationQueue"] = [queueMessage];
          const cipherView = mock<CipherView>({
            id: "testId",
            name: "testItemName",
            login: { username: "testUser" },
            reprompt: CipherRepromptType.None,
          });
          getDecryptedCipherByIdSpy.mockResolvedValueOnce(cipherView);
          taskService.tasksEnabled$.mockImplementation(() => of(false));

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(editItemSpy).not.toHaveBeenCalled();
          expect(createWithServerSpy).not.toHaveBeenCalled();
          expect(updatePasswordSpy).toHaveBeenCalledWith(
            cipherView,
            queueMessage.data.newPassword,
            message.edit,
            sender.tab,
            "testId",
            false,
          );
          expect(updateWithServerSpy).toHaveBeenCalled();
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(
            sender.tab,
            "saveCipherAttemptCompleted",
            {
              itemName: "testItemName",
              cipherId: cipherView.id,
              task: undefined,
            },
          );
        });

        it("prompts the user for master password entry if the notification message type is for ChangePassword and the cipher reprompt is enabled", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          const queueMessage = mock<AddChangePasswordNotificationQueueMessage>({
            userId,
            type: NotificationType.ChangePassword,
            tab,
            domain: "example.com",
            data: { newPassword: "newPassword", cipherIds: [], cipherRefs: [] },
          });
          notificationBackground["notificationQueue"] = [queueMessage];
          const cipherView = mock<CipherView>({
            id: "testId",
            name: "testItemName",
            login: { username: "testUser" },
            reprompt: CipherRepromptType.Password,
          });
          getDecryptedCipherByIdSpy.mockResolvedValueOnce(cipherView);
          taskService.tasksEnabled$.mockImplementation(() => of(false));
          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(editItemSpy).not.toHaveBeenCalled();
          expect(autofillService.isPasswordRepromptRequired).toHaveBeenCalled();
          expect(createWithServerSpy).not.toHaveBeenCalled();
          expect(updatePasswordSpy).toHaveBeenCalledWith(
            cipherView,
            queueMessage.data.newPassword,
            message.edit,
            sender.tab,
            "testId",
            false,
          );
          expect(updateWithServerSpy).not.toHaveBeenCalled();
          expect(tabSendMessageDataSpy).not.toHaveBeenCalledWith(
            sender.tab,
            "saveCipherAttemptCompleted",
            {
              itemName: "testItemName",
              cipherId: cipherView.id,
              task: undefined,
            },
          );
        });

        it("completes password update notification with a security task notice if any are present for the cipher, and dismisses tasks for the updated cipher", async () => {
          const mockCipherId = "testId";
          const mockOrgId = "testOrgId";
          const mockSecurityTask = {
            id: "testTaskId",
            organizationId: mockOrgId,
            cipherId: mockCipherId,
            type: 0,
            status: 0,
            creationDate: new Date(),
            revisionDate: new Date(),
          } as SecurityTask;
          const mockSecurityTask2 = {
            ...mockSecurityTask,
            id: "testTaskId2",
            cipherId: "testId2",
          } as SecurityTask;
          taskService.tasksEnabled$.mockImplementation(() => of(true));
          taskService.pendingTasks$.mockImplementation(() =>
            of([mockSecurityTask, mockSecurityTask2]),
          );
          jest.spyOn(notificationBackground as any, "getOrgData").mockResolvedValueOnce([
            {
              id: mockOrgId,
              name: "Org Name, LLC",
              productTierType: 3,
            },
          ]);

          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          const queueMessage = mock<AddChangePasswordNotificationQueueMessage>({
            userId,
            type: NotificationType.ChangePassword,
            tab,
            domain: "example.com",
            data: { newPassword: "newPassword", cipherIds: [], cipherRefs: [] },
          });
          notificationBackground["notificationQueue"] = [queueMessage];
          const cipherView = mock<CipherView>({
            id: mockCipherId,
            organizationId: mockOrgId,
            name: "Test Item",
            reprompt: CipherRepromptType.None,
          });
          getDecryptedCipherByIdSpy.mockResolvedValueOnce(cipherView);

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(editItemSpy).not.toHaveBeenCalled();
          expect(createWithServerSpy).not.toHaveBeenCalled();
          expect(updatePasswordSpy).toHaveBeenCalledWith(
            cipherView,
            queueMessage.data.newPassword,
            message.edit,
            sender.tab,
            mockCipherId,
            false,
          );
          expect(updateWithServerSpy).toHaveBeenCalled();
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(
            sender.tab,
            "saveCipherAttemptCompleted",
            {
              cipherId: "testId",
              itemName: "Test Item",
              task: {
                orgName: "Org Name, LLC",
                remainingTasksCount: 1,
              },
            },
          );
        });

        it("drops an AddLogin save the fill cipher policy does not offer", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const data = { username: "test", password: "revealed", uri: "https://example.com" };
          notificationBackground["notificationQueue"] = [
            mock<AddLoginQueueMessage>({
              type: NotificationType.AddLogin,
              tab,
              domain: "example.com",
              data,
              wasVaultLocked: false,
              userId,
            }),
          ];
          fillCipherPolicy.canOfferSave.mockResolvedValueOnce(false);

          sendMockExtensionMessage({ command: "bgSaveCipher", edit: false }, sender);
          await flushPromises();

          expect(fillCipherPolicy.canOfferSave).toHaveBeenCalledWith(data, userId);
          expect(notificationBackground["notificationQueue"]).toHaveLength(0);
          expect(createWithServerSpy).not.toHaveBeenCalled();
          expect(updatePasswordSpy).not.toHaveBeenCalled();
          expect(editItemSpy).not.toHaveBeenCalled();
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(tab, "closeNotificationBar", {
            closedByUser: false,
          });
          expect(tabSendMessageDataSpy).not.toHaveBeenCalledWith(
            tab,
            "saveCipherAttemptCompleted",
            expect.anything(),
          );
        });

        it("drops a ChangePassword update the fill cipher policy does not offer", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          notificationBackground["notificationQueue"] = [
            mock<AddChangePasswordNotificationQueueMessage>({
              type: NotificationType.ChangePassword,
              tab,
              domain: "example.com",
              data: { newPassword: "revealed", cipherIds: [], cipherRefs: [] },
              wasVaultLocked: true,
              userId,
            }),
          ];
          fillCipherPolicy.canOfferSave.mockResolvedValueOnce(false);

          sendMockExtensionMessage(
            { command: "bgSaveCipher", edit: false, cipherId: "testId" },
            sender,
          );
          await flushPromises();

          expect(fillCipherPolicy.canOfferSave).toHaveBeenCalledWith(
            { uri: "https://example.com", newPassword: "revealed" },
            userId,
          );
          expect(notificationBackground["notificationQueue"]).toHaveLength(0);
          expect(getDecryptedCipherByIdSpy).not.toHaveBeenCalled();
          expect(updatePasswordSpy).not.toHaveBeenCalled();
          expect(updateWithServerSpy).not.toHaveBeenCalled();
          expect(createWithServerSpy).not.toHaveBeenCalled();
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(tab, "closeNotificationBar", {
            closedByUser: false,
          });
        });

        it("saves an AddLogin the fill cipher policy offers", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const data = { username: "test", password: "password", uri: "https://example.com" };
          notificationBackground["notificationQueue"] = [
            mock<AddLoginQueueMessage>({
              type: NotificationType.AddLogin,
              tab,
              domain: "example.com",
              data,
              wasVaultLocked: false,
              userId,
            }),
          ];
          createWithServerSpy.mockResolvedValueOnce(mock<CipherView>({ id: "testId" }));

          sendMockExtensionMessage({ command: "bgSaveCipher", edit: false }, sender);
          await flushPromises();

          expect(fillCipherPolicy.canOfferSave).toHaveBeenCalledWith(data, userId);
          expect(createWithServerSpy).toHaveBeenCalled();
          expect(tabSendMessageDataSpy).not.toHaveBeenCalledWith(tab, "closeNotificationBar", {
            closedByUser: false,
          });
        });

        it("updates the cipher password if the queue message was locked and an existing cipher has the same username as the message", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          const queueMessage = mock<AddLoginQueueMessage>({
            type: NotificationType.AddLogin,
            tab,
            domain: "example.com",
            data: {
              username: "test",
              password: "updated-password",
              uri: "https://example.com",
            },
            wasVaultLocked: true,
            userId,
          });
          notificationBackground["notificationQueue"] = [queueMessage];
          const cipherView = mock<CipherView>({
            login: { username: "test", password: "old-password" },
          });
          getAllDecryptedForUrlSpy.mockResolvedValueOnce([cipherView]);

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledWith(
            queueMessage.data.uri,
            userId,
            CipherUse.SavePrompt,
            undefined,
          );
          expect(updatePasswordSpy).toHaveBeenCalledWith(
            cipherView,
            queueMessage.data.password,
            message.edit,
            sender.tab,
            "testId",
          );
          expect(editItemSpy).not.toHaveBeenCalled();
          expect(createWithServerSpy).not.toHaveBeenCalled();
        });

        it("opens an editItem window and closes the notification bar if the edit value is within the passed message when attempting to update an existing cipher", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: true,
            folder: "folder-id",
          };
          const queueMessage = mock<AddChangePasswordNotificationQueueMessage>({
            userId,
            type: NotificationType.ChangePassword,
            tab,
            domain: "example.com",
            data: { newPassword: "newPassword", cipherIds: [], cipherRefs: [] },
          });
          notificationBackground["notificationQueue"] = [queueMessage];
          const cipherView = mock<CipherView>();
          getDecryptedCipherByIdSpy.mockResolvedValueOnce(cipherView);
          setAddEditCipherInfoSpy.mockResolvedValue(undefined);
          openAddEditVaultItemPopoutSpy.mockResolvedValue(undefined);

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(updatePasswordSpy).toHaveBeenCalledWith(
            cipherView,
            queueMessage.data.newPassword,
            message.edit,
            sender.tab,
            "testId",
            false,
          );
          expect(editItemSpy).toHaveBeenCalled();
          expect(updateWithServerSpy).not.toHaveBeenCalled();
          expect(tabSendMessageSpy).toHaveBeenCalledWith(sender.tab, {
            command: "closeNotificationBar",
          });
          expect(tabSendMessageSpy).toHaveBeenCalledWith(sender.tab, {
            command: "editedCipher",
          });
          expect(setAddEditCipherInfoSpy).toHaveBeenCalledWith(
            {
              cipher: cipherView,
              collectionIds: cipherView.collectionIds,
            },
            "testId",
          );
          expect(openAddEditVaultItemPopoutSpy).toHaveBeenCalledWith(sender.tab, {
            cipherId: cipherView.id,
            userId: "testId",
          });
        });

        it("opens an editItem window and closes the notification bar if the edit value is within the passed message when attempting to save the cipher", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: true,
            folder: "folder-id",
          };
          const queueMessage = mock<AddLoginQueueMessage>({
            type: NotificationType.AddLogin,
            tab,
            domain: "example.com",
            data: {
              username: "test",
              password: "password",
              uri: "https://example.com",
            },
            wasVaultLocked: false,
            userId,
            launchTimestamp: Date.now(),
            expires: new Date(Date.now() + 10000),
          });
          notificationBackground["notificationQueue"] = [queueMessage];
          const cipherView = mock<CipherView>({
            login: { username: "test", password: "password" },
          });
          folderExistsSpy.mockResolvedValueOnce(true);
          convertAddLoginQueueMessageToCipherViewSpy.mockReturnValueOnce(cipherView);
          editItemSpy.mockResolvedValueOnce(undefined);

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(updatePasswordSpy).not.toHaveBeenCalled();
          expect(convertAddLoginQueueMessageToCipherViewSpy).toHaveBeenCalledWith(
            queueMessage,
            message.folder,
          );
          expect(editItemSpy).toHaveBeenCalledWith(cipherView, "testId", sender.tab);
          expect(tabSendMessageSpy).toHaveBeenCalledWith(sender.tab, {
            command: "closeNotificationBar",
          });
          expect(createWithServerSpy).not.toHaveBeenCalled();
        });

        it("creates the cipher within the server and sends an `saveCipherAttemptCompleted` and `addedCipher` message to the sender tab", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          const queueMessage = mock<AddLoginQueueMessage>({
            type: NotificationType.AddLogin,
            tab,
            domain: "example.com",
            data: {
              username: "test",
              password: "password",
              uri: "https://example.com",
            },
            wasVaultLocked: false,
            userId,
            launchTimestamp: Date.now(),
            expires: new Date(Date.now() + 10000),
          });
          notificationBackground["notificationQueue"] = [queueMessage];
          const cipherView = mock<CipherView>({
            id: "testId",
            name: "testName",
            login: { username: "test", password: "password" },
          });
          folderExistsSpy.mockResolvedValueOnce(false);
          convertAddLoginQueueMessageToCipherViewSpy.mockReturnValueOnce(cipherView);
          editItemSpy.mockResolvedValueOnce(undefined);
          createWithServerSpy.mockResolvedValueOnce(cipherView);

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(convertAddLoginQueueMessageToCipherViewSpy).toHaveBeenCalledWith(
            queueMessage,
            undefined,
          );
          expect(createWithServerSpy).toHaveBeenCalled();
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(
            sender.tab,
            "saveCipherAttemptCompleted",
            {
              cipherId: cipherView.id,
              itemName: cipherView.name,
            },
          );
          expect(tabSendMessageSpy).toHaveBeenCalledWith(sender.tab, { command: "addedCipher" });
        });

        it("sends an error message within the `saveCipherAttemptCompleted` message if the cipher cannot be saved to the server", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          const queueMessage = mock<AddLoginQueueMessage>({
            type: NotificationType.AddLogin,
            tab,
            domain: "example.com",
            data: {
              username: "test",
              password: "password",
              uri: "https://example.com",
            },
            wasVaultLocked: false,
            userId,
            launchTimestamp: Date.now(),
            expires: new Date(Date.now() + 10000),
          });
          notificationBackground["notificationQueue"] = [queueMessage];
          const cipherView = mock<CipherView>({
            login: { username: "test", password: "password" },
          });
          folderExistsSpy.mockResolvedValueOnce(true);
          convertAddLoginQueueMessageToCipherViewSpy.mockReturnValueOnce(cipherView);
          editItemSpy.mockResolvedValueOnce(undefined);
          const errorMessage = "fetch error";
          createWithServerSpy.mockImplementation(() => {
            throw new Error(errorMessage);
          });

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(createWithServerSpy).toThrow(errorMessage);
          expect(tabSendMessageSpy).not.toHaveBeenCalledWith(sender.tab, {
            command: "addedCipher",
          });
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(
            sender.tab,
            "saveCipherAttemptCompleted",
            {
              error: errorMessage,
            },
          );
        });

        it("sends an error message within the `saveCipherAttemptCompleted` message if the cipher cannot be updated within the server", async () => {
          const tab = createChromeTabMock({ id: 1, url: "https://example.com" });
          const sender = mock<chrome.runtime.MessageSender>({ tab });
          const message: NotificationBackgroundExtensionMessage = {
            command: "bgSaveCipher",
            edit: false,
            folder: "folder-id",
          };
          const queueMessage = mock<AddChangePasswordNotificationQueueMessage>({
            userId,
            type: NotificationType.ChangePassword,
            tab,
            domain: "example.com",
            data: { newPassword: "newPassword", cipherIds: [], cipherRefs: [] },
          });
          notificationBackground["notificationQueue"] = [queueMessage];
          const cipherView = mock<CipherView>({ reprompt: CipherRepromptType.None });
          getDecryptedCipherByIdSpy.mockResolvedValueOnce(cipherView);
          const errorMessage = "fetch error";
          updateWithServerSpy.mockImplementation(() => {
            throw new Error(errorMessage);
          });

          sendMockExtensionMessage(message, sender);
          await flushPromises();

          expect(updateWithServerSpy).toThrow(errorMessage);
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(
            sender.tab,
            "saveCipherAttemptCompleted",
            {
              error: errorMessage,
            },
          );
        });
      });
    });

    describe("bgOpenAddEditVaultItemPopout message handler", () => {
      const data = { username: "test", password: "revealed", uri: "https://example.com" };
      let tab: chrome.tabs.Tab;
      let sender: chrome.runtime.MessageSender;
      let setAddEditCipherInfoSpy: jest.SpyInstance;
      let openAddEditVaultItemPopoutSpy: jest.SpyInstance;

      beforeEach(() => {
        tab = createChromeTabMock({ id: 1, url: "https://example.com" });
        sender = mock<chrome.runtime.MessageSender>({ tab });
        notificationBackground["notificationQueue"] = [
          mock<AddLoginQueueMessage>({
            userId,
            type: NotificationType.AddLogin,
            tab,
            domain: "example.com",
            data,
          }),
        ];
        accountService.activeAccount$ = activeAccountSubject;
        setAddEditCipherInfoSpy = jest
          .spyOn(cipherService, "setAddEditCipherInfo")
          .mockResolvedValue(undefined);
        openAddEditVaultItemPopoutSpy = jest
          .spyOn(notificationBackground as any, "openAddEditVaultItemPopout")
          .mockResolvedValue(undefined);
      });

      it("leaves the password out of the draft when the fill cipher policy does not offer the form", async () => {
        fillCipherPolicy.canOfferSave.mockResolvedValueOnce(false);

        sendMockExtensionMessage({ command: "bgOpenAddEditVaultItemPopout" }, sender);
        await flushPromises();

        expect(fillCipherPolicy.canOfferSave).toHaveBeenCalledWith(data, userId);
        const { cipher } = setAddEditCipherInfoSpy.mock.calls[0][0];
        expect(cipher.login.username).toBe("test");
        expect(cipher.login.password).toBe("");
        expect(openAddEditVaultItemPopoutSpy).toHaveBeenCalledWith(tab, { userId });
      });

      it("keeps the password in the draft when the fill cipher policy offers the form", async () => {
        sendMockExtensionMessage({ command: "bgOpenAddEditVaultItemPopout" }, sender);
        await flushPromises();

        const { cipher } = setAddEditCipherInfoSpy.mock.calls[0][0];
        expect(cipher.login.password).toBe("revealed");
        expect(openAddEditVaultItemPopoutSpy).toHaveBeenCalledWith(tab, { userId });
      });
    });

    describe("bgNeverSave message handler", () => {
      let tabSendMessageDataSpy: jest.SpyInstance;

      beforeEach(() => {
        tabSendMessageDataSpy = jest.spyOn(BrowserApi, "tabSendMessageData");
      });

      it("skips saving the domain as a never value if the passed tab does not exist within the notification queue", async () => {
        const tab = createChromeTabMock({ id: 2 });
        const sender = mock<chrome.runtime.MessageSender>({ tab });
        const message: NotificationBackgroundExtensionMessage = { command: "bgNeverSave" };
        notificationBackground["notificationQueue"] = [
          mock<AddLoginQueueMessage>({
            userId,
            tab: createChromeTabMock({ id: 1 }),
          }),
          mock<AddLoginQueueMessage>({
            userId,
            tab: createChromeTabMock({ id: 3 }),
          }),
        ];

        sendMockExtensionMessage(message, sender);
        await flushPromises();

        expect(tabSendMessageDataSpy).not.toHaveBeenCalled();
      });

      it("skips saving the domain as a never value if the tab does not contain an addLogin message within the NotificationQueue", async () => {
        const tab = createChromeTabMock({ id: 2 });
        const sender = mock<chrome.runtime.MessageSender>({ tab });
        const message: NotificationBackgroundExtensionMessage = { command: "bgNeverSave" };
        notificationBackground["notificationQueue"] = [
          mock<AddUnlockVaultQueueMessage>({ type: NotificationType.UnlockVault, tab }),
        ];

        sendMockExtensionMessage(message, sender);
        await flushPromises();

        expect(tabSendMessageDataSpy).not.toHaveBeenCalled();
      });

      it("skips saving the domain as a never value if the tab url does not match the queue message domain", async () => {
        const tab = createChromeTabMock({ id: 2, url: "https://example.com" });
        const message: NotificationBackgroundExtensionMessage = { command: "bgNeverSave" };
        const secondaryTab = createChromeTabMock({ id: 3, url: "https://another.com" });
        const sender = mock<chrome.runtime.MessageSender>({ tab: secondaryTab });
        notificationBackground["notificationQueue"] = [
          mock<AddLoginQueueMessage>({
            userId,
            type: NotificationType.AddLogin,
            tab,
            domain: "another.com",
          }),
        ];

        sendMockExtensionMessage(message, sender);
        await flushPromises();

        expect(tabSendMessageDataSpy).not.toHaveBeenCalled();
      });

      it("saves the submitting frame's hostname as a never value and closes the notification bar", async () => {
        const tab = createChromeTabMock({ id: 2, url: "https://www.example.com" });
        const sender = mock<chrome.runtime.MessageSender>({ tab });
        const message: NotificationBackgroundExtensionMessage = { command: "bgNeverSave" };
        const firstNotification = mock<AddLoginQueueMessage>({
          userId,
          type: NotificationType.AddLogin,
          tab,
          domain: "example.com",
          // Submitted from a same-site sub-frame whose hostname differs from the tab's.
          data: { uri: "https://login.example.com/sign-in" },
        });
        const secondNotification = mock<AddLoginQueueMessage>({
          userId,
          type: NotificationType.AddLogin,
          tab: createChromeTabMock({ id: 3 }),
          domain: "another.com",
        });
        notificationBackground["notificationQueue"] = [firstNotification, secondNotification];
        jest.spyOn(cipherService, "saveNeverDomain").mockImplementation();
        jest.spyOn(BrowserApi, "tabSendMessageData").mockImplementation();

        sendMockExtensionMessage(message, sender);
        await flushPromises();

        expect(tabSendMessageDataSpy).toHaveBeenCalledWith(tab, "closeNotificationBar");
        expect(cipherService.saveNeverDomain).toHaveBeenCalledWith("login.example.com");
        expect(cipherService.saveNeverDomain).not.toHaveBeenCalledWith("www.example.com");
        expect(notificationBackground["notificationQueue"]).toEqual([secondNotification]);
      });
    });

    describe("collectPageDetailsResponse", () => {
      let tabSendMessageDataSpy: jest.SpyInstance;

      beforeEach(() => {
        tabSendMessageDataSpy = jest.spyOn(BrowserApi, "tabSendMessageData");
      });

      it("skips sending the `notificationBarPageDetails` message if the message sender is not `notificationBar`", async () => {
        const message: NotificationBackgroundExtensionMessage = {
          command: "collectPageDetailsResponse",
          sender: "not-notificationBar",
        };

        sendMockExtensionMessage(message);
        await flushPromises();

        expect(tabSendMessageDataSpy).not.toHaveBeenCalled();
      });

      it("sends a `notificationBarPageDetails` message with the forms with password fields", async () => {
        const tab = createChromeTabMock();
        const message: NotificationBackgroundExtensionMessage = {
          command: "collectPageDetailsResponse",
          sender: "notificationBar",
          details: createAutofillPageDetailsMock(),
          tab,
        };
        const formData = [mock<FormData>()];
        jest.spyOn(autofillService, "getFormsWithPasswordFields").mockReturnValueOnce(formData);

        sendMockExtensionMessage(message);
        await flushPromises();

        expect(tabSendMessageDataSpy).toHaveBeenCalledWith(
          message.tab,
          "notificationBarPageDetails",
          {
            details: message.details,
            forms: formData,
          },
        );
      });
    });

    describe("checkNotificationQueue", () => {
      let doNotificationQueueCheckSpy: jest.SpyInstance;
      let getTabFromCurrentWindowSpy: jest.SpyInstance;

      beforeEach(() => {
        doNotificationQueueCheckSpy = jest.spyOn(
          notificationBackground as any,
          "doNotificationQueueCheck",
        );
        getTabFromCurrentWindowSpy = jest.spyOn(BrowserApi, "getTabFromCurrentWindow");
      });

      it("skips checking the notification queue if the queue does not contain any items", async () => {
        const message: NotificationBackgroundExtensionMessage = {
          command: "checkNotificationQueue",
        };
        notificationBackground["notificationQueue"] = [];

        sendMockExtensionMessage(message);
        await flushPromises();

        expect(doNotificationQueueCheckSpy).not.toHaveBeenCalled();
      });

      it("checks the notification queue for the sender tab", async () => {
        const tab = createChromeTabMock();
        const sender = mock<chrome.runtime.MessageSender>({ tab });
        const message: NotificationBackgroundExtensionMessage = {
          command: "checkNotificationQueue",
        };
        notificationBackground["notificationQueue"] = [
          mock<AddLoginQueueMessage>({ tab }),
          mock<AddLoginQueueMessage>({ tab: createChromeTabMock({ id: 2 }) }),
        ];

        sendMockExtensionMessage(message, sender);
        await flushPromises();

        expect(doNotificationQueueCheckSpy).toHaveBeenCalledWith(tab);
      });

      it("checks the notification queue for the current tab if the sender does not send a tab", async () => {
        const message: NotificationBackgroundExtensionMessage = {
          command: "checkNotificationQueue",
        };
        const currentTab = createChromeTabMock({ id: 2 });
        notificationBackground["notificationQueue"] = [
          mock<AddLoginQueueMessage>({ tab: currentTab }),
        ];
        getTabFromCurrentWindowSpy.mockResolvedValueOnce(currentTab);

        sendMockExtensionMessage(message, mock<chrome.runtime.MessageSender>({ tab: null }));
        await flushPromises();

        expect(getTabFromCurrentWindowSpy).toHaveBeenCalledWith();
        expect(doNotificationQueueCheckSpy).toHaveBeenCalledWith(currentTab);
      });
    });

    describe("bgReopenUnlockPopout message handler", () => {
      it("opens the unlock popout window", async () => {
        const message: NotificationBackgroundExtensionMessage = {
          command: "bgReopenUnlockPopout",
        };
        const openUnlockWindowSpy = jest.spyOn(notificationBackground as any, "openUnlockPopout");

        sendMockExtensionMessage(message);
        await flushPromises();

        expect(openUnlockWindowSpy).toHaveBeenCalled();
      });
    });

    describe("getWebVaultUrlForNotification", () => {
      it("returns the web vault url", async () => {
        const message: NotificationBackgroundExtensionMessage = {
          command: "getWebVaultUrlForNotification",
        };
        const env = new SelfHostedEnvironment({ webVault: "https://example.com" });

        Object.defineProperty(environmentService, "environment$", {
          configurable: true,
          get: () => null,
        });

        const environmentServiceSpy = jest
          .spyOn(environmentService as any, "environment$", "get")
          .mockReturnValue(new BehaviorSubject(env).asObservable());

        sendMockExtensionMessage(message);
        await flushPromises();

        expect(environmentServiceSpy).toHaveBeenCalled();
      });
    });

    describe("handleUnlockPopoutClosed", () => {
      let onRemovedListeners: Array<(tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => void>;
      let tabsQuerySpy: jest.SpyInstance;

      beforeEach(() => {
        onRemovedListeners = [];
        chrome.tabs.onRemoved.addListener = jest.fn((listener) => {
          onRemovedListeners.push(listener);
        });
        chrome.runtime.getURL = jest.fn().mockReturnValue("chrome-extension://id/popup/index.html");
        notificationBackground.init();
      });

      const triggerTabRemoved = async (tabId: number) => {
        onRemovedListeners[0](tabId, mock<chrome.tabs.OnRemovedInfo>());
        await flushPromises();
      };

      it("sends abandon message when unlock popout is closed and vault is locked", async () => {
        activeAccountStatusMock$.next(AuthenticationStatus.Locked);
        tabsQuerySpy = jest.spyOn(BrowserApi, "tabsQuery").mockResolvedValue([]);

        await triggerTabRemoved(1);

        expect(tabsQuerySpy).toHaveBeenCalled();
        expect(messagingService.send).toHaveBeenCalledWith("abandonAutofillPendingNotifications");
      });

      it("uses tracked tabId for fast lookup when available", async () => {
        activeAccountStatusMock$.next(AuthenticationStatus.Locked);
        tabsQuerySpy = jest.spyOn(BrowserApi, "tabsQuery").mockResolvedValue([
          {
            id: 123,
            url: "chrome-extension://id/popup/index.html?singleActionPopout=auth_unlockExtension",
          } as chrome.tabs.Tab,
        ]);

        await triggerTabRemoved(999);
        tabsQuerySpy.mockClear();
        messagingService.send.mockClear();

        await triggerTabRemoved(123);

        expect(tabsQuerySpy).not.toHaveBeenCalled();
        expect(messagingService.send).toHaveBeenCalledWith("abandonAutofillPendingNotifications");
      });

      it("returns early when vault is unlocked", async () => {
        activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
        tabsQuerySpy = jest.spyOn(BrowserApi, "tabsQuery").mockResolvedValue([]);

        await triggerTabRemoved(1);

        expect(tabsQuerySpy).not.toHaveBeenCalled();
        expect(messagingService.send).not.toHaveBeenCalled();
      });
    });
  });

  describe("several accounts serving autofill", () => {
    const otherUserId = "otherUserId" as UserId;
    const url = "https://example.com/login";
    let tab: chrome.tabs.Tab;
    let sender: chrome.runtime.MessageSender;
    let vaults: Record<string, CipherView[]>;
    let tabSendMessageDataSpy: jest.SpyInstance;
    let openUnlockPopoutSpy: jest.SpyInstance;
    let openAddEditVaultItemPopoutSpy: jest.SpyInstance;

    const login = (id: string, username: string, password: string) =>
      ({
        id,
        name: id,
        type: CipherType.Login,
        edit: true,
        reprompt: CipherRepromptType.None,
        deletedDate: null,
        login: { username, password },
      }) as unknown as CipherView;

    const formData = (
      username: string,
      password: string,
      newPassword = "",
    ): ModifyLoginCipherFormData => ({ uri: url, username, password, newPassword });

    const queue = () => notificationBackground["notificationQueue"];

    const saveCipher = async (message: Partial<NotificationBackgroundExtensionMessage> = {}) => {
      sendMockExtensionMessage({ command: "bgSaveCipher", edit: false, ...message }, sender);
      await flushPromises();
    };

    beforeEach(() => {
      notificationBackground.init();
      activeAccountStatusMock$.next(AuthenticationStatus.Unlocked);
      otherAutofillUserIds$.next([otherUserId]);
      vaults = { [userId]: [], [otherUserId]: [] };
      cipherService.getAllDecryptedForUrl.mockImplementation(async (_url, id) => vaults[id]);
      cipherService.getAllDecryptedForIds.mockImplementation(async (id, ids) =>
        vaults[id].filter((cipher) => ids.includes(cipher.id)),
      );
      accountService.accounts$ = of({
        [userId]: mockAccountInfoWith({ email: "test@example.com" }),
        [otherUserId]: mockAccountInfoWith({ email: "other@example.com" }),
      });
      organizationService.organizations$.mockReturnValue(of([]));
      environmentService.getEnvironment$.mockReturnValue(
        of(new SelfHostedEnvironment({ base: "https://vault.example.org" })),
      );
      domainSettingsService.showFavicons$ = of(false);
      taskService.tasksEnabled$.mockReturnValue(of(false));
      tab = createChromeTabMock({ id: 1, url });
      sender = mock<chrome.runtime.MessageSender>({ tab });
      tabSendMessageDataSpy = jest.spyOn(BrowserApi, "tabSendMessageData").mockImplementation();
      jest.spyOn(BrowserApi, "tabSendMessage").mockImplementation();
      jest.spyOn(BrowserApi, "getTabFromCurrentWindow").mockResolvedValue(tab);
      openUnlockPopoutSpy = jest
        .spyOn(notificationBackground as any, "openUnlockPopout")
        .mockImplementation();
      openAddEditVaultItemPopoutSpy = jest
        .spyOn(notificationBackground as any, "openAddEditVaultItemPopout")
        .mockImplementation();
    });

    afterEach(() => {
      cipherService.getAllDecryptedForUrl.mockReset();
      cipherService.getAllDecryptedForIds.mockReset();
      fillCipherPolicy.canOfferSave.mockReset();
      policyService.policyAppliesToUser$.mockReturnValue(policyAppliesToUser$);
    });

    describe("a submitted login", () => {
      it("gets no prompt when a non-active account holds it with the same password", async () => {
        vaults[otherUserId] = [login("other-cipher", "frodo", "ring")];

        const triggered = await notificationBackground.triggerCipherNotification(
          formData("frodo", "ring"),
          tab,
        );

        expect(triggered).toBe(false);
        expect(queue()).toHaveLength(0);
      });

      it("gets no prompt when it is in both accounts and only one holds the same password", async () => {
        vaults[userId] = [login("active-cipher", "frodo", "old")];
        vaults[otherUserId] = [login("other-cipher", "frodo", "ring")];

        const triggered = await notificationBackground.triggerCipherNotification(
          formData("frodo", "ring"),
          tab,
        );

        expect(triggered).toBe(false);
        expect(queue()).toHaveLength(0);
      });

      it("gets a save prompt for the active account when no account holds it", async () => {
        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        expect(queue()).toEqual([
          expect.objectContaining({ type: NotificationType.AddLogin, userId }),
        ]);
      });
    });

    describe("a changed password", () => {
      it("is queued for and saved to the non-active account that owns the cipher", async () => {
        vaults[otherUserId] = [login("other-cipher", "frodo", "old")];

        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        expect(queue()).toEqual([
          expect.objectContaining({
            type: NotificationType.ChangePassword,
            userId: otherUserId,
            data: {
              cipherIds: ["other-cipher"],
              cipherRefs: [{ userId: otherUserId, cipherId: "other-cipher" }],
              newPassword: "ring",
            },
          }),
        ]);

        await saveCipher({ cipherId: "other-cipher" });

        expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
        expect(cipherService.updateWithServer).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "other-cipher",
            login: { username: "frodo", password: "ring" },
          }),
          otherUserId,
        );
        expect(cipherService.createWithServer).not.toHaveBeenCalled();
      });

      it("offers the ciphers of both accounts, labelled, when the username is in both", async () => {
        vaults[userId] = [login("active-cipher", "frodo", "old")];
        vaults[otherUserId] = [login("other-cipher", "frodo", "older")];

        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        expect(queue()[0].data).toEqual(
          expect.objectContaining({
            cipherRefs: [
              { userId, cipherId: "active-cipher" },
              { userId: otherUserId, cipherId: "other-cipher" },
            ],
          }),
        );
        await expect(notificationBackground.getNotificationCipherData()).resolves.toEqual([
          expect.objectContaining({
            id: "active-cipher",
            userId,
            accountLabel: "test@example.com",
          }),
          expect.objectContaining({
            id: "other-cipher",
            userId: otherUserId,
            accountLabel: "other@example.com",
          }),
        ]);

        await saveCipher({ cipherId: "other-cipher", userId: otherUserId });

        expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
        expect(cipherService.updateWithServer).toHaveBeenCalledWith(
          expect.objectContaining({ id: "other-cipher" }),
          otherUserId,
        );
      });

      it("refuses a cipher named with an account that does not hold it", async () => {
        vaults[userId] = [login("active-cipher", "frodo", "old")];
        vaults[otherUserId] = [login("other-cipher", "frodo", "older")];
        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        await saveCipher({ cipherId: "other-cipher", userId });

        expect(cipherService.updateWithServer).not.toHaveBeenCalled();
      });

      it("updates a shared item both accounts hold only in the account named with it", async () => {
        vaults[userId] = [login("shared-cipher", "frodo", "old")];
        vaults[otherUserId] = [login("shared-cipher", "frodo", "old")];
        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        // The id alone names two ciphers. Neither is updated on a guess.
        await saveCipher({ cipherId: "shared-cipher" });
        expect(cipherService.updateWithServer).not.toHaveBeenCalled();

        await saveCipher({ cipherId: "shared-cipher", userId: otherUserId });
        expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
        expect(cipherService.updateWithServer).toHaveBeenCalledWith(
          vaults[otherUserId][0],
          otherUserId,
        );
        expect(vaults[userId][0].login.password).toBe("old");
      });

      it("offers only ciphers of accounts whose policy takes the update", async () => {
        vaults[userId] = [login("active-cipher", "frodo", "old")];
        vaults[otherUserId] = [login("other-cipher", "frodo", "older")];
        fillCipherPolicy.canOfferSave.mockImplementation(async (_form, id) => id === userId);

        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        expect(queue()[0].data).toEqual(
          expect.objectContaining({ cipherRefs: [{ userId, cipherId: "active-cipher" }] }),
        );
      });

      it("saves nothing when the owning account locks before the user updates", async () => {
        vaults[otherUserId] = [login("other-cipher", "frodo", "old")];
        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        otherAutofillUserIds$.next([]);
        await saveCipher({ cipherId: "other-cipher" });

        expect(cipherService.updateWithServer).not.toHaveBeenCalled();
        expect(cipherService.createWithServer).not.toHaveBeenCalled();
        expect(openUnlockPopoutSpy).not.toHaveBeenCalled();
        expect(queue()).toHaveLength(0);
        expect(tabSendMessageDataSpy).toHaveBeenCalledWith(tab, "closeNotificationBar", {
          closedByUser: false,
        });
      });

      it("updates the non-active account's cipher without unlocking the locked active account", async () => {
        activeAccountStatusMock$.next(AuthenticationStatus.Locked);
        vaults[otherUserId] = [login("other-cipher", "frodo", "old")];

        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);
        expect(queue()).toEqual([
          expect.objectContaining({
            type: NotificationType.ChangePassword,
            userId: otherUserId,
            wasVaultLocked: false,
          }),
        ]);

        await saveCipher({ cipherId: "other-cipher" });

        expect(openUnlockPopoutSpy).not.toHaveBeenCalled();
        expect(cipherService.updateWithServer).toHaveBeenCalledWith(
          expect.objectContaining({ id: "other-cipher" }),
          otherUserId,
        );
      });

      describe("a master password reprompt before the update", () => {
        const protectedLogin = (id: string) =>
          ({
            ...login(id, "frodo", "old"),
            reprompt: CipherRepromptType.Password,
          }) as CipherView;
        const answer = (message: Partial<NotificationBackgroundExtensionMessage>) =>
          notificationBackground.handleCipherUpdateRepromptResponse({
            command: "bgHandleReprompt",
            tab,
            success: true,
            ...message,
          });

        it("asks for the owning account's master password without switching to it", async () => {
          vaults[otherUserId] = [protectedLogin("other-cipher")];
          await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

          await saveCipher({ cipherId: "other-cipher" });

          expect(autofillService.isPasswordRepromptRequired).toHaveBeenCalledWith(
            expect.objectContaining({ id: "other-cipher" }),
            tab,
            otherUserId,
            "update-password",
          );
          expect(cipherService.updateWithServer).not.toHaveBeenCalled();

          // The popout names the account whose master password answered.
          await answer({ cipherId: "other-cipher", userId: otherUserId });

          expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
          expect(cipherService.updateWithServer).toHaveBeenCalledWith(
            expect.objectContaining({ id: "other-cipher" }),
            otherUserId,
          );
          expect(switchAccount).not.toHaveBeenCalled();
        });

        it("updates a shared item only in the account whose master password answered", async () => {
          vaults[userId] = [protectedLogin("shared-cipher")];
          vaults[otherUserId] = [protectedLogin("shared-cipher")];
          await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);
          await saveCipher({ cipherId: "shared-cipher", userId: otherUserId });

          // An answer that names no account names two ciphers. Neither is updated on a guess.
          await answer({ cipherId: "shared-cipher" });
          expect(cipherService.updateWithServer).not.toHaveBeenCalled();

          await answer({ cipherId: "shared-cipher", userId: otherUserId });
          expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
          expect(cipherService.updateWithServer).toHaveBeenCalledWith(
            vaults[otherUserId][0],
            otherUserId,
          );
          expect(vaults[userId][0].login.password).toBe("old");
        });

        it("does not update the cipher of an account other than the one that answered", async () => {
          vaults[otherUserId] = [protectedLogin("other-cipher")];
          await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);
          await saveCipher({ cipherId: "other-cipher" });

          // The active account's master password does not release another account's cipher.
          await answer({ cipherId: "other-cipher", userId });

          expect(cipherService.updateWithServer).not.toHaveBeenCalled();
        });

        it("saves nothing when the owning account locks before the popout answers", async () => {
          vaults[otherUserId] = [protectedLogin("other-cipher")];
          await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);
          await saveCipher({ cipherId: "other-cipher" });

          otherAutofillUserIds$.next([]);
          await answer({ cipherId: "other-cipher", userId: otherUserId });

          expect(cipherService.updateWithServer).not.toHaveBeenCalled();
          expect(cipherService.createWithServer).not.toHaveBeenCalled();
          expect(queue()).toHaveLength(0);
          expect(switchAccount).not.toHaveBeenCalled();
        });

        it("saves nothing when the reprompt fails", async () => {
          vaults[otherUserId] = [protectedLogin("other-cipher")];
          await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);
          await saveCipher({ cipherId: "other-cipher" });

          await answer({ cipherId: "other-cipher", userId: otherUserId, success: false });

          expect(cipherService.updateWithServer).not.toHaveBeenCalled();
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(tab, "saveCipherAttemptCompleted", {
            error: "Password reprompt failed",
          });
        });
      });
    });

    describe("the active account locked while another account serves", () => {
      beforeEach(() => {
        activeAccountStatusMock$.next(AuthenticationStatus.Locked);
      });

      it("offers a new login to the serving account instead of asking to unlock", async () => {
        const triggered = await notificationBackground.triggerCipherNotification(
          formData("frodo", "ring"),
          tab,
        );

        expect(triggered).toBe(true);
        expect(queue()).toEqual([
          expect.objectContaining({
            type: NotificationType.AddLogin,
            userId: otherUserId,
            wasVaultLocked: false,
          }),
        ]);
      });

      it("offers a changed login nobody holds to the serving account", async () => {
        vaults[otherUserId] = [login("other-cipher", "sam", "potatoes")];

        await notificationBackground.triggerCipherNotification(
          formData("frodo", "old", "ring"),
          tab,
        );

        expect(queue()).toEqual([
          expect.objectContaining({
            type: NotificationType.AddLogin,
            userId: otherUserId,
            wasVaultLocked: false,
          }),
        ]);
      });

      it("names the serving account on the save bar, since it is not the active one", async () => {
        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        const cipherData = await notificationBackground.getNotificationCipherData();

        expect(cipherData).toEqual([
          expect.objectContaining({ userId: otherUserId, accountLabel: "other@example.com" }),
        ]);
      });

      it("saves to the serving account without asking the active account to unlock", async () => {
        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        await saveCipher();

        expect(openUnlockPopoutSpy).not.toHaveBeenCalled();
        expect(cipherService.createWithServer).toHaveBeenCalledTimes(1);
        expect(cipherService.createWithServer).toHaveBeenCalledWith(
          expect.objectContaining({ login: expect.objectContaining({ username: "frodo" }) }),
          otherUserId,
        );
      });

      it("offers nothing when the serving account's policy does not take the login", async () => {
        fillCipherPolicy.canOfferSave.mockImplementation(async (_form, id) => id !== otherUserId);

        const triggered = await notificationBackground.triggerCipherNotification(
          formData("frodo", "ring"),
          tab,
        );

        expect(triggered).toBe(false);
        expect(queue()).toHaveLength(0);
      });

      it("updates the serving account's login, which needs no unlock", async () => {
        vaults[otherUserId] = [login("other-cipher", "frodo", "old")];

        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        expect(queue()).toEqual([
          expect.objectContaining({
            type: NotificationType.ChangePassword,
            userId: otherUserId,
            wasVaultLocked: false,
          }),
        ]);
      });

      it("asks to unlock the active account once no account serves", async () => {
        otherAutofillUserIds$.next([]);

        await notificationBackground.triggerCipherNotification(
          formData("frodo", "old", "ring"),
          tab,
        );

        expect(queue()).toEqual([
          expect.objectContaining({
            type: NotificationType.ChangePassword,
            userId,
            wasVaultLocked: true,
            data: { cipherIds: [], cipherRefs: [], newPassword: "ring" },
          }),
        ]);
      });
    });

    describe("no active account while another account serves", () => {
      beforeEach(() => {
        activeAccountStatusMock$.next(AuthenticationStatus.LoggedOut);
        accountService.activeAccount$ = new BehaviorSubject(null);
      });

      afterEach(() => {
        accountService.activeAccount$ = activeAccountSubject;
      });

      it("raises the save bar for the serving account", async () => {
        const triggered = await notificationBackground.triggerCipherNotification(
          formData("frodo", "ring"),
          tab,
        );

        expect(triggered).toBe(true);
        expect(queue()).toEqual([
          expect.objectContaining({ type: NotificationType.AddLogin, userId: otherUserId }),
        ]);
      });

      it("raises no bar once no account serves", async () => {
        otherAutofillUserIds$.next([]);

        const triggered = await notificationBackground.triggerCipherNotification(
          formData("frodo", "old", "ring"),
          tab,
        );

        expect(triggered).toBe(false);
        expect(queue()).toHaveLength(0);
      });
    });

    describe("a save prompt", () => {
      const activeFolder = { id: "active-folder", name: "Active" } as FolderView;
      const otherFolder = { id: "other-folder", name: "Other" } as FolderView;

      beforeEach(async () => {
        folderService.folderViews$.mockImplementation((id) =>
          of(id === otherUserId ? [otherFolder] : [activeFolder]),
        );
        policyService.policyAppliesToUser$.mockImplementation((_policy, id) =>
          of(id === otherUserId),
        );
        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);
      });

      it("offers the accounts that serve autofill, the active account selected", async () => {
        await expect(notificationBackground["getAccountData"](sender)).resolves.toEqual([
          { id: userId, email: "test@example.com", selected: true, removeIndividualVault: false },
          {
            id: otherUserId,
            email: "other@example.com",
            selected: false,
            removeIndividualVault: true,
          },
        ]);
      });

      it("offers no choice while a single account serves autofill", async () => {
        otherAutofillUserIds$.next([]);

        await expect(notificationBackground["getAccountData"](sender)).resolves.toEqual([]);
      });

      it("does not offer an account whose policy does not take the login", async () => {
        fillCipherPolicy.canOfferSave.mockImplementation(async (_form, id) => id === userId);

        await expect(notificationBackground["getAccountData"](sender)).resolves.toEqual([]);
        await expect(
          notificationBackground["selectAccount"](
            { command: "bgSelectAccount", userId: otherUserId },
            sender,
          ),
        ).resolves.toBe(false);
        expect(queue()[0].userId).toBe(userId);
      });

      it("defaults to the first account whose policy takes the login", async () => {
        fillCipherPolicy.canOfferSave.mockImplementation(async (_form, id) => id === otherUserId);

        await notificationBackground.triggerCipherNotification(formData("frodo", "ring"), tab);

        expect(queue()).toEqual([
          expect.objectContaining({ type: NotificationType.AddLogin, userId: otherUserId }),
        ]);
      });

      it("saves to the active account unless another is picked", async () => {
        await saveCipher({ folder: "active-folder" });

        expect(cipherService.createWithServer).toHaveBeenCalledTimes(1);
        expect(cipherService.createWithServer).toHaveBeenCalledWith(
          expect.objectContaining({ folderId: "active-folder" }),
          userId,
        );
      });

      it("reads the folders of, and saves to, the account the user picks", async () => {
        await expect(
          notificationBackground["selectAccount"](
            { command: "bgSelectAccount", userId: otherUserId },
            sender,
          ),
        ).resolves.toBe(true);

        await expect(
          notificationBackground["getFolderData"](
            await notificationBackground["dataAccountFor"](sender),
          ),
        ).resolves.toEqual([otherFolder]);
        await expect(notificationBackground["getAccountData"](sender)).resolves.toEqual([
          expect.objectContaining({ id: userId, selected: false }),
          expect.objectContaining({ id: otherUserId, selected: true }),
        ]);

        // A folder of the account that was left does not exist in the picked one.
        await saveCipher({ folder: "active-folder" });

        expect(cipherService.createWithServer).toHaveBeenCalledTimes(1);
        expect(cipherService.createWithServer).toHaveBeenCalledWith(
          expect.objectContaining({ folderId: undefined }),
          otherUserId,
        );
      });

      it("refuses an account that is not one of the offered", async () => {
        await expect(
          notificationBackground["selectAccount"](
            { command: "bgSelectAccount", userId: "strangerId" },
            sender,
          ),
        ).resolves.toBe(false);
        expect(queue()[0].userId).toBe(userId);
      });

      it("saves nothing when the picked account locks before the user saves", async () => {
        await notificationBackground["selectAccount"](
          { command: "bgSelectAccount", userId: otherUserId },
          sender,
        );

        otherAutofillUserIds$.next([]);
        await saveCipher();

        expect(cipherService.createWithServer).not.toHaveBeenCalled();
        expect(openUnlockPopoutSpy).not.toHaveBeenCalled();
        expect(queue()).toHaveLength(0);
        expect(tabSendMessageDataSpy).toHaveBeenCalledWith(tab, "closeNotificationBar", {
          closedByUser: false,
        });
      });

      it("is not shown again once its account stopped serving autofill", async () => {
        await notificationBackground["selectAccount"](
          { command: "bgSelectAccount", userId: otherUserId },
          sender,
        );
        otherAutofillUserIds$.next([]);
        tabSendMessageDataSpy.mockClear();

        await notificationBackground.checkNotificationQueue(tab);

        expect(queue()).toHaveLength(0);
        expect(tabSendMessageDataSpy).not.toHaveBeenCalledWith(
          tab,
          "openNotificationBar",
          expect.anything(),
        );
      });

      it("opens the edit popout for the picked account without switching to it", async () => {
        await notificationBackground["selectAccount"](
          { command: "bgSelectAccount", userId: otherUserId },
          sender,
        );

        await saveCipher({ edit: true });

        expect(cipherService.setAddEditCipherInfo).toHaveBeenCalledWith(
          expect.anything(),
          otherUserId,
        );
        expect(openAddEditVaultItemPopoutSpy).toHaveBeenCalledWith(
          tab,
          expect.objectContaining({ userId: otherUserId }),
        );
        expect(switchAccount).not.toHaveBeenCalled();
        expect(cipherService.createWithServer).not.toHaveBeenCalled();
      });

      it("opens the edit popout for the active account for a save to it", async () => {
        await saveCipher({ edit: true });

        expect(cipherService.setAddEditCipherInfo).toHaveBeenCalledWith(expect.anything(), userId);
        expect(openAddEditVaultItemPopoutSpy).toHaveBeenCalledWith(
          tab,
          expect.objectContaining({ userId }),
        );
        expect(switchAccount).not.toHaveBeenCalled();
      });

      it("opens the item form for the picked account when an organization is chosen", async () => {
        await notificationBackground["selectAccount"](
          { command: "bgSelectAccount", userId: otherUserId },
          sender,
        );

        sendMockExtensionMessage(
          { command: "bgOpenAddEditVaultItemPopout", organizationId: "org-id" },
          sender,
        );
        await flushPromises();

        expect(cipherService.setAddEditCipherInfo).toHaveBeenCalledWith(
          { cipher: expect.objectContaining({ organizationId: "org-id" }) },
          otherUserId,
        );
        expect(openAddEditVaultItemPopoutSpy).toHaveBeenCalledWith(tab, { userId: otherUserId });
        expect(switchAccount).not.toHaveBeenCalled();
      });

      it("opens no item form once the picked account stopped serving autofill", async () => {
        await notificationBackground["selectAccount"](
          { command: "bgSelectAccount", userId: otherUserId },
          sender,
        );
        otherAutofillUserIds$.next([]);

        sendMockExtensionMessage(
          { command: "bgOpenAddEditVaultItemPopout", organizationId: "org-id" },
          sender,
        );
        await flushPromises();

        expect(cipherService.setAddEditCipherInfo).not.toHaveBeenCalled();
        expect(openAddEditVaultItemPopoutSpy).not.toHaveBeenCalled();
        expect(queue()).toHaveLength(0);
      });
    });

    describe("a login saved from the inline menu", () => {
      const activeAccount = activeAccountSubject.value;
      let openViewVaultItemPopoutSpy: jest.SpyInstance;

      const showSaved = async (message: Partial<NotificationBackgroundExtensionMessage> = {}) => {
        sendMockExtensionMessage({
          command: "showLoginSavedNotification",
          senderTabId: tab.id,
          cipherId: "saved-cipher",
          itemName: "Saved",
          userId,
          ...message,
        });
        await flushPromises();
      };

      const view = async () => {
        sendMockExtensionMessage(
          { command: "bgOpenViewVaultItemPopout", cipherId: "saved-cipher" },
          sender,
        );
        await flushPromises();
      };

      beforeEach(() => {
        jest.spyOn(BrowserApi, "getTab").mockResolvedValue(tab);
        openViewVaultItemPopoutSpy = jest
          .spyOn(notificationBackground as any, "openViewVaultItemPopout")
          .mockImplementation();
      });

      afterEach(() => {
        activeAccountSubject.next(activeAccount);
      });

      it("confirms the save on the tab it was made from", async () => {
        await showSaved();

        expect(tabSendMessageDataSpy).toHaveBeenCalledWith(
          tab,
          "openNotificationBar",
          expect.objectContaining({
            isConfirmation: true,
            confirmationData: { cipherId: "saved-cipher", itemName: "Saved" },
          }),
        );
      });

      it("is not confirmed without the account it was saved to", async () => {
        await showSaved({ userId: undefined });

        expect(tabSendMessageDataSpy).not.toHaveBeenCalledWith(
          tab,
          "openNotificationBar",
          expect.anything(),
        );
      });

      it("views the cipher in the account it was saved to", async () => {
        await showSaved();

        await view();

        expect(switchAccount).not.toHaveBeenCalled();
        expect(openViewVaultItemPopoutSpy).toHaveBeenCalledWith(tab, {
          cipherId: "saved-cipher",
          action: "",
          userId,
        });
      });

      it("views a cipher saved to an account that is not active without switching to it", async () => {
        await showSaved({ userId: otherUserId });

        await view();

        expect(switchAccount).not.toHaveBeenCalled();
        expect(openViewVaultItemPopoutSpy).toHaveBeenCalledWith(tab, {
          cipherId: "saved-cipher",
          action: "",
          userId: otherUserId,
        });
      });

      it("views a cipher the tab's notification did not save as before, naming no account", async () => {
        await view();

        expect(openViewVaultItemPopoutSpy).toHaveBeenCalledWith(tab, {
          cipherId: "saved-cipher",
          action: "",
        });
      });

      it("views the cipher in the account it was saved to after the active account changed", async () => {
        await showSaved();
        activeAccountSubject.next({ ...activeAccount, id: otherUserId });
        otherAutofillUserIds$.next([userId]);

        await view();

        expect(switchAccount).not.toHaveBeenCalled();
        expect(openViewVaultItemPopoutSpy).toHaveBeenCalledWith(tab, {
          cipherId: "saved-cipher",
          action: "",
          userId,
        });
      });

      it("opens nothing once the account it was saved to no longer serves autofill", async () => {
        await showSaved();
        activeAccountSubject.next({ ...activeAccount, id: otherUserId });
        otherAutofillUserIds$.next([]);

        await view();

        expect(switchAccount).not.toHaveBeenCalled();
        expect(openViewVaultItemPopoutSpy).not.toHaveBeenCalled();
        expect(tabSendMessageDataSpy).toHaveBeenCalledWith(tab, "closeNotificationBar", {
          fadeOutNotification: false,
        });
      });
    });

    describe("an at-risk password", () => {
      const task = {
        id: "task-id",
        cipherId: "other-cipher",
        organizationId: "org-id",
        type: SecurityTaskType.UpdateAtRiskCredential,
        status: SecurityTaskStatus.Pending,
      } as SecurityTask;

      beforeEach(() => {
        vaults[otherUserId] = [login("other-cipher", "frodo", "ring")];
        taskService.tasksEnabled$.mockReturnValue(of(true));
        taskService.pendingTasks$.mockImplementation((id) => of(id === otherUserId ? [task] : []));
        organizationService.organizations$.mockImplementation((id) =>
          of(id === otherUserId ? [{ id: "org-id", name: "The Shire" } as Organization] : []),
        );
        changeLoginPasswordService.getChangePasswordUrl.mockResolvedValue(
          "https://example.com/.well-known/change-password",
        );
      });

      it("is notified for the non-active account that owns the task", async () => {
        const triggered = await notificationBackground.triggerAtRiskPasswordNotification(
          formData("frodo", "ring"),
          tab,
        );

        expect(triggered).toBe(true);
        expect(queue()).toEqual([
          expect.objectContaining({
            type: NotificationType.AtRiskPassword,
            userId: otherUserId,
            data: {
              hasPasswordChangeUri: true,
              organizationName: "The Shire",
              accountLabel: "other@example.com",
            },
          }),
        ]);
      });

      it("shows no account while the active account alone serves autofill", async () => {
        otherAutofillUserIds$.next([]);
        vaults[userId] = [login("other-cipher", "frodo", "ring")];
        taskService.pendingTasks$.mockImplementation((id) => of(id === userId ? [task] : []));
        organizationService.organizations$.mockReturnValue(
          of([{ id: "org-id", name: "The Shire" } as Organization]),
        );

        await notificationBackground.triggerAtRiskPasswordNotification(
          formData("frodo", "ring"),
          tab,
        );

        expect(queue()).toEqual([
          expect.objectContaining({
            type: NotificationType.AtRiskPassword,
            userId,
            data: { hasPasswordChangeUri: true, organizationName: "The Shire" },
          }),
        ]);
      });

      it("is not notified for a task of another account on the same shared item", async () => {
        vaults[userId] = [login("other-cipher", "frodo", "ring")];
        vaults[otherUserId] = [];

        const triggered = await notificationBackground.triggerAtRiskPasswordNotification(
          formData("frodo", "ring"),
          tab,
        );

        expect(triggered).toBe(false);
        expect(queue()).toHaveLength(0);
      });

      it("opens the change-password URL of the cipher in the account that owns the task", async () => {
        vaults[userId] = [login("active-cipher", "frodo", "ring")];
        const createNewTabSpy = jest
          .spyOn(BrowserApi, "createNewTab")
          .mockResolvedValue(null as any);
        await notificationBackground.triggerAtRiskPasswordNotification(
          formData("frodo", "ring"),
          tab,
        );
        changeLoginPasswordService.getChangePasswordUrl.mockClear();

        sendMockExtensionMessage({ command: "bgOpenChangePasswordUrl" }, sender);
        await flushPromises();

        expect(changeLoginPasswordService.getChangePasswordUrl).toHaveBeenCalledWith(
          vaults[otherUserId][0],
        );
        expect(createNewTabSpy).toHaveBeenCalledWith(
          "https://example.com/.well-known/change-password",
        );
      });

      describe("opening the remaining tasks after an update", () => {
        let openViewVaultItemPopoutSpy: jest.SpyInstance;
        let setPopup: jest.Mock;

        const openTasks = async () => {
          sendMockExtensionMessage({ command: "bgOpenAtRiskPasswords" }, sender);
          await flushPromises();
        };

        beforeEach(() => {
          openViewVaultItemPopoutSpy = jest
            .spyOn(notificationBackground as any, "openViewVaultItemPopout")
            .mockImplementation();
          setPopup = jest.fn();
          jest.spyOn(BrowserApi, "getBrowserAction").mockReturnValue({ setPopup } as any);
        });

        it("opens the at-risk passwords page for the non-active account without switching to it", async () => {
          notificationBackground["rememberSavedCipher"](tab, otherUserId, "updated-cipher");

          await openTasks();

          expect(setPopup).toHaveBeenNthCalledWith(1, {
            popup: `popup/index.html#/at-risk-passwords?userId=${otherUserId}`,
          });
          expect(messagingService.send).toHaveBeenCalledWith(VaultMessages.OpenAtRiskPasswords, {
            userId: otherUserId,
          });
          // The popup route is reset for the next time the popup opens.
          expect(setPopup).toHaveBeenLastCalledWith({ popup: "popup/index.html#/" });
          expect(openViewVaultItemPopoutSpy).not.toHaveBeenCalled();
          expect(switchAccount).not.toHaveBeenCalled();
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(tab, "closeNotificationBar", {
            fadeOutNotification: false,
          });
        });

        it("opens nothing once that account no longer serves autofill", async () => {
          notificationBackground["rememberSavedCipher"](tab, otherUserId, "updated-cipher");
          otherAutofillUserIds$.next([]);

          await openTasks();

          expect(setPopup).not.toHaveBeenCalled();
          expect(messagingService.send).not.toHaveBeenCalled();
          expect(switchAccount).not.toHaveBeenCalled();
          expect(tabSendMessageDataSpy).toHaveBeenCalledWith(tab, "closeNotificationBar", {
            fadeOutNotification: false,
          });
        });

        it("opens the at-risk passwords page for the active account by name", async () => {
          notificationBackground["rememberSavedCipher"](tab, userId, "updated-cipher");

          await openTasks();

          expect(setPopup).toHaveBeenNthCalledWith(1, {
            popup: `popup/index.html#/at-risk-passwords?userId=${userId}`,
          });
          expect(messagingService.send).toHaveBeenCalledWith(VaultMessages.OpenAtRiskPasswords, {
            userId,
          });
        });

        it("opens the at-risk passwords page naming no account when the tab saved no cipher", async () => {
          await openTasks();

          expect(setPopup).toHaveBeenNthCalledWith(1, {
            popup: "popup/index.html#/at-risk-passwords",
          });
          expect(messagingService.send).toHaveBeenCalledWith(VaultMessages.OpenAtRiskPasswords);
          expect(openViewVaultItemPopoutSpy).not.toHaveBeenCalled();
        });
      });
    });
  });
});
