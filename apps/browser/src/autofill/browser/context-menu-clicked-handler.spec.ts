import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom, of } from "rxjs";

import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import {
  AUTOFILL_ID,
  AUTOFILL_TRIAGE_ID,
  COPY_IDENTIFIER_ID,
  COPY_PASSWORD_ID,
  COPY_USERNAME_ID,
  COPY_VERIFICATION_CODE_ID,
  GENERATE_PASSWORD_ID,
  NOOP_COMMAND_SUFFIX,
} from "@bitwarden/common/autofill/constants";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { EventCollectionService } from "@bitwarden/common/dirt/event-logs";
import { IntraprocessMessageSender } from "@bitwarden/common/platform/messaging";
import { FakeAccountService, mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { TotpService } from "@bitwarden/common/vault/abstractions/totp.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherRepromptType } from "@bitwarden/common/vault/enums/cipher-reprompt-type";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { BrowserApi } from "../../platform/browser/browser-api";
import BrowserPopupUtils from "../../platform/browser/browser-popup-utils";
import AutofillPageDetails from "../models/autofill-page-details";
import { AutofillTriageService } from "../services/abstractions/autofill-triage.service";
import { CipherUse } from "../services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../services/abstractions/multi-account-fill-cipher-policy";
import { WebmapperDraftService } from "../services/webmapper-draft.service";
import { AutofillTriageFieldResult } from "../types/autofill-triage";
import { emptyDraft, WebmapperDraft } from "../webmapper/draft";
import {
  WEBMAPPER_CONTAINER_ID,
  WEBMAPPER_IRRELEVANT_ID,
  WEBMAPPER_ROOT_ID,
} from "../webmapper/menu";

import {
  CopyToClipboardAction,
  ContextMenuClickedHandler,
  CopyToClipboardOptions,
  GeneratePasswordToClipboardAction,
  AutofillAction,
  CollectAutofillTriageAction,
} from "./context-menu-clicked-handler";

describe("ContextMenuClickedHandler", () => {
  const createData = (
    menuItemId: chrome.contextMenus.OnClickData["menuItemId"],
    parentMenuItemId?: chrome.contextMenus.OnClickData["parentMenuItemId"],
  ): chrome.contextMenus.OnClickData => {
    return {
      menuItemId: menuItemId,
      parentMenuItemId: parentMenuItemId,
      editable: false,
      pageUrl: "something",
    };
  };

  const mockUserId = "UserId" as UserId;
  const otherUserId = "OtherUserId" as UserId;

  /** Serves `ciphers` to lookups by reference, as the vault of `owner` would. */
  const serveCiphers = (
    policy: MockProxy<MultiAccountFillCipherPolicy>,
    ciphers: CipherView[],
    owner: UserId = mockUserId,
  ) =>
    policy.ciphersForRefs.mockImplementation(async (refs) =>
      refs.flatMap((ref) =>
        ciphers
          .filter((cipher) => ref.userId === owner && ref.cipherId === cipher.id)
          .map((cipher) => ({ userId: owner, cipher })),
      ),
    );

  /** The menu item id of cipher `cipherId` of `owner` beneath `parentId`. */
  const cipherItem = (parentId: string, cipherId = "1", owner: UserId = mockUserId) =>
    `${parentId}_${owner}:${cipherId}`;

  const createCipher = (data?: {
    id?: CipherView["id"];
    username?: CipherView["login"]["username"];
    password?: CipherView["login"]["password"];
    totp?: CipherView["login"]["totp"];
  }): CipherView => {
    const { id, username, password, totp } = data || {};
    const cipherView = new CipherView(
      new Cipher({
        id: id ?? "1",
        type: CipherType.Login,
      } as any),
    );

    cipherView.login.username = username ?? "USERNAME";
    cipherView.login.password = password ?? "PASSWORD";
    cipherView.login.totp = totp ?? "TOTP";
    return cipherView;
  };

  let copyToClipboard: CopyToClipboardAction;
  let generatePasswordToClipboard: GeneratePasswordToClipboardAction;
  let autofill: AutofillAction;
  let switchAccount: jest.Mock<Promise<void>, [UserId]>;
  let collectAutofillTriage: jest.Mock<ReturnType<CollectAutofillTriageAction>, [number, number?]>;
  // The accounts autofill serves: the unlocked active account, nobody opted in.
  let autofillUserIds$: BehaviorSubject<UserId[]>;
  let fillCipherPolicy: MockProxy<MultiAccountFillCipherPolicy>;
  let accountService: FakeAccountService;
  let totpService: MockProxy<TotpService>;
  let eventCollectionService: MockProxy<EventCollectionService>;
  let userVerificationService: MockProxy<UserVerificationService>;
  let triageService: MockProxy<AutofillTriageService>;
  let webmapperDrafts: MockProxy<WebmapperDraftService>;
  let intraprocessMessageSender: MockProxy<IntraprocessMessageSender>;

  let sut: ContextMenuClickedHandler;

  beforeEach(() => {
    copyToClipboard = jest.fn<void, [CopyToClipboardOptions]>();
    generatePasswordToClipboard = jest.fn<Promise<void>, [tab: chrome.tabs.Tab]>();
    autofill = jest.fn<Promise<void>, [tab: chrome.tabs.Tab, cipher: CipherView, userId: UserId]>();
    collectAutofillTriage = jest.fn<ReturnType<CollectAutofillTriageAction>, [number, number?]>();
    switchAccount = jest.fn<Promise<void>, [UserId]>();
    autofillUserIds$ = new BehaviorSubject<UserId[]>([mockUserId]);
    fillCipherPolicy = mock();
    accountService = mockAccountServiceWith(mockUserId as UserId);
    totpService = mock();
    eventCollectionService = mock();
    userVerificationService = mock();
    triageService = mock();
    webmapperDrafts = mock();
    intraprocessMessageSender = mock();

    sut = new ContextMenuClickedHandler(
      copyToClipboard,
      generatePasswordToClipboard,
      autofill,
      collectAutofillTriage,
      { autofillUserIds$ } as unknown as AutofillAccountsService,
      totpService,
      eventCollectionService,
      userVerificationService,
      accountService,
      triageService,
      webmapperDrafts,
      intraprocessMessageSender,
      fillCipherPolicy,
      switchAccount,
    );
  });

  afterEach(() => jest.resetAllMocks());

  describe("run", () => {
    beforeEach(() => {
      userVerificationService.hasMasterPassword.mockResolvedValue(false);
    });

    const runWithUrl = (data: chrome.contextMenus.OnClickData) =>
      sut.run(data, { url: "https://test.com" } as any);

    describe("early returns", () => {
      it.each([
        {
          name: "tab id is missing",
          data: createData(COPY_IDENTIFIER_ID),
          tab: { url: "https://test.com" } as any,
          expectNotCalled: () => expect(copyToClipboard).not.toHaveBeenCalled(),
        },
        {
          name: "tab url is missing",
          data: createData(`${COPY_USERNAME_ID}_${NOOP_COMMAND_SUFFIX}`, COPY_USERNAME_ID),
          tab: {} as any,
          expectNotCalled: () => {
            expect(fillCipherPolicy.ciphersForUrl).not.toHaveBeenCalled();
            expect(copyToClipboard).not.toHaveBeenCalled();
          },
        },
      ])("returns early when $name", async ({ data, tab, expectNotCalled }) => {
        await expect(sut.run(data, tab)).resolves.toBeUndefined();
        expectNotCalled();
      });
    });

    describe("missing cipher", () => {
      it.each([
        {
          label: "AUTOFILL",
          parentId: AUTOFILL_ID,
          extra: () => expect(autofill).not.toHaveBeenCalled(),
        },
        { label: "username", parentId: COPY_USERNAME_ID, extra: () => {} },
        { label: "password", parentId: COPY_PASSWORD_ID, extra: () => {} },
        {
          label: "totp",
          parentId: COPY_VERIFICATION_CODE_ID,
          extra: () => expect(totpService.getCode$).not.toHaveBeenCalled(),
        },
      ])("breaks silently when cipher is missing for $label", async ({ parentId, extra }) => {
        serveCiphers(fillCipherPolicy, []);

        await expect(
          runWithUrl(createData(cipherItem(parentId), parentId)),
        ).resolves.toBeUndefined();

        expect(copyToClipboard).not.toHaveBeenCalled();
        extra();
      });
    });

    describe("missing login properties", () => {
      it.each([
        {
          label: "username",
          parentId: COPY_USERNAME_ID,
          unset: (c: CipherView): void => (c.login.username = undefined),
        },
        {
          label: "password",
          parentId: COPY_PASSWORD_ID,
          unset: (c: CipherView): void => (c.login.password = undefined),
        },
        {
          label: "totp",
          parentId: COPY_VERIFICATION_CODE_ID,
          unset: (c: CipherView): void => (c.login.totp = undefined),
          isTotp: true,
        },
      ])("breaks silently when $label property is missing", async ({ parentId, unset, isTotp }) => {
        const cipher = createCipher();
        unset(cipher);
        serveCiphers(fillCipherPolicy, [cipher]);

        await expect(
          runWithUrl(createData(cipherItem(parentId), parentId)),
        ).resolves.toBeUndefined();

        expect(copyToClipboard).not.toHaveBeenCalled();
        if (isTotp) {
          expect(totpService.getCode$).not.toHaveBeenCalled();
        }
      });
    });

    it("can generate password", async () => {
      await sut.run(createData(GENERATE_PASSWORD_ID), { id: 5 } as any);

      expect(generatePasswordToClipboard).toHaveBeenCalledTimes(1);

      expect(generatePasswordToClipboard).toHaveBeenCalledWith({
        id: 5,
      });
    });

    it("attempts to autofill the correct cipher", async () => {
      const cipher = createCipher();
      serveCiphers(fillCipherPolicy, [cipher]);

      await sut.run(createData(cipherItem(AUTOFILL_ID), AUTOFILL_ID), { id: 5 } as any);

      expect(autofill).toHaveBeenCalledTimes(1);

      expect(autofill).toHaveBeenCalledWith({ id: 5 }, cipher, mockUserId);
    });

    it("looks up the cipher the user picked by id as a user fill", async () => {
      serveCiphers(fillCipherPolicy, [createCipher()]);

      await sut.run(createData(cipherItem(AUTOFILL_ID), AUTOFILL_ID), { id: 5 } as any);

      expect(fillCipherPolicy.ciphersForRefs).toHaveBeenCalledWith(
        [{ userId: mockUserId, cipherId: "1" }],
        CipherUse.UserFill,
      );
    });

    it("copies username to clipboard", async () => {
      serveCiphers(fillCipherPolicy, [createCipher({ username: "TEST_USERNAME" })]);

      await sut.run(createData(cipherItem(COPY_USERNAME_ID), COPY_USERNAME_ID), {
        url: "https://test.com",
      } as any);

      expect(copyToClipboard).toHaveBeenCalledTimes(1);

      expect(copyToClipboard).toHaveBeenCalledWith({
        text: "TEST_USERNAME",
        tab: { url: "https://test.com" },
      });
    });

    it("copies password to clipboard", async () => {
      serveCiphers(fillCipherPolicy, [createCipher({ password: "TEST_PASSWORD" })]);

      await sut.run(createData(cipherItem(COPY_PASSWORD_ID), COPY_PASSWORD_ID), {
        url: "https://test.com",
      } as any);

      expect(copyToClipboard).toHaveBeenCalledTimes(1);

      expect(copyToClipboard).toHaveBeenCalledWith({
        text: "TEST_PASSWORD",
        tab: { url: "https://test.com" },
      });
    });

    it("copies totp code to clipboard", async () => {
      serveCiphers(fillCipherPolicy, [createCipher({ totp: "TEST_TOTP_SEED" })]);

      jest.spyOn(totpService, "getCode$").mockImplementation((seed: string) => {
        if (seed === "TEST_TOTP_SEED") {
          return of({
            code: "123456",
            period: 30,
          });
        }

        return of({
          code: "654321",
          period: 30,
        });
      });

      await sut.run(createData(cipherItem(COPY_VERIFICATION_CODE_ID), COPY_VERIFICATION_CODE_ID), {
        url: "https://test.com",
      } as any);

      expect(totpService.getCode$).toHaveBeenCalledTimes(1);

      expect(copyToClipboard).toHaveBeenCalledWith({
        text: "123456",
        tab: { url: "https://test.com" },
      });
    });

    it("attempts to find a cipher when noop but unlocked", async () => {
      fillCipherPolicy.ciphersForUrl.mockResolvedValue([
        {
          userId: mockUserId,
          cipher: {
            ...createCipher({ username: "NOOP_USERNAME" }),
            reprompt: CipherRepromptType.None,
          } as any,
        },
      ]);

      await sut.run(createData(`${COPY_USERNAME_ID}_${NOOP_COMMAND_SUFFIX}`, COPY_USERNAME_ID), {
        url: "https://test.com",
      } as any);

      expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledTimes(1);

      expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledWith(
        "https://test.com",
        CipherUse.UserFill,
        { includeOtherTypes: [] },
      );

      expect(copyToClipboard).toHaveBeenCalledTimes(1);

      expect(copyToClipboard).toHaveBeenCalledWith({
        text: "NOOP_USERNAME",
        tab: { url: "https://test.com" },
      });
    });

    it("attempts to find a cipher when noop but unlocked", async () => {
      fillCipherPolicy.ciphersForUrl.mockResolvedValue([
        {
          userId: mockUserId,
          cipher: {
            ...createCipher({ username: "NOOP_USERNAME" }),
            reprompt: CipherRepromptType.Password,
          } as any,
        },
      ]);

      await sut.run(createData(`${COPY_USERNAME_ID}_${NOOP_COMMAND_SUFFIX}`, COPY_USERNAME_ID), {
        url: "https://test.com",
      } as any);

      expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledTimes(1);

      expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledWith(
        "https://test.com",
        CipherUse.UserFill,
        { includeOtherTypes: [] },
      );
    });

    describe("with two accounts serving autofill", () => {
      const tab = { id: 5, url: "https://test.com" } as any;

      beforeEach(() => {
        autofillUserIds$.next([mockUserId, otherUserId]);
        jest.spyOn(BrowserPopupUtils, "openPopout").mockResolvedValue(undefined);
        jest.spyOn(BrowserApi, "tabSendMessageData").mockResolvedValue(undefined);
      });

      it("fills the cipher of the account its menu item names, for that account", async () => {
        const cipher = createCipher();
        serveCiphers(fillCipherPolicy, [cipher], otherUserId);
        const setAccountActivity = jest.spyOn(accountService, "setAccountActivity");

        await sut.run(createData(cipherItem(AUTOFILL_ID, "1", otherUserId), AUTOFILL_ID), tab);

        expect(autofill).toHaveBeenCalledWith(tab, cipher, otherUserId);
        expect(setAccountActivity).toHaveBeenCalledTimes(1);
        expect(setAccountActivity).toHaveBeenCalledWith(otherUserId, expect.any(Date));
      });

      it("fills the same shared item from the vault of the account that was picked", async () => {
        // The item has one id in both vaults; the policy answers per reference.
        const activeCopy = createCipher({ id: "shared", username: "active" });
        const otherCopy = createCipher({ id: "shared", username: "other" });
        fillCipherPolicy.ciphersForRefs.mockImplementation(async ([ref]) => [
          { userId: ref.userId, cipher: ref.userId === otherUserId ? otherCopy : activeCopy },
        ]);

        await sut.run(createData(cipherItem(AUTOFILL_ID, "shared", otherUserId), AUTOFILL_ID), tab);

        expect(autofill).toHaveBeenCalledTimes(1);
        expect(autofill).toHaveBeenCalledWith(tab, otherCopy, otherUserId);
      });

      it("does nothing for an item of an account that has locked since the menu was built", async () => {
        // `ciphersForRefs` leaves out a cipher whose account no longer serves autofill.
        fillCipherPolicy.ciphersForRefs.mockResolvedValue([]);

        await sut.run(createData(cipherItem(AUTOFILL_ID, "1", otherUserId), AUTOFILL_ID), tab);

        expect(autofill).not.toHaveBeenCalled();
        expect(copyToClipboard).not.toHaveBeenCalled();
      });

      it("ignores an item id that names no account", async () => {
        await sut.run(createData(`${AUTOFILL_ID}_1`, AUTOFILL_ID), tab);

        expect(fillCipherPolicy.ciphersForRefs).not.toHaveBeenCalled();
        expect(autofill).not.toHaveBeenCalled();
      });

      it("records a copied password for the account that owns the cipher", async () => {
        serveCiphers(fillCipherPolicy, [createCipher({ password: "PW" })], otherUserId);

        await sut.run(
          createData(cipherItem(COPY_PASSWORD_ID, "1", otherUserId), COPY_PASSWORD_ID),
          tab,
        );

        expect(copyToClipboard).toHaveBeenCalledWith({ text: "PW", tab });
        expect(eventCollectionService.collect).toHaveBeenCalledWith(
          expect.anything(),
          "1",
          false,
          undefined,
          otherUserId,
        );
      });

      describe("a reprompt-protected cipher of an account that is not active", () => {
        let cipher: CipherView;

        beforeEach(async () => {
          cipher = createCipher();
          cipher.reprompt = CipherRepromptType.Password;
          serveCiphers(fillCipherPolicy, [cipher], otherUserId);
          userVerificationService.hasMasterPassword.mockResolvedValue(true);
          autofillUserIds$.next([mockUserId as UserId, otherUserId]);
          await accountService.addAccount(otherUserId, {
            email: "other@example.com",
            emailVerified: true,
            name: "Other",
          } as any);
          await accountService.switchAccount(mockUserId as UserId);
        });

        it("makes its account the active one before the reprompt popout opens", async () => {
          const activeAtPopout: (UserId | undefined)[] = [];
          switchAccount.mockImplementation((userId) => accountService.switchAccount(userId));
          jest.spyOn(BrowserPopupUtils, "openPopout").mockImplementation(async () => {
            activeAtPopout.push((await firstValueFrom(accountService.activeAccount$))?.id);
            return undefined as unknown as chrome.windows.Window;
          });

          await sut.run(createData(cipherItem(AUTOFILL_ID, "1", otherUserId), AUTOFILL_ID), tab);

          expect(userVerificationService.hasMasterPassword).toHaveBeenCalledWith(otherUserId);
          expect(switchAccount).toHaveBeenCalledWith(otherUserId);
          expect(activeAtPopout).toEqual([otherUserId]);
          // The fill follows the reprompt, from the popout.
          expect(autofill).not.toHaveBeenCalled();
        });

        it("refuses without a popout when the switch does not take effect", async () => {
          switchAccount.mockResolvedValue(undefined);

          await sut.run(createData(cipherItem(AUTOFILL_ID, "1", otherUserId), AUTOFILL_ID), tab);

          expect(switchAccount).toHaveBeenCalledWith(otherUserId);
          expect(autofill).not.toHaveBeenCalled();
          expect(BrowserPopupUtils.openPopout).not.toHaveBeenCalled();
        });

        it("refuses without switching when its account no longer serves autofill", async () => {
          autofillUserIds$.next([mockUserId as UserId]);

          await sut.run(
            createData(cipherItem(COPY_PASSWORD_ID, "1", otherUserId), COPY_PASSWORD_ID),
            tab,
          );

          expect(switchAccount).not.toHaveBeenCalled();
          expect(copyToClipboard).not.toHaveBeenCalled();
          expect(BrowserPopupUtils.openPopout).not.toHaveBeenCalled();
        });
      });

      it("opens the reprompt popout for a protected cipher of the active account", async () => {
        const cipher = createCipher();
        cipher.reprompt = CipherRepromptType.Password;
        serveCiphers(fillCipherPolicy, [cipher]);
        userVerificationService.hasMasterPassword.mockResolvedValue(true);

        await sut.run(createData(cipherItem(AUTOFILL_ID), AUTOFILL_ID), tab);

        expect(autofill).not.toHaveBeenCalled();
        expect(BrowserPopupUtils.openPopout).toHaveBeenCalled();
      });
    });

    describe("autofill triage", () => {
      const mockTab = { id: 42, url: "https://example.com", windowId: 1 } as chrome.tabs.Tab;
      const mockPageDetails = { fields: [], forms: {} } as unknown as AutofillPageDetails;
      const mockTriageResult: AutofillTriageFieldResult = {
        htmlId: "test-field",
        eligible: true,
        qualifiedAs: "login",
        conditions: [],
      };

      beforeEach(() => {
        collectAutofillTriage.mockResolvedValue({ pageDetails: mockPageDetails } as any);
        jest.spyOn(BrowserPopupUtils, "openPopout").mockResolvedValue(undefined);
        jest.spyOn(BrowserApi, "setSidePanelOptions").mockResolvedValue(undefined);
        jest.spyOn(BrowserApi, "openSidePanel").mockResolvedValue(undefined);
        jest.spyOn(BrowserApi, "isSidePanelApiSupported", "get").mockReturnValue(false);
        triageService.triageField.mockReturnValue(mockTriageResult);
        // Mock chrome.runtime.getManifest
        (global as any).chrome = {
          ...((global as any).chrome || {}),
          runtime: {
            ...((global as any).chrome?.runtime || {}),
            getManifest: jest.fn().mockReturnValue({ version: "1.0.0" }),
          },
        };
      });

      it("collects triage through the orchestrator and stores the result", async () => {
        await sut.run(createData(AUTOFILL_TRIAGE_ID), mockTab);

        expect(collectAutofillTriage).toHaveBeenCalledWith(mockTab.id, undefined);
        expect(sut.triageResult).not.toBeUndefined();
        expect(sut.triageResult?.tabId).toBe(mockTab.id);
        expect(sut.triageResult?.pageUrl).toBe(mockTab.url);
      });

      it("opens the autofill triage popout when side panel API is not supported", async () => {
        await sut.run(createData(AUTOFILL_TRIAGE_ID), mockTab);

        expect(BrowserPopupUtils.openPopout).toHaveBeenCalledWith(
          "popup/index.html#/autofill-triage",
          expect.objectContaining({ singleActionKey: AUTOFILL_TRIAGE_ID }),
        );
        expect(BrowserApi.setSidePanelOptions).not.toHaveBeenCalled();
        expect(BrowserApi.openSidePanel).not.toHaveBeenCalled();
      });

      it("opens the Chrome side panel when side panel API is supported", async () => {
        jest.spyOn(BrowserApi, "isSidePanelApiSupported", "get").mockReturnValue(true);

        await sut.run(createData(AUTOFILL_TRIAGE_ID), mockTab);

        expect(BrowserApi.setSidePanelOptions).toHaveBeenCalledWith(
          expect.objectContaining({
            path: expect.stringContaining("uilocation=sidepanel"),
            tabId: mockTab.id,
            enabled: true,
          }),
        );
        expect(BrowserApi.openSidePanel).toHaveBeenCalledWith({ tabId: mockTab.id });
        expect(BrowserPopupUtils.openPopout).not.toHaveBeenCalled();
      });

      it("sends triageResultReady message with tabId after collecting results", async () => {
        const sendMessageSpy = jest.spyOn(BrowserApi, "sendMessage").mockResolvedValue(undefined);

        await sut.run(createData(AUTOFILL_TRIAGE_ID), mockTab);

        expect(sendMessageSpy).toHaveBeenCalledWith("triageResultReady", { tabId: mockTab.id });
      });

      it("does not open popout when tab has no id", async () => {
        const tabWithoutId = { url: "https://example.com" } as chrome.tabs.Tab;

        await sut.run(createData(AUTOFILL_TRIAGE_ID), tabWithoutId);

        expect(BrowserPopupUtils.openPopout).not.toHaveBeenCalled();
        expect(BrowserApi.openSidePanel).not.toHaveBeenCalled();
      });

      it("sends triageResultReady when page details collection fails so the component exits the loading state", async () => {
        const sendMessageSpy = jest.spyOn(BrowserApi, "sendMessage").mockResolvedValue(undefined);
        collectAutofillTriage.mockResolvedValue(undefined);

        await sut.run(createData(AUTOFILL_TRIAGE_ID), mockTab);

        expect(sendMessageSpy).toHaveBeenCalledWith("triageResultReady", { tabId: mockTab.id });
      });
    });

    describe("webmapper", () => {
      const mockTab = { id: 42, url: "https://example.com/login", windowId: 1 } as chrome.tabs.Tab;
      let sendMessageSpy: jest.SpyInstance;

      /** Answers the content script round trip with `response`. */
      function contentScriptAnswers(response: unknown) {
        jest
          .spyOn(BrowserApi, "sendTabsMessage")
          .mockImplementation((_tabId, _message, _options, callback?: (r: any) => void) => {
            callback?.(response);
          });
      }

      /** The draft produced by the last updateDraft call, mutator applied. */
      function written(): WebmapperDraft {
        const [host, pathname, mutate] = webmapperDrafts.updateDraft.mock.calls.at(-1)!;
        const draft = emptyDraft(host, pathname);
        mutate(draft);
        return draft;
      }

      function feedback(): { type: string; message: string } {
        const call = sendMessageSpy.mock.calls.find((c) => c[0] === "webmapperCaptureFeedback");
        return call?.[1];
      }

      beforeEach(() => {
        // webmapperSend reads chrome.runtime.lastError to tell "no content script
        // here" apart from "script answered with nothing"; start each test clean.
        (global as any).chrome = { runtime: {} };
        sendMessageSpy = jest.spyOn(BrowserApi, "sendMessage").mockResolvedValue(undefined);
        jest.spyOn(BrowserPopupUtils, "openPopout").mockResolvedValue(undefined);
        jest.spyOn(BrowserApi, "setSidePanelOptions").mockResolvedValue(undefined);
        jest.spyOn(BrowserApi, "openSidePanel").mockResolvedValue(undefined);
        jest.spyOn(BrowserApi, "isSidePanelApiSupported", "get").mockReturnValue(false);
        webmapperDrafts.getDraft.mockResolvedValue(emptyDraft("example.com", "/login"));
        webmapperDrafts.updateDraft.mockImplementation(async (host, pathname, mutate) => {
          const draft = emptyDraft(host, pathname);
          mutate(draft);
          return draft;
        });
        contentScriptAnswers({ selector: "#user", warnings: [], alternates: [] });
      });

      it("opens the panel on the webmapper view", async () => {
        await sut.run(createData("webmapper:field:username"), mockTab);

        expect(BrowserPopupUtils.openPopout).toHaveBeenCalledWith(
          expect.stringContaining("view=webmapper"),
          expect.anything(),
        );
      });

      it("captures a field selector into the draft for the tab's host and path", async () => {
        await sut.run(createData("webmapper:field:username"), mockTab);

        expect(webmapperDrafts.updateDraft).toHaveBeenCalledWith(
          "example.com",
          "/login",
          expect.any(Function),
        );
        expect(written().forms[0].fields.username).toEqual([
          { selector: "#user", warnings: [], alternates: [] },
        ]);
        expect(feedback().type).toBe("success");
      });

      it("captures an action selector into the actions slot", async () => {
        await sut.run(createData("webmapper:action:submit"), mockTab);

        expect(written().forms[0].actions.submit).toHaveLength(1);
      });

      it("reports an error and writes nothing when no content script answers", async () => {
        contentScriptAnswers(undefined);
        (global as any).chrome.runtime.lastError = { message: "no receiving end" };

        await sut.run(createData("webmapper:field:username"), mockTab);

        expect(webmapperDrafts.updateDraft).not.toHaveBeenCalled();
        expect(feedback().type).toBe("error");
      });

      it("reports an error and writes nothing when no selector could be generated", async () => {
        contentScriptAnswers({ selector: null, warnings: [], alternates: [] });

        await sut.run(createData("webmapper:field:username"), mockTab);

        expect(webmapperDrafts.updateDraft).not.toHaveBeenCalled();
        expect(feedback().type).toBe("error");
      });

      it("toggles the irrelevant flag and reports the resulting state", async () => {
        await sut.run(createData(WEBMAPPER_IRRELEVANT_ID), mockTab);

        expect(written().irrelevant).toBe(true);
        expect(feedback()).toEqual(
          expect.objectContaining({ type: "success", message: "Marked page irrelevant" }),
        );
      });

      it("stores container candidates for the panel to choose from", async () => {
        contentScriptAnswers({
          candidates: [{ selector: "form#login", label: "nearest <form>", tag: "form" }],
        });

        await sut.run(createData(WEBMAPPER_CONTAINER_ID), mockTab);

        expect(written().forms[0].pendingContainer).toHaveLength(1);
        expect(feedback().type).toBe("success");
      });

      it("reports an error when no container candidates come back", async () => {
        contentScriptAnswers({ candidates: [] });

        await sut.run(createData(WEBMAPPER_CONTAINER_ID), mockTab);

        expect(webmapperDrafts.updateDraft).not.toHaveBeenCalled();
        expect(feedback().type).toBe("error");
      });

      it("refuses to map a non-http(s) page", async () => {
        await sut.run(createData("webmapper:field:username"), {
          ...mockTab,
          url: "chrome://extensions",
        } as chrome.tabs.Tab);

        expect(webmapperDrafts.updateDraft).not.toHaveBeenCalled();
        expect(feedback().type).toBe("error");
      });

      it("ignores a click on a non-actionable parent item", async () => {
        await sut.run(createData(WEBMAPPER_ROOT_ID), mockTab);

        expect(webmapperDrafts.updateDraft).not.toHaveBeenCalled();
        expect(BrowserPopupUtils.openPopout).not.toHaveBeenCalled();
      });
    });
  });
});
