import { mock } from "jest-mock-extended";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherType } from "@bitwarden/common/vault/enums";

import { BrowserApi } from "../../../platform/browser/browser-api";
import BrowserPopupUtils from "../../../platform/browser/browser-popup-utils";

import {
  openViewVaultItemPopout,
  closeAddEditVaultItemPopout,
  closeFido2Popout,
  openAddEditVaultItemPopout,
  openFido2Popout,
  openVaultItemPasswordRepromptPopout,
  VaultPopoutType,
  closeViewVaultItemPopout,
  viewVaultItemPopoutKey,
} from "./vault-popout-window";

describe("VaultPopoutWindow", () => {
  const userId = "f2c1e6a0-0000-4000-8000-000000000001" as UserId;

  const openPopoutSpy = jest
    .spyOn(BrowserPopupUtils, "openPopout")
    .mockResolvedValue(mock<chrome.windows.Window>({ id: 10 }));
  const closeSingleActionPopoutSpy = jest
    .spyOn(BrowserPopupUtils, "closeSingleActionPopout")
    .mockImplementation();

  beforeEach(() => {
    jest.spyOn(BrowserApi, "tabsQuery").mockResolvedValue([]);
    jest.spyOn(BrowserApi, "updateWindowProperties").mockResolvedValue();
    global.chrome = {
      ...global.chrome,
      runtime: {
        ...global.chrome?.runtime,
        sendMessage: jest.fn().mockResolvedValue(undefined),
        getURL: jest.fn((path) => `chrome-extension://extension-id/${path}`),
      },
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("openViewVaultItemPopout", () => {
    it("opens a popout window that contains a sender tab id query param reference", async () => {
      const senderTab = { id: 1, windowId: 2 } as chrome.tabs.Tab;

      await openViewVaultItemPopout(senderTab, {
        cipherId: "cipherId",
        action: "action",
      });

      expect(openPopoutSpy).toHaveBeenCalledWith(
        "popup/index.html#/view-cipher?cipherId=cipherId&senderTabId=1&action=action",
        {
          singleActionKey: `${VaultPopoutType.viewVaultItem}_cipherId`,
          senderWindowId: 2,
          forceCloseExistingWindows: undefined,
        },
      );
    });

    it("opens the popout for the account that owns the item", async () => {
      const senderTab = { id: 1, windowId: 2 } as chrome.tabs.Tab;

      await openViewVaultItemPopout(senderTab, {
        cipherId: "cipherId",
        action: "action",
        userId,
      });

      expect(openPopoutSpy).toHaveBeenCalledWith(
        `popup/index.html#/view-cipher?cipherId=cipherId&senderTabId=1&action=action&userId=${userId}`,
        {
          singleActionKey: `${VaultPopoutType.viewVaultItem}_${userId}_cipherId`,
          senderWindowId: 2,
          forceCloseExistingWindows: undefined,
        },
      );
    });

    it("keys the popouts of one item in two accounts apart", () => {
      const activeKey = viewVaultItemPopoutKey("cipherId");
      const accountKey = viewVaultItemPopoutKey("cipherId", userId);

      expect(activeKey).toBe(`${VaultPopoutType.viewVaultItem}_cipherId`);
      expect(accountKey.startsWith(activeKey)).toBe(false);
      expect(activeKey.startsWith(accountKey)).toBe(false);
    });
  });

  describe("closeViewVaultItemPopout", () => {
    it("closes the view vault item popout window", async () => {
      await closeViewVaultItemPopout("cipherId");

      expect(closeSingleActionPopoutSpy).toHaveBeenCalledWith(`cipherId`, 0);
    });
  });

  describe("openVaultItemPasswordRepromptPopout", () => {
    it("opens a popout window that facilitates re-prompting for the password of a vault item", async () => {
      const senderTab = { windowId: 1 } as chrome.tabs.Tab;

      await openVaultItemPasswordRepromptPopout(senderTab, {
        cipherId: "cipherId",
        action: "action",
      });

      expect(openPopoutSpy).toHaveBeenCalledWith(
        "popup/index.html#/view-cipher?cipherId=cipherId&action=action",
        {
          singleActionKey: `${VaultPopoutType.viewVaultItem}_cipherId`,
          senderWindowId: 1,
          forceCloseExistingWindows: true,
        },
      );
    });

    it("opens the re-prompt for the account that owns the item", async () => {
      const senderTab = { id: 3, windowId: 1 } as chrome.tabs.Tab;
      const tabSendMessageData = jest.spyOn(BrowserApi, "tabSendMessageData").mockResolvedValue();

      await openVaultItemPasswordRepromptPopout(senderTab, {
        cipherId: "cipherId",
        action: "autofill",
        userId,
      });

      expect(openPopoutSpy).toHaveBeenCalledWith(
        `popup/index.html#/view-cipher?cipherId=cipherId&senderTabId=3&action=autofill&userId=${userId}`,
        {
          singleActionKey: `${VaultPopoutType.viewVaultItem}_${userId}_cipherId`,
          senderWindowId: 1,
          forceCloseExistingWindows: true,
        },
      );
      expect(tabSendMessageData).toHaveBeenCalledWith(senderTab, "bgVaultItemRepromptPopoutOpened");
    });
  });

  describe("openAddEditVaultItemPopout", () => {
    it("opens a popout window that facilitates adding a vault item", async () => {
      await openAddEditVaultItemPopout(
        mock<chrome.tabs.Tab>({ id: 2, windowId: 1, url: "https://jest-testing-website.com" }),
      );

      expect(openPopoutSpy).toHaveBeenCalledWith(
        "popup/index.html#/edit-cipher?uri=https://jest-testing-website.com&senderTabId=2",
        {
          singleActionKey: VaultPopoutType.addEditVaultItem,
          senderWindowId: 1,
        },
      );
    });

    it("opens a popout window that facilitates adding a specific type of vault item", async () => {
      await openAddEditVaultItemPopout(
        mock<chrome.tabs.Tab>({ id: 2, windowId: 1, url: "https://jest-testing-website.com" }),
        {
          cipherType: CipherType.Identity,
        },
      );

      expect(openPopoutSpy).toHaveBeenCalledWith(
        `popup/index.html#/edit-cipher?type=${CipherType.Identity}&uri=https://jest-testing-website.com&senderTabId=2`,
        {
          singleActionKey: `${VaultPopoutType.addEditVaultItem}_${CipherType.Identity}`,
          senderWindowId: 1,
        },
      );
    });

    it("opens a popout window that facilitates editing a vault item", async () => {
      await openAddEditVaultItemPopout(
        mock<chrome.tabs.Tab>({ id: 2, windowId: 1, url: "https://jest-testing-website.com" }),
        {
          cipherId: "cipherId",
        },
      );

      expect(openPopoutSpy).toHaveBeenCalledWith(
        "popup/index.html#/edit-cipher?cipherId=cipherId&uri=https://jest-testing-website.com&senderTabId=2",
        {
          singleActionKey: `${VaultPopoutType.addEditVaultItem}_cipherId`,
          senderWindowId: 1,
        },
      );
    });

    it("sends a message to refresh data when the popup is already open", async () => {
      const existingPopupTab = {
        id: 123,
        windowId: 456,
        url: `chrome-extension://extension-id/popup/index.html#/edit-cipher?singleActionPopout=${VaultPopoutType.addEditVaultItem}_${CipherType.Login}`,
      } as chrome.tabs.Tab;

      jest.spyOn(BrowserApi, "tabsQuery").mockResolvedValue([existingPopupTab]);
      const sendMessageSpy = jest.spyOn(chrome.runtime, "sendMessage");
      const updateWindowSpy = jest.spyOn(BrowserApi, "updateWindowProperties");

      await openAddEditVaultItemPopout(
        mock<chrome.tabs.Tab>({ windowId: 1, url: "https://jest-testing-website.com" }),
        {
          cipherType: CipherType.Login,
        },
      );

      expect(openPopoutSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalledWith({
        command: "reloadAddEditCipherData",
        data: { cipherId: undefined, cipherType: CipherType.Login },
      });
      expect(updateWindowSpy).toHaveBeenCalledWith(456, { focused: true });
    });

    it("opens a popout that adds an item to a given account", async () => {
      await openAddEditVaultItemPopout(
        mock<chrome.tabs.Tab>({ id: 2, windowId: 1, url: "https://jest-testing-website.com" }),
        { cipherType: CipherType.Login, userId },
      );

      expect(openPopoutSpy).toHaveBeenCalledWith(
        `popup/index.html#/edit-cipher?type=${CipherType.Login}&uri=https://jest-testing-website.com&senderTabId=2&userId=${userId}`,
        {
          singleActionKey: `${VaultPopoutType.addEditVaultItem}_${userId}_${CipherType.Login}`,
          senderWindowId: 1,
        },
      );
    });

    it("opens a popout that edits an item of a given account", async () => {
      await openAddEditVaultItemPopout(
        mock<chrome.tabs.Tab>({ id: 2, windowId: 1, url: "https://jest-testing-website.com" }),
        { cipherId: "cipherId", userId },
      );

      expect(openPopoutSpy).toHaveBeenCalledWith(
        `popup/index.html#/edit-cipher?cipherId=cipherId&uri=https://jest-testing-website.com&senderTabId=2&userId=${userId}`,
        {
          singleActionKey: `${VaultPopoutType.addEditVaultItem}_${userId}_cipherId`,
          senderWindowId: 1,
        },
      );
    });

    it("names the account in the refresh message and focuses that account's popout", async () => {
      const popoutOf = (windowId: number, key: string, query: string) =>
        ({
          id: windowId,
          windowId,
          url: `chrome-extension://extension-id/popup/index.html?singleActionPopout=${key}#/edit-cipher?${query}`,
        }) as chrome.tabs.Tab;
      jest
        .spyOn(BrowserApi, "tabsQuery")
        .mockResolvedValue([
          popoutOf(456, `${VaultPopoutType.addEditVaultItem}_${CipherType.Login}`, "type=1"),
          popoutOf(
            789,
            `${VaultPopoutType.addEditVaultItem}_${userId}_${CipherType.Login}`,
            `type=1&userId=${userId}`,
          ),
        ]);
      const sendMessageSpy = jest.spyOn(chrome.runtime, "sendMessage");
      const updateWindowSpy = jest.spyOn(BrowserApi, "updateWindowProperties");

      await openAddEditVaultItemPopout(
        mock<chrome.tabs.Tab>({ windowId: 1, url: "https://jest-testing-website.com" }),
        { cipherType: CipherType.Login, userId },
      );

      expect(sendMessageSpy).toHaveBeenCalledWith({
        command: "reloadAddEditCipherData",
        data: { cipherId: undefined, cipherType: CipherType.Login, userId },
      });
      expect(updateWindowSpy).toHaveBeenCalledWith(789, { focused: true });
      expect(openPopoutSpy).not.toHaveBeenCalled();
    });

    it("does not take another account's popout for the active account's", async () => {
      jest.spyOn(BrowserApi, "tabsQuery").mockResolvedValue([
        {
          id: 789,
          windowId: 789,
          url: `chrome-extension://extension-id/popup/index.html?singleActionPopout=${VaultPopoutType.addEditVaultItem}_${userId}_${CipherType.Login}#/edit-cipher?type=1&userId=${userId}`,
        } as chrome.tabs.Tab,
      ]);
      const updateWindowSpy = jest.spyOn(BrowserApi, "updateWindowProperties");

      await openAddEditVaultItemPopout(
        mock<chrome.tabs.Tab>({ id: 2, windowId: 1, url: "https://jest-testing-website.com" }),
      );

      expect(updateWindowSpy).not.toHaveBeenCalled();
      expect(openPopoutSpy).toHaveBeenCalledWith(
        "popup/index.html#/edit-cipher?uri=https://jest-testing-website.com&senderTabId=2",
        { singleActionKey: VaultPopoutType.addEditVaultItem, senderWindowId: 1 },
      );
    });
  });

  describe("closeAddEditVaultItemPopout", () => {
    it("closes the add/edit vault item popout window", async () => {
      await closeAddEditVaultItemPopout();

      expect(closeSingleActionPopoutSpy).toHaveBeenCalledWith(VaultPopoutType.addEditVaultItem, 0);
    });

    it("closes only the add/edit popouts of the given account", async () => {
      jest.useFakeTimers();
      const popout = (windowId: number, query: string) =>
        ({ windowId, url: `chrome-extension://id/popup/index.html#/edit-cipher?${query}` }) as any;
      jest
        .spyOn(chrome.runtime, "getURL")
        .mockReturnValue("chrome-extension://id/popup/index.html");
      jest
        .spyOn(BrowserApi, "tabsQuery")
        .mockResolvedValue([
          popout(1, "type=1&userId=user-a&singleActionPopout=vault_AddEditVaultItem_user-a_1"),
          popout(2, "type=1&userId=user-b&singleActionPopout=vault_AddEditVaultItem_user-b_1"),
          popout(3, "type=1&singleActionPopout=vault_AddEditVaultItem_1"),
          popout(4, "cipherId=c&userId=user-a&singleActionPopout=vault_viewVaultItem_user-a_c"),
        ]);
      const removeWindow = jest.spyOn(BrowserApi, "removeWindow").mockResolvedValue(undefined);

      await closeAddEditVaultItemPopout(0, "user-a" as UserId);
      jest.runAllTimers();

      expect(removeWindow.mock.calls).toEqual([[1]]);
      expect(closeSingleActionPopoutSpy).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe("openFido2Popout", () => {
    it("opens a popout window that facilitates FIDO2 authentication workflows", async () => {
      const senderTab = mock<chrome.tabs.Tab>({
        windowId: 1,
        url: "https://jest-testing.com",
        id: 2,
      });

      const returnedWindowId = await openFido2Popout(senderTab, {
        sessionId: "sessionId",
        fallbackSupported: true,
        senderUrl: "https://jest-testing.com",
      });

      expect(openPopoutSpy).toHaveBeenCalledWith(
        "popup/index.html#/fido2?sessionId=sessionId&fallbackSupported=true&senderTabId=2&senderUrl=https%3A%2F%2Fjest-testing.com",
        {
          singleActionKey: `${VaultPopoutType.fido2Popout}_sessionId`,
          senderWindowId: 1,
          forceCloseExistingWindows: true,
          windowOptions: { height: 570 },
        },
      );
      expect(returnedWindowId).toEqual(10);
    });

    it("passes the requesting frame's URL rather than the tab's", async () => {
      const senderTab = mock<chrome.tabs.Tab>({
        windowId: 1,
        url: "https://top.example.com/checkout",
        id: 2,
      });

      await openFido2Popout(senderTab, {
        sessionId: "sessionId",
        fallbackSupported: false,
        senderUrl: "https://login.example.net/passkey",
      });

      expect(openPopoutSpy).toHaveBeenCalledWith(
        "popup/index.html#/fido2?sessionId=sessionId&fallbackSupported=false&senderTabId=2&senderUrl=https%3A%2F%2Flogin.example.net%2Fpasskey",
        expect.anything(),
      );
    });

    it.each([undefined, ""])(
      "omits the senderUrl query param when the sender URL is %p",
      async (senderUrl) => {
        const senderTab = mock<chrome.tabs.Tab>({
          windowId: 1,
          url: "https://top.example.com/checkout",
          id: 2,
        });

        await openFido2Popout(senderTab, {
          sessionId: "sessionId",
          fallbackSupported: false,
          senderUrl,
        });

        expect(openPopoutSpy).toHaveBeenCalledWith(
          "popup/index.html#/fido2?sessionId=sessionId&fallbackSupported=false&senderTabId=2",
          expect.anything(),
        );
      },
    );
  });

  describe("closeFido2Popout", () => {
    it("closes the fido2 popout window", async () => {
      const sessionId = "sessionId";

      await closeFido2Popout(sessionId);

      expect(closeSingleActionPopoutSpy).toHaveBeenCalledWith(
        `${VaultPopoutType.fido2Popout}_${sessionId}`,
      );
    });
  });
});
