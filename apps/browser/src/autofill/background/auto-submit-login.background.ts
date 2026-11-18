import { filter, firstValueFrom, map, merge, switchMap } from "rxjs";

import { PolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { PolicyType } from "@bitwarden/common/admin-console/enums";
import { Policy } from "@bitwarden/common/admin-console/models/domain/policy";
import { getFirstPolicy } from "@bitwarden/common/admin-console/services/policy/default-policy.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { UserId } from "@bitwarden/common/types/guid";

import { BrowserApi } from "../../platform/browser/browser-api";
import { ScriptInjectorService } from "../../platform/services/abstractions/script-injector.service";
import {
  AutofillLifecycleService,
  AutomationWorkflow,
} from "../services/abstractions/autofill-lifecycle.service";

import {
  AutoSubmitLoginBackground as AutoSubmitLoginBackgroundAbstraction,
  AutoSubmitLoginBackgroundExtensionMessageHandlers,
  AutoSubmitLoginMessage,
} from "./abstractions/auto-submit-login.background";

export class AutoSubmitLoginBackground implements AutoSubmitLoginBackgroundAbstraction {
  /**
   * The IdP hosts each account's policy approves. An account is listed only while its policy is
   * enabled and applies to it.
   */
  private validIdpHosts: Map<UserId, Set<string>> = new Map();
  /**
   * The hosts of the active workflow, each with the accounts whose policy approved the IdP host
   * the workflow came from. A step on a host submits a cipher of those accounts only.
   */
  private validAutoSubmitHosts: Map<string, Set<UserId>> = new Map();
  private mostRecentIdpHost: { url?: string; tabId?: number } = {};
  private currentAutoSubmitHostData: { url?: string; tabId?: number } = {};
  private readonly isSafariBrowser: boolean = false;
  private readonly extensionMessageHandlers: AutoSubmitLoginBackgroundExtensionMessageHandlers = {
    automatedLoginStepReady: ({ sender }) => this.reportAutomatedLoginStepReady(sender),
    multiStepAutoSubmitLoginComplete: ({ sender }) =>
      this.handleMultiStepAutoSubmitLoginComplete(sender),
  };

  constructor(
    private logService: LogService,
    private autofillLifecycleService: AutofillLifecycleService,
    private scriptInjectorService: ScriptInjectorService,
    private autofillAccountsService: AutofillAccountsService,
    private platformUtilsService: PlatformUtilsService,
    private policyService: PolicyService,
  ) {
    this.isSafariBrowser = this.platformUtilsService.isSafari();
  }

  /**
   * Initializes the auto-submit login policy of every account autofill serves. An account whose
   * policy is not enabled has its approval removed; when no account approves a host, the
   * established listeners are removed.
   */

  async init() {
    this.autofillAccountsService.autofillUserIds$
      .pipe(
        switchMap((userIds) =>
          merge(
            ...userIds.map((userId) =>
              this.policyService.policiesByType$(PolicyType.AutomaticAppLogIn, userId).pipe(
                getFirstPolicy,
                filter((policy): policy is Policy => policy !== undefined),
                map((policy) => ({ policy, userId })),
              ),
            ),
          ),
        ),
      )
      .subscribe(({ policy, userId }) =>
        this.handleAutoSubmitLoginPolicySubscription(policy, userId),
      );
  }

  /**
   * Handles changes to an account's AutomaticAppLogIn policy. If the policy is not enabled,
   * the account's approval is removed. If the policy is enabled, apply the policy to the account.
   *
   * @param policy - The AutomaticAppLogIn policy details.
   * @param userId - The account the policy was read for.
   */
  private handleAutoSubmitLoginPolicySubscription = (policy: Policy, userId: UserId) => {
    if (!policy?.enabled) {
      this.revokePolicy(userId);
      return;
    }

    this.applyPolicyToUser(policy, userId).catch((error) => this.logService.error(error));
  };

  /**
   * Verifies if the policy applies to the account. If so, the event listeners
   * used to trigger auto-submission of login forms will be established.
   *
   * @param policy - The AutomaticAppLogIn policy details.
   * @param userId - The account the policy was read for.
   */
  private applyPolicyToUser = async (policy: Policy, userId: UserId) => {
    const policyAppliesToUser = await firstValueFrom(
      this.policyService.policyAppliesToUser$(PolicyType.AutomaticAppLogIn, userId),
    );

    if (!policyAppliesToUser) {
      this.revokePolicy(userId);
      return;
    }

    await this.setupAutoSubmitLoginListeners(policy, userId);
  };

  /**
   * Removes an account's approved IdP hosts. Tears the listeners down when no account approves
   * a host any more.
   *
   * @param userId - The account whose policy no longer approves any host.
   */
  private revokePolicy(userId: UserId) {
    this.validIdpHosts.delete(userId);
    if (!this.validIdpHosts.size) {
      this.destroy();
    }
  }

  /**
   * Sets up the event listeners used to trigger auto-submission of login forms.
   *
   * @param policy - The AutomaticAppLogIn policy details.
   * @param userId - The account the policy applies to.
   */
  private setupAutoSubmitLoginListeners = async (policy: Policy, userId: UserId) => {
    this.parseIpdHostsFromPolicy(policy?.data.idpHost, userId);
    if (!this.validIdpHosts.get(userId)?.size) {
      this.revokePolicy(userId);
      return;
    }

    BrowserApi.addListener(chrome.runtime.onMessage, this.handleExtensionMessage);
    chrome.webRequest.onBeforeRequest.addListener(this.handleOnBeforeRequest, {
      urls: ["<all_urls>"],
      types: ["main_frame", "sub_frame"],
    });
    chrome.webRequest.onBeforeRedirect.addListener(this.handleWebRequestOnBeforeRedirect, {
      urls: ["<all_urls>"],
      types: ["main_frame", "sub_frame"],
    });

    if (this.isSafariBrowser) {
      this.initSafari().catch((error) => this.logService.error(error));
    }
  };

  /**
   * Parses the comma-separated list of IDP hosts from an account's AutomaticAppLogIn policy.
   *
   * @param idpHost - The comma-separated list of IDP hosts.
   * @param userId - The account whose policy approves the hosts.
   */
  private parseIpdHostsFromPolicy = (idpHost: string | undefined, userId: UserId) => {
    if (!idpHost) {
      return;
    }

    const hosts = this.validIdpHosts.get(userId) ?? new Set<string>();
    const urls = idpHost.split(",");
    urls.forEach((url) => {
      const host = this.getUrlHost(url?.trim());
      if (host) {
        hosts.add(host);
      }
    });
    if (hosts.size) {
      this.validIdpHosts.set(userId, hosts);
    }
  };

  /**
   * Handles the onBeforeRequest event. This event is used to determine if a request should initialize
   * the auto-submit login workflow. A valid request will initialize the workflow, while an invalid
   * request will clear and disable the workflow.
   *
   * @param details - The details of the request.
   */
  private handleOnBeforeRequest = (
    details: chrome.webRequest.OnBeforeRequestDetails,
  ): undefined => {
    const requestInitiator = this.getRequestInitiator(details);
    if (!requestInitiator && this.validAutoSubmitHosts.size === 0) {
      return;
    }

    const isValidInitiator = requestInitiator ? this.isValidInitiator(requestInitiator) : false;

    if (
      this.postRequestEncounteredAfterSubmission(details, isValidInitiator) ||
      this.requestRedirectsToInvalidHost(details, isValidInitiator)
    ) {
      this.clearAutoSubmitHostData();
      return;
    }

    if (
      requestInitiator &&
      isValidInitiator &&
      this.shouldRouteTriggerAutoSubmit(details, requestInitiator)
    ) {
      this.setupAutoSubmitFlow(details, requestInitiator);
      return;
    }

    if (requestInitiator || this.validAutoSubmitHosts.size > 0) {
      this.disableAutoSubmitFlow(requestInitiator || "", details).catch((error) =>
        this.logService.error(error),
      );
    }
  };

  /**
   * This triggers if the upcoming request is a POST request and the initiator is valid. It indicates
   * that a submission has occurred and the auto-submit login workflow should be cleared.
   *
   * @param details - The details of the request.
   * @param isValidInitiator - A flag indicating if the initiator of the request is valid.
   */
  private postRequestEncounteredAfterSubmission = (
    details: chrome.webRequest.OnBeforeRequestDetails,
    isValidInitiator: boolean,
  ) => {
    return details.method === "POST" && this.validAutoSubmitHosts.size > 0 && isValidInitiator;
  };

  /**
   * Determines if a request is attempting to redirect to an invalid host. We identify this as a case
   * where the top level frame has navigated to either an invalid IDP host or auto-submit host.
   *
   * @param details - The details of the request.
   * @param isValidInitiator - A flag indicating if the initiator of the request is valid.
   */
  private requestRedirectsToInvalidHost = (
    details: chrome.webRequest.OnBeforeRequestDetails,
    isValidInitiator: boolean,
  ) => {
    return (
      this.validAutoSubmitHosts.size > 0 &&
      this.isRequestInMainFrame(details) &&
      (!isValidInitiator || !this.isValidAutoSubmitHost(details.url))
    );
  };

  /**
   * Initializes the auto-submit flow for the given request, and adds the routed-to URL
   *  to the list of valid auto-submit hosts, approved by the accounts that approve the initiator.
   *
   * @param details - The details of the request.
   * @param initiator - The valid initiator of the request.
   */
  private setupAutoSubmitFlow = (
    details: chrome.webRequest.OnBeforeRequestDetails,
    initiator: string,
  ) => {
    if (this.isRequestInMainFrame(details)) {
      this.currentAutoSubmitHostData = {
        url: details.url,
        tabId: details.tabId,
      };
    }

    const autoSubmitHost = this.getUrlHost(details.url);
    this.validAutoSubmitHosts.set(autoSubmitHost, this.approversOf(initiator));
    chrome.webNavigation.onCompleted.removeListener(this.handleAutoSubmitHostNavigationCompleted);
    chrome.webNavigation.onCompleted.addListener(this.handleAutoSubmitHostNavigationCompleted, {
      url: [{ hostEquals: autoSubmitHost }],
    });
  };

  /**
   * Triggers the injection of the auto-submit login content script once the page has completely loaded.
   *
   * @param details - The details of the navigation event.
   */
  private handleAutoSubmitHostNavigationCompleted = (
    details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
  ) => {
    if (
      details.tabId === this.currentAutoSubmitHostData.tabId &&
      this.urlContainsAutoSubmitHash(details.url)
    ) {
      this.injectAutoSubmitLoginScript(details.tabId).catch((error) =>
        this.logService.error(error),
      );
      chrome.webNavigation.onCompleted.removeListener(this.handleAutoSubmitHostNavigationCompleted);
    }
  };

  /**
   * Triggers the injection of the auto-submit login script if autofill serves an account, which
   * is then unlocked.
   *
   * @param tabId - The ID of the tab to inject the script into.
   */
  private injectAutoSubmitLoginScript = async (tabId: number) => {
    const autofillUserIds = await firstValueFrom(this.autofillAccountsService.autofillUserIds$);
    if (autofillUserIds.length > 0) {
      await this.scriptInjectorService.inject({
        tabId: tabId,
        injectDetails: {
          file: "content/auto-submit-login.js",
          runAt: "document_start",
          frame: "all_frames",
        },
      });
    }
  };

  /**
   * Promotes hosts from a redirect chain into validAutoSubmitHosts. The initiator check
   * prevents any origin from 302'ing to `target#autosubmit=1` to force autofill there.
   *
   * @param details - The details of the request.
   */
  private handleWebRequestOnBeforeRedirect = (
    details: chrome.webRequest.OnBeforeRedirectDetails,
  ) => {
    // Hash check runs first so unrelated redirects short-circuit
    // silently and don't accumulate performance timeline marks.
    if (!this.urlContainsAutoSubmitHash(details.redirectUrl)) {
      return;
    }
    if (!this.isRequestInMainFrame(details)) {
      this.logService.mark("[AutoSubmitLogin] Redirect skipped: not main frame");
      return;
    }
    if (!this.isValidInitiator(details.url)) {
      this.logService.mark("[AutoSubmitLogin] Redirect skipped: untrusted initiator");
      return;
    }

    // The redirect target is approved by the accounts that approve the host redirecting to it.
    const approvers = this.approversOf(details.url);
    this.validAutoSubmitHosts.set(this.getUrlHost(details.redirectUrl), approvers);
    this.validAutoSubmitHosts.set(this.getUrlHost(details.url), approvers);
  };

  /**
   * Determines if the provided URL is a valid initiator for the auto-submit login feature.
   *
   * @param url - The URL to validate as an initiator.
   */
  private isValidInitiator = (url: string) => {
    return this.isValidIdpHost(url) || this.isValidAutoSubmitHost(url);
  };

  /**
   * Determines if the provided URL is a valid IDP host.
   *
   * @param url - The URL to validate as an IDP host.
   */
  private isValidIdpHost = (url: string) => {
    const host = this.getUrlHost(url);
    if (!host) {
      return false;
    }

    return [...this.validIdpHosts.values()].some((hosts) => hosts.has(host));
  };

  /**
   * The accounts that approve a workflow initiated from the provided URL: those whose policy
   * lists its host as an IdP host, and those that approved the workflow it is already part of.
   *
   * @param url - The URL of a valid initiator.
   */
  private approversOf = (url: string): Set<UserId> => {
    const host = this.getUrlHost(url);
    const approvers = new Set<UserId>(this.validAutoSubmitHosts.get(host));
    for (const [userId, hosts] of this.validIdpHosts) {
      if (hosts.has(host)) {
        approvers.add(userId);
      }
    }
    return approvers;
  };

  /**
   * Determines if the provided URL is a valid auto-submit host.
   *
   * @param url - The URL to validate as an auto-submit host.
   */
  private isValidAutoSubmitHost = (url: string) => {
    const host = this.getUrlHost(url);
    if (!host) {
      return false;
    }

    return this.validAutoSubmitHosts.has(host);
  };

  /**
   * Retires the completed flow's host and reports the completion to the lifecycle.
   * A completed flow is not a cancellation, so this reports a completion rather than
   * an invalidation.
   *
   * @param url - The URL whose host completed its workflow.
   * @param tabId - The tab the workflow ran on.
   */
  private completeAutoSubmitFlow = (url: string, tabId: number | undefined) => {
    const host = this.getUrlHost(url);
    this.validAutoSubmitHosts.delete(host);
    this.autofillLifecycleService.reportAutoSubmitFlowComplete(tabId, host);
  };

  /**
   * Retires a single host from the active workflow and reports the retirement to
   * the lifecycle.
   *
   * @param url - The URL whose host should be invalidated.
   * @param tabId - The tab whose workflow the host belonged to.
   */
  private invalidateAutoSubmitHost = (url: string, tabId: number | undefined) => {
    const host = this.getUrlHost(url);
    if (this.validAutoSubmitHosts.delete(host)) {
      this.autofillLifecycleService.reportAutoSubmitInvalidated(tabId, host);
    }
  };

  /**
   * Tears down the whole workflow, clearing every valid auto-submit host at once.
   * When there was at least one valid auto-submit host, the cancellation is also
   * reported to the lifecycle.
   *
   * @param tabId - The tab whose workflow the hosts belonged to.
   */
  private cancelAutoSubmitFlow = (tabId: number | undefined) => {
    const hadHosts = this.validAutoSubmitHosts.size > 0;
    this.validAutoSubmitHosts.clear();
    if (hadHosts) {
      this.autofillLifecycleService.reportAutoSubmitInvalidated(tabId);
    }
  };

  /**
   * Disables an active auto-submit login workflow. This triggers when a request is made that should
   * not trigger auto-submit. If the initiator of the request is a valid auto-submit host, we need to
   * treat this request as a navigation within the current website, but away from the intended
   * auto-submit route. If that isn't the case, we capture the tab's details and check if an
   * internal navigation is occurring. If so, we invalidate that host.
   *
   * @param requestInitiator - The initiator of the request.
   * @param details - The details of the request.
   */
  private disableAutoSubmitFlow = async (
    requestInitiator: string,
    details: chrome.webRequest.OnBeforeRequestDetails,
  ) => {
    if (this.isValidAutoSubmitHost(requestInitiator)) {
      this.invalidateAutoSubmitHost(requestInitiator, details.tabId);
      return;
    }

    if (details.tabId < 0) {
      return;
    }

    const tab = await BrowserApi.getTab(details.tabId);
    const tabUrl = tab?.url;
    if (tabUrl && this.isValidAutoSubmitHost(tabUrl)) {
      this.invalidateAutoSubmitHost(tabUrl, details.tabId);
    }
  };

  /**
   * Clears all data associated with the current auto-submit host workflow, reporting
   * the host retirement through the single authoritative invalidation path.
   */
  private clearAutoSubmitHostData = () => {
    this.cancelAutoSubmitFlow(this.currentAutoSubmitHostData.tabId);
    this.currentAutoSubmitHostData = {};
    this.mostRecentIdpHost = {};
  };

  /**
   * Determines if the provided URL is a valid auto-submit host. If the request is occurring
   * in the main frame, we will check for the presence of the `autosubmit=1` uri hash.
   * If the request is occurring in a sub frame, the main frame URL should be set as a
   * valid auto-submit host and can be used to validate the request.
   *
   * @param details - The details of the request.
   * @param initiator - The initiator of the request.
   */
  private shouldRouteTriggerAutoSubmit = (
    details: chrome.webRequest.OnBeforeRequestDetails,
    initiator: string,
  ) => {
    if (this.isRequestInMainFrame(details)) {
      return !!(
        this.urlContainsAutoSubmitHash(details.url) ||
        this.triggerAutoSubmitAfterRedirectOnSafari(details.url)
      );
    }

    return this.isValidAutoSubmitHost(initiator);
  };

  /**
   * Determines if the provided URL contains the `autosubmit=1` uri hash.
   *
   * @param url - The URL to check for the `autosubmit=1` uri hash.
   */
  private urlContainsAutoSubmitHash = (url: string) => {
    try {
      const urlObj = new URL(url);
      return urlObj.hash.indexOf("autosubmit=1") !== -1;
    } catch {
      return false;
    }
  };

  /**
   * Extracts the host from a given URL.
   * Will return an empty string if the provided URL is invalid.
   *
   * @param url - The URL to extract the host from.
   */
  private getUrlHost = (url: string) => {
    let parsedUrl = url;
    if (!parsedUrl || typeof parsedUrl !== "string") {
      return "";
    }

    if (!parsedUrl.startsWith("http")) {
      parsedUrl = `https://${parsedUrl}`;
    }

    try {
      const urlObj = new URL(parsedUrl);
      return urlObj.host;
    } catch {
      return "";
    }
  };

  /**
   * Determines the initiator of a request. If the request is happening in a Safari browser, we
   * need to determine the initiator based on the stored most recently visited IDP host. When
   * handling a sub frame request in Safari, we treat the passed URL detail as the initiator
   * of the request, as long as an IPD host has been previously identified.
   *
   * @param details - The details of the request.
   */
  private getRequestInitiator = (details: chrome.webRequest.OnBeforeRequestDetails) => {
    if (!this.isSafariBrowser) {
      return details.initiator || (details as browser.webRequest._OnBeforeRequestDetails).originUrl;
    }

    if (this.isRequestInMainFrame(details)) {
      return this.mostRecentIdpHost.url;
    }

    if (!this.mostRecentIdpHost.url) {
      return "";
    }

    return details.url;
  };

  /**
   * Verifies if a request is occurring in the main / top-level frame of a tab.
   *
   * @param details - The details of the request.
   */
  private isRequestInMainFrame = (
    details: SetPartial<
      chrome.webRequest.WebRequestDetails,
      "documentId" | "documentLifecycle" | "frameType"
    >,
  ) => {
    if (this.isSafariBrowser) {
      return details.frameId === 0;
    }

    return details.type === "main_frame";
  };

  /**
   * Reports the sender frame's auto-submit-login step-ready fact to the autofill
   * lifecycle, with the accounts whose policy approved the workflow on the frame's host.
   *
   * @param sender - The message sender. This should be the frame running the auto-submit workflow.
   */
  private reportAutomatedLoginStepReady = (sender: chrome.runtime.MessageSender) => {
    if (sender.frameId == null || !sender.tab) {
      return;
    }

    const approvers = this.validAutoSubmitHosts.get(this.getUrlHost(sender.url ?? ""));
    this.autofillLifecycleService.reportAutomatedLoginStepReady(
      sender.tab,
      sender.frameId,
      sender.url,
      AutomationWorkflow.autoSubmitLogin,
      [...(approvers ?? [])],
    );
  };

  /**
   * Handles the completion of an auto-submit login workflow on a multistep form.
   *
   * @param sender - The message sender.
   */
  private handleMultiStepAutoSubmitLoginComplete = (sender: chrome.runtime.MessageSender) => {
    if (!sender.url) {
      return;
    }

    this.completeAutoSubmitFlow(sender.url, sender.tab?.id);
  };

  /**
   * Initializes several fallback event listeners for the auto-submit login feature on the Safari browser.
   * This is required due to limitations that Safari has with the `webRequest` API. Specifically, Safari
   * does not provide the `initiator` of a request, which is required to determine if a request is coming
   * from a valid IDP host.
   */
  private async initSafari() {
    const currentTab = await BrowserApi.getTabFromCurrentWindow();
    if (currentTab?.url && currentTab.id != null && currentTab.id >= 0) {
      this.setMostRecentIdpHost(currentTab.url, currentTab.id);
    }

    chrome.tabs.onActivated.addListener(this.handleSafariTabOnActivated);
    chrome.tabs.onUpdated.addListener(this.handleSafariTabOnUpdated);
    chrome.webNavigation.onCompleted.addListener(this.handleSafariWebNavigationOnCompleted);
  }

  /**
   * Sets the most recent IDP host based on the provided URL and tab ID.
   *
   * @param url - The URL to set as the most recent IDP host.
   * @param tabId - The tab ID associated with the URL.
   */
  private setMostRecentIdpHost(url: string, tabId: number) {
    if (this.isValidIdpHost(url)) {
      this.mostRecentIdpHost = { url, tabId };
    }
  }

  /**
   * Triggers an update of the most recently visited IDP host when a user focuses a different tab.
   *
   * @param activeInfo - The active tab information.
   */
  private handleSafariTabOnActivated = async (activeInfo: chrome.tabs.OnActivatedInfo) => {
    if (activeInfo.tabId < 0) {
      return;
    }

    const tab = await BrowserApi.getTab(activeInfo.tabId);
    if (tab?.url && tab.id != null && tab.id >= 0) {
      this.setMostRecentIdpHost(tab.url, tab.id);
    }
  };

  /**
   * Triggers an update of the most recently visited IDP host when the URL of a tab is updated.
   *
   * @param tabId - The tab ID associated with the URL.
   * @param changeInfo - The change information of the tab.
   */
  private handleSafariTabOnUpdated = (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
    if (changeInfo.url) {
      this.setMostRecentIdpHost(changeInfo.url, tabId);
    }
  };

  /**
   * Handles the completion of a web navigation event on the Safari browser. If the navigation event
   * is for the main frame and the URL is a valid IDP host, the most recent IDP host will be updated.
   *
   * @param details - The web navigation details.
   */
  private handleSafariWebNavigationOnCompleted = (
    details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
  ) => {
    if (details.frameId === 0 && this.isValidIdpHost(details.url)) {
      // A fresh SSO navigation cancels the autosubmit workflow. Prefer the active
      // flow's tab, falling back to the navigating tab when no main-frame flow was
      // recorded (e.g. hosts populated via the redirect path).
      this.cancelAutoSubmitFlow(this.currentAutoSubmitHostData.tabId ?? details.tabId);
      this.mostRecentIdpHost = {
        url: details.url,
        tabId: details.tabId,
      };
      chrome.tabs.onRemoved.addListener(this.handleSafariTabOnRemoved);
    }
  };

  /**
   * Handles the removal of a tab on the Safari browser. If the tab being removed is the current
   * auto-submit host tab, all data associated with the current auto-submit workflow will be cleared.
   *
   * @param tabId - The tab ID of the tab being removed.
   */
  private handleSafariTabOnRemoved = (tabId: number) => {
    if (this.currentAutoSubmitHostData.tabId === tabId) {
      this.clearAutoSubmitHostData();
      chrome.tabs.onRemoved.removeListener(this.handleSafariTabOnRemoved);
    }
  };

  /**
   * Determines if the auto-submit login feature should be triggered after a redirect on the Safari browser.
   * This is required because Safari does not provide query params for the URL that is being routed to within
   * the onBefore request listener.
   *
   * @param url - The URL of the redirect.
   */
  private triggerAutoSubmitAfterRedirectOnSafari = (url: string) => {
    return this.isSafariBrowser && this.isValidAutoSubmitHost(url);
  };

  /**
   * Handles incoming messages from the extension. The message is only listened to if it comes from
   * the current auto-submit workflow tab and the URL is a valid auto-submit host.
   *
   * @param message - The incoming message.
   * @param sender - The message sender.
   * @param sendResponse - The response callback.
   */
  private handleExtensionMessage = (
    message: AutoSubmitLoginMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ) => {
    const { tab, url } = sender;
    if (
      !url ||
      tab?.id !== this.currentAutoSubmitHostData.tabId ||
      !this.isValidAutoSubmitHost(url)
    ) {
      return null;
    }

    const handler: CallableFunction | undefined = this.extensionMessageHandlers[message?.command];
    if (!handler) {
      return null;
    }

    const messageResponse = handler({ message, sender });
    if (typeof messageResponse === "undefined") {
      return null;
    }

    Promise.resolve(messageResponse)
      .then((response) => sendResponse(response))
      .catch((error) => this.logService.error(error));
    return true;
  };

  /**
   * Tears down all established event listeners for the auto-submit login feature.
   */
  private destroy() {
    BrowserApi.removeListener(chrome.runtime.onMessage, this.handleExtensionMessage);
    chrome.webRequest.onBeforeRequest.removeListener(this.handleOnBeforeRequest);
    chrome.webRequest.onBeforeRedirect.removeListener(this.handleWebRequestOnBeforeRedirect);
    chrome.webNavigation.onCompleted.removeListener(this.handleAutoSubmitHostNavigationCompleted);
    chrome.webNavigation.onCompleted.removeListener(this.handleSafariWebNavigationOnCompleted);
    chrome.tabs.onActivated.removeListener(this.handleSafariTabOnActivated);
    chrome.tabs.onUpdated.removeListener(this.handleSafariTabOnUpdated);
    chrome.tabs.onRemoved.removeListener(this.handleSafariTabOnRemoved);
  }
}
