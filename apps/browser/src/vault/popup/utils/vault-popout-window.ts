// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { UserId } from "@bitwarden/common/types/guid";
import { CipherType } from "@bitwarden/common/vault/enums";

import { BrowserApi } from "../../../platform/browser/browser-api";
import BrowserPopupUtils from "../../../platform/browser/browser-popup-utils";

const VaultPopoutType = {
  viewVaultItem: "vault_viewVaultItem",
  addEditVaultItem: "vault_AddEditVaultItem",
  fido2Popout: "vault_Fido2Popout",
} as const;

/**
 * The single action key of the popout that views a vault item.
 *
 * @param cipherId - The cipher the popout shows.
 * @param userId - The account the popout was opened for, as given to
 * {@link openViewVaultItemPopout}. A cipher id does not identify an account, so the popouts of
 * one shared item in two accounts have different keys, and neither key starts with the other:
 * popouts are found by the start of their key.
 */
function viewVaultItemPopoutKey(cipherId: string, userId?: UserId): string {
  return userId
    ? `${VaultPopoutType.viewVaultItem}_${userId}_${cipherId}`
    : `${VaultPopoutType.viewVaultItem}_${cipherId}`;
}

/** The account a vault item popout was opened for, read from its URL. */
function popoutAccount(url: string | undefined): string | undefined {
  return url?.match(/[?&]userId=([^&#]*)/)?.[1] || undefined;
}

/**
 * Opens a popout window that facilitates viewing a vault item.
 *
 * @param senderTab - The tab that sent the request.
 * @param cipherOptions - The cipher id and action to perform. `userId` names the account whose
 * vault holds the cipher: the popout then shows, re-prompts for and acts on that account without
 * making it the active one. It must be an unlocked autofill account, or the popout closes.
 * Without it the popout shows the active account's vault.
 */
async function openViewVaultItemPopout(
  senderTab: chrome.tabs.Tab,
  cipherOptions: {
    cipherId: string;
    action: string;
    forceCloseExistingWindows?: boolean;
    userId?: UserId;
  },
) {
  const { cipherId, action, forceCloseExistingWindows, userId } = cipherOptions;
  let promptWindowPath = "popup/index.html#/view-cipher";
  let queryParamToken = "?";
  const formatQueryString = (key: string, value: string) => {
    const queryString = `${queryParamToken}${key}=${value}`;
    queryParamToken = "&";
    return queryString;
  };

  if (cipherId) {
    promptWindowPath += formatQueryString("cipherId", cipherId);
  }
  if (senderTab.id) {
    promptWindowPath += formatQueryString("senderTabId", String(senderTab.id));
  }
  if (action) {
    promptWindowPath += formatQueryString("action", action);
  }
  if (userId) {
    promptWindowPath += formatQueryString("userId", userId);
  }

  await BrowserPopupUtils.openPopout(promptWindowPath, {
    singleActionKey: viewVaultItemPopoutKey(cipherId, userId),
    senderWindowId: senderTab.windowId,
    forceCloseExistingWindows,
  });
}

/**
 * Closes the view vault item popout window.
 *
 * @param singleActionKey - The single action popout key used to identify the popout.
 * @param delayClose - The amount of time to wait before closing the popout. Defaults to 0.
 */
async function closeViewVaultItemPopout(singleActionKey: string, delayClose = 0) {
  await BrowserPopupUtils.closeSingleActionPopout(singleActionKey, delayClose);
}

/**
 * Opens a popout window that facilitates re-prompting for
 * the password of a vault item.
 *
 * @param senderTab - The tab that sent the request.
 * @param cipherOptions - The cipher id and action to perform. `userId` names the account whose
 * vault holds the cipher: the popout asks for that account's master password and performs the
 * action for it, without making it the active account. Without it, the active account.
 */
async function openVaultItemPasswordRepromptPopout(
  senderTab: chrome.tabs.Tab,
  cipherOptions: {
    cipherId: string;
    action: string;
    userId?: UserId;
  },
) {
  await openViewVaultItemPopout(senderTab, {
    forceCloseExistingWindows: true,
    ...cipherOptions,
  });
  await BrowserApi.tabSendMessageData(senderTab, "bgVaultItemRepromptPopoutOpened");
}

/**
 * Opens a popout window that facilitates adding or editing a vault item.
 *
 * @param senderTab - The window id of the sender.
 * @param cipherOptions - Options passed as query params to the popout. `userId` names the account
 * whose vault the item is added to or edited in, without making it the active account. It must be
 * an unlocked autofill account, or the popout closes. Without it, the active account.
 */
async function openAddEditVaultItemPopout(
  senderTab: chrome.tabs.Tab,
  cipherOptions: {
    cipherId?: string;
    cipherType?: CipherType;
    fillAfterSave?: boolean;
    userId?: UserId;
  } = {},
) {
  const { cipherId, cipherType, fillAfterSave, userId } = cipherOptions;
  const { url, windowId } = senderTab;
  // A popout of another account is a different popout than the active account's.
  let singleActionKey: string = userId
    ? `${VaultPopoutType.addEditVaultItem}_${userId}`
    : VaultPopoutType.addEditVaultItem;
  let addEditCipherUrl = "popup/index.html#/edit-cipher";
  let queryParamToken = "?";
  const formatQueryString = (key: string, value: string) => {
    const queryString = `${queryParamToken}${key}=${value}`;
    queryParamToken = "&";
    return queryString;
  };

  if (cipherId && !cipherType) {
    singleActionKey += `_${cipherId}`;
    addEditCipherUrl += formatQueryString("cipherId", cipherId);
  }
  if (cipherType && !cipherId) {
    singleActionKey += `_${cipherType}`;
    addEditCipherUrl += formatQueryString("type", String(cipherType));
  }
  if (senderTab.url) {
    addEditCipherUrl += formatQueryString("uri", url);
  }
  if (senderTab.id) {
    addEditCipherUrl += formatQueryString("senderTabId", String(senderTab.id));
  }
  if (fillAfterSave) {
    addEditCipherUrl += formatQueryString("fillAfterSave", "true");
  }
  if (userId) {
    addEditCipherUrl += formatQueryString("userId", userId);
  }

  const extensionUrl = chrome.runtime.getURL("popup/index.html");
  const existingPopupTabs = await BrowserApi.tabsQuery({ url: `${extensionUrl}*` });
  const existingPopup = existingPopupTabs.find(
    (tab) =>
      tab.url?.includes(`singleActionPopout=${singleActionKey}`) &&
      // Popouts are found by the start of their key, which the plain key is for every popout.
      popoutAccount(tab.url) === (userId || undefined),
  );
  // Check if the an existing popup is already open
  try {
    await chrome.runtime.sendMessage({
      command: "reloadAddEditCipherData",
      data: { cipherId, cipherType, userId },
    });
    await BrowserApi.updateWindowProperties(existingPopup.windowId, {
      focused: true,
    });
  } catch {
    await BrowserPopupUtils.openPopout(addEditCipherUrl, {
      singleActionKey,
      senderWindowId: windowId,
    });
  }
}

/**
 * Closes the add/edit vault item popout window.
 *
 * @param delayClose - The amount of time to wait before closing the popout. Defaults to 0.
 */
async function closeAddEditVaultItemPopout(delayClose = 0) {
  await BrowserPopupUtils.closeSingleActionPopout(VaultPopoutType.addEditVaultItem, delayClose);
}

/**
 * Opens a popout window that facilitates FIDO2
 * authentication and passkey management.
 *
 * @param senderTab - The tab that sent the request.
 * @param options - Options passed as query params to the popout. `senderUrl` is the URL of the
 * frame that made the request, which differs from the tab's URL for a sub-frame request. It is
 * omitted from the query params when empty, so the popout treats the URL as absent.
 */
async function openFido2Popout(
  senderTab: chrome.tabs.Tab,
  options: {
    sessionId: string;
    fallbackSupported: boolean;
    senderUrl: string | undefined;
  },
): Promise<chrome.windows.Window["id"]> {
  const { sessionId, fallbackSupported, senderUrl } = options;
  let promptWindowPath =
    "popup/index.html#/fido2" +
    `?sessionId=${sessionId}` +
    `&fallbackSupported=${fallbackSupported}` +
    `&senderTabId=${senderTab.id}`;

  if (senderUrl) {
    promptWindowPath += `&senderUrl=${encodeURIComponent(senderUrl)}`;
  }

  const popoutWindow = await BrowserPopupUtils.openPopout(promptWindowPath, {
    singleActionKey: `${VaultPopoutType.fido2Popout}_${sessionId}`,
    senderWindowId: senderTab.windowId,
    forceCloseExistingWindows: true,
    windowOptions: { height: 570 },
  });

  return popoutWindow.id;
}

/**
 * Closes the FIDO2 popout window associated with the passed session ID.
 *
 * @param sessionId - The session ID of the popout to close.
 */
async function closeFido2Popout(sessionId: string): Promise<void> {
  await BrowserPopupUtils.closeSingleActionPopout(`${VaultPopoutType.fido2Popout}_${sessionId}`);
}

export {
  VaultPopoutType,
  viewVaultItemPopoutKey,
  openViewVaultItemPopout,
  closeViewVaultItemPopout,
  openVaultItemPasswordRepromptPopout,
  openAddEditVaultItemPopout,
  closeAddEditVaultItemPopout,
  openFido2Popout,
  closeFido2Popout,
};
