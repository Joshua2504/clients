import {
  catchError,
  combineLatest,
  distinctUntilChanged,
  firstValueFrom,
  map,
  Observable,
  of,
  Subscription,
  switchMap,
} from "rxjs";

import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { AutofillSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/autofill-settings.service";
import {
  hasOptedInToHTTPAuthentication,
  isEligibleForHTTPAuthentication,
} from "@bitwarden/common/autofill/utils/http-authentication-eligibility";
import { EventCollectionService, EventType } from "@bitwarden/common/dirt/event-logs";
import { UriMatchStrategy } from "@bitwarden/common/models/domain/domain-service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { devFlagEnabled } from "@bitwarden/common/platform/misc/flags";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { CipherUse } from "../services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../services/abstractions/multi-account-fill-cipher-policy";

const webRequestUrlFilter: chrome.webRequest.RequestFilter = {
  urls: ["http://*/*", "https://*/*"],
};

/**
 * Authentication schemes answered from the vault.
 *
 * `ntlm` and `negotiate` are excluded. They negotiate with operating system
 * credentials over a multi-message handshake rather than submitting a single
 * username and password, so answering them with a vault item hands the
 * challenger material the scheme was never meant to carry.
 */
const ANSWERABLE_AUTH_SCHEMES: ReadonlySet<string> = new Set(["basic", "digest"]);

/**
 * Non-navigation request types answered from the vault, and then only when the
 * requesting page is the same origin as the challenger.
 *
 * Credentials are cached per protection space and sent preemptively once a
 * space has been authenticated, so a page's own assets do not raise a second
 * challenge. A passive asset such as an image or a stylesheet therefore only
 * reaches this code when it sits in a realm nothing has authenticated yet,
 * which no expected deployment produces.
 */
const ANSWERABLE_SUBRESOURCE_TYPES: ReadonlySet<string> = new Set<string>([
  // Empty, so that a credential is released only for a page the user navigated
  // to. A subresource request is issued without the user acting, and restricting
  // it to the same origin bounds who receives the credential without making the
  // release visible to anyone.
  //
  // `xmlhttprequest` and `sub_frame` are the candidates for this list. Both can
  // raise a genuine first challenge, because Basic auth protection spaces are
  // path-scoped and a page's own assets are otherwise covered by the credentials
  // the browser already caches and sends preemptively.
  // FIXME reconsider the case for these inclusions
  // "xmlhttprequest",
  // "sub_frame",
]);

const DEFAULT_PORT_BY_PROTOCOL: Record<string, number> = {
  "http:": 80,
  "https:": 443,
};

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** `URL.hostname` brackets IPv6 literals while `challenger.host` does not. */
function normalizeHost(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

function challengerIsRequestHost(
  challenger: chrome.webRequest.OnAuthRequiredDetails["challenger"],
  requestUrl: URL,
): boolean {
  if (challenger?.host == null) {
    return false;
  }

  if (normalizeHost(challenger.host) !== normalizeHost(requestUrl.hostname)) {
    return false;
  }

  // The port is compared only when the browser reports a usable one. Firefox
  // reports -1 rather than the scheme's default port, so treating an
  // unreadable value as a mismatch would reject challenges whose host already
  // matches. Proxy challenges, the case this comparison exists to catch, are
  // rejected by `isProxy` before reaching here.
  const challengerPort = Number(challenger.port);
  if (!Number.isInteger(challengerPort) || challengerPort <= 0) {
    return true;
  }

  const requestPort =
    requestUrl.port === ""
      ? DEFAULT_PORT_BY_PROTOCOL[requestUrl.protocol]
      : Number(requestUrl.port);

  return challengerPort === requestPort;
}

/** Fields Firefox supplies on this event that the Chrome typings do not describe. */
interface FirefoxAuthRequiredDetails {
  originUrl?: string;
  documentUrl?: string;
}

/**
 * The origin of the context that issued the request, or null when the browser
 * did not report one.
 *
 * Chrome supplies a bare origin in `initiator`. Firefox instead supplies the
 * full URL of the initiating document in `originUrl`, with `documentUrl` naming
 * the document the resource loads into.
 */
export function getInitiatorOrigin(
  details: chrome.webRequest.OnAuthRequiredDetails,
): string | null {
  const firefoxDetails = details as FirefoxAuthRequiredDetails;
  const initiator = details.initiator ?? firefoxDetails.originUrl ?? firefoxDetails.documentUrl;

  // An opaque initiator serializes as the string "null" and cannot be compared.
  if (initiator == null || initiator === "null") {
    return null;
  }

  return parseUrl(initiator)?.origin ?? null;
}

/**
 * A page can reference any URL as a subresource, and those requests are
 * issued without user action. Only a page the user navigated to or same-origin
 * `ANSWERABLE_SUBRESOURCE_TYPES` are answered.
 */
function isTopLevelNavigationOrSameOriginSubresource(
  details: chrome.webRequest.OnAuthRequiredDetails,
  requestUrl: URL,
): boolean {
  if (details.type === "main_frame") {
    return true;
  }

  if (!ANSWERABLE_SUBRESOURCE_TYPES.has(details.type)) {
    return false;
  }

  return getInitiatorOrigin(details) === requestUrl.origin;
}

/**
 * Decides whether a challenge is one the extension answers from the vault.
 *
 * Every branch fails closed, so a challenge that cannot be attributed with
 * confidence is left for the browser to handle.
 *
 * Note: The narrowness of the response conditions is predicated on the challenge
 * answer happening silently/automatically; deferring to the native experience
 * (e.g. credential entry prompt) in ambiguous cases.
 */
export function shouldAnswerAuthChallenge(
  details: chrome.webRequest.OnAuthRequiredDetails,
): boolean {
  // Note, we do not constrain by the lack of SSL. Responding to insecure
  // HTTP auth challenges carries inherent risk in the response transport.
  // However, this is a common usecase for local networks.
  // FIXME We should consider if this case needs a different UX

  // On a 407 the challenge comes from the proxy while `url` stays the
  // destination, so a credential matched against the destination would be
  // delivered to whoever is proxying the connection.
  if (details.isProxy) {
    return false;
  }

  const scheme = details.scheme?.toLowerCase() ?? "";
  if (!ANSWERABLE_AUTH_SCHEMES.has(scheme)) {
    return false;
  }

  // A request with no owning tab is not something the user is looking at.
  if (details.tabId == null || details.tabId < 0) {
    return false;
  }

  const requestUrl = parseUrl(details.url);
  if (requestUrl == null) {
    return false;
  }

  // The credential is matched against the request URL, so the party issuing the
  // challenge has to be that same host.
  if (!challengerIsRequestHost(details.challenger, requestUrl)) {
    return false;
  }

  return isTopLevelNavigationOrSameOriginSubresource(details, requestUrl);
}

/** The settings that let a login of one account answer an HTTP auth challenge. */
interface HTTPAuthenticationResponseSettings {
  /** The user's global setting is on, so every eligible login may answer. */
  globalSettingEnabled: boolean;
  /** Eligible logins with HTTP authentication turned on in their own settings may answer. */
  loginSettingEnabled: boolean;
}

const NO_HTTP_AUTHENTICATION_RESPONSE_SETTINGS: HTTPAuthenticationResponseSettings = Object.freeze({
  globalSettingEnabled: false,
  loginSettingEnabled: false,
});

function anyHTTPAuthenticationResponseSettingEnabled(
  settings: HTTPAuthenticationResponseSettings,
): boolean {
  return settings.globalSettingEnabled || settings.loginSettingEnabled;
}

export default class WebRequestBackground {
  private pendingAuthRequests: Set<string> = new Set<string>([]);
  private isFirefox: boolean;
  private isSafari: boolean;
  private listenersRegistered = false;
  private responseSettingsSubscription?: Subscription;

  /**
   * The login-level setting is honored only in builds that show its cipher form controls, so a value
   * stored by another client has no effect where the user can't see or change it.
   */
  private readonly loginSettingHonored = devFlagEnabled("httpAuthenticationCipherControls");

  constructor(
    platformUtilsService: PlatformUtilsService,
    private fillCipherPolicy: MultiAccountFillCipherPolicy,
    private autofillAccountsService: AutofillAccountsService,
    private readonly webRequest: typeof chrome.webRequest,
    private autofillSettingsService: AutofillSettingsServiceAbstraction,
    private eventCollectionService: EventCollectionService,
    private logService: LogService,
  ) {
    this.isFirefox = platformUtilsService.isFirefox();
    this.isSafari = platformUtilsService.isSafari();
  }

  /**
   * Keeps the handler that answers HTTP auth challenges with a matching vault credential
   * registered only while an account autofill serves has its global setting on, or while logins
   * can turn HTTP authentication on in their own settings. Which logins may answer is checked
   * when a challenge arrives, for each login under the settings of its own account.
   *
   * While registered, `webRequest.onAuthRequired` fires for any request that receives a 401.
   */
  startListening() {
    // Safari does not dispatch `webRequest.onAuthRequired` for HTTP auth challenges,
    // nor support the `blocking`/`asyncBlocking` options needed to answer one, so no
    // listeners are registered there.
    if (this.isSafari) {
      return;
    }

    this.responseSettingsSubscription?.unsubscribe();
    this.responseSettingsSubscription = this.anyResponseSettingEnabled$().subscribe(
      (anyResponseSettingEnabled) => {
        if (anyResponseSettingEnabled) {
          this.registerListeners();
        } else {
          this.unregisterListeners();
        }
      },
    );
  }

  /**
   * Emits whether any account autofill serves has a setting on that lets a login answer an HTTP
   * auth challenge.
   *
   * Fails closed: no account to serve, or an error resolving a setting, emits `false`.
   */
  private anyResponseSettingEnabled$(): Observable<boolean> {
    // The settings are resolved inside a `switchMap` on the accounts so that an error is caught
    // for those accounts alone and the settings are resolved again on the next change of
    // accounts; catching downstream would end the subscription and leave the listeners
    // unregistered for the life of the background context.
    return this.autofillAccountsService.autofillUserIds$.pipe(
      switchMap((userIds) =>
        userIds.length === 0
          ? of(false)
          : combineLatest(userIds.map((userId) => this.responseSettings$(userId))).pipe(
              map((settings) => settings.some(anyHTTPAuthenticationResponseSettingEnabled)),
            ),
      ),
      catchError(() => of(false)),
      distinctUntilChanged(),
    );
  }

  /**
   * Emits the settings that let a login of `userId` answer an HTTP auth challenge: the account's
   * global setting, and whether the login-level setting is honored, which needs HTTP
   * authentication to be available and the login-level controls to be shown in this build.
   *
   * Fails closed: an error resolving either setting emits both as off.
   */
  private responseSettings$(userId: UserId): Observable<HTTPAuthenticationResponseSettings> {
    return combineLatest([
      this.autofillSettingsService.resolvedEnableBasicAuthResponseFor$(userId),
      this.loginSettingHonored
        ? this.autofillSettingsService.httpAuthenticationAvailable$
        : of(false),
    ]).pipe(
      map(([globalSettingEnabled, loginSettingEnabled]): HTTPAuthenticationResponseSettings => ({
        globalSettingEnabled: globalSettingEnabled === true,
        loginSettingEnabled: loginSettingEnabled === true,
      })),
      catchError(() => of(NO_HTTP_AUTHENTICATION_RESPONSE_SETTINGS)),
      distinctUntilChanged(
        (previous, current) =>
          previous.globalSettingEnabled === current.globalSettingEnabled &&
          previous.loginSettingEnabled === current.loginSettingEnabled,
      ),
    );
  }

  /**
   * The settings that let a login of `userId` answer an HTTP auth challenge. They are read for
   * that account by id, so a change of active account during the read cannot apply one
   * account's settings to another account's vault. An account that stops being one autofill
   * serves during the read has no setting on, and the read does not wait for it.
   *
   * Fails closed on error.
   */
  private async responseSettingsForUser(
    userId: UserId,
  ): Promise<HTTPAuthenticationResponseSettings> {
    try {
      return await firstValueFrom(
        this.autofillAccountsService
          .isAutofillUser$(userId)
          .pipe(
            switchMap((servesAutofill) =>
              servesAutofill
                ? this.responseSettings$(userId)
                : of(NO_HTTP_AUTHENTICATION_RESPONSE_SETTINGS),
            ),
          ),
      );
    } catch {
      return NO_HTTP_AUTHENTICATION_RESPONSE_SETTINGS;
    }
  }

  private registerListeners() {
    if (this.listenersRegistered) {
      return;
    }

    this.webRequest.onAuthRequired.addListener(
      this.handleAuthRequired as any,
      webRequestUrlFilter,
      [this.isFirefox ? "blocking" : "asyncBlocking"],
    );
    this.webRequest.onCompleted.addListener(this.completeAuthRequest, webRequestUrlFilter);
    this.webRequest.onErrorOccurred.addListener(this.completeAuthRequest, webRequestUrlFilter);

    this.listenersRegistered = true;
  }

  private unregisterListeners() {
    if (!this.listenersRegistered) {
      return;
    }

    this.webRequest.onAuthRequired.removeListener(this.handleAuthRequired as any);
    this.webRequest.onCompleted.removeListener(this.completeAuthRequest);
    this.webRequest.onErrorOccurred.removeListener(this.completeAuthRequest);
    this.pendingAuthRequests.clear();

    this.listenersRegistered = false;
  }

  /**
   * Answers an auth challenge on both listener contracts: Chrome's `asyncBlocking`
   * passes a callback, while Firefox, which does not support `asyncBlocking`,
   * passes none and reads the promise this returns under `blocking`.
   */
  private handleAuthRequired = async (
    details: chrome.webRequest.OnAuthRequiredDetails,
    callback?: (response: chrome.webRequest.BlockingResponse) => void,
  ): Promise<chrome.webRequest.BlockingResponse> => {
    const response = await this.getAuthChallengeResponse(details);

    if (callback) {
      callback(response);
    }

    return response;
  };

  /**
   * Resolves to the credentials of the single vault login that matches the request
   * URL and is eligible for HTTP authentication, or to an empty response that leaves
   * the challenge to the browser.
   *
   * The logins of every account autofill serves are candidates, each under the settings of its
   * own account. The answer is automatic and nobody chooses the login, so more than one
   * candidate leaves the challenge to the browser. That includes candidates from more than one
   * account, even when they are the same shared item.
   */
  private async getAuthChallengeResponse(
    details: chrome.webRequest.OnAuthRequiredDetails,
  ): Promise<chrome.webRequest.BlockingResponse> {
    if (
      !details.url ||
      this.pendingAuthRequests.has(details.requestId) ||
      !shouldAnswerAuthChallenge(details)
    ) {
      return {};
    }

    this.pendingAuthRequests.add(details.requestId);

    // The accounts autofill serves are unlocked. With none, there is no vault to answer from.
    const userIds = await firstValueFrom(this.autofillAccountsService.autofillUserIds$);

    if (userIds.length === 0) {
      return {};
    }

    // Listener removal trails the state it reacts to, so a challenge can arrive
    // after the accounts change to ones with no response setting enabled.
    const responseSettings = new Map<UserId, HTTPAuthenticationResponseSettings>();
    for (const userId of userIds) {
      responseSettings.set(userId, await this.responseSettingsForUser(userId));
    }

    if (![...responseSettings.values()].some(anyHTTPAuthenticationResponseSettingEnabled)) {
      return {};
    }

    try {
      // The Host strategy is only applied to URIs using "Default", and logins with any such URI are
      // removed by the eligibility filter below, so each remaining URI matched by its own strategy.
      // Host is still passed so that a "Default" URI is never matched more loosely. The filter also
      // removes logins with reprompt on, and, unless the global setting of their account is on,
      // logins without HTTP authentication turned on in their own settings, before the
      // single-match check.
      const ciphers = await this.fillCipherPolicy.ciphersForUrl(
        details.url,
        CipherUse.AutomaticFill,
        { defaultMatch: UriMatchStrategy.Host },
      );

      const eligibleCiphers = (ciphers ?? []).filter(({ userId, cipher }) => {
        const settings = responseSettings.get(userId) ?? NO_HTTP_AUTHENTICATION_RESPONSE_SETTINGS;
        return (
          isEligibleForHTTPAuthentication(cipher) &&
          (settings.globalSettingEnabled ||
            (settings.loginSettingEnabled && hasOptedInToHTTPAuthentication(cipher)))
        );
      });

      if (eligibleCiphers.length !== 1) {
        return {};
      }

      const { userId, cipher } = eligibleCiphers[0];
      const username = cipher.login?.username;
      const password = cipher.login?.password;

      if (username == null || password == null) {
        return {};
      }

      // The login's account must still be one autofill serves as its credential is released.
      if (!(await firstValueFrom(this.autofillAccountsService.isAutofillUser$(userId)))) {
        return {};
      }

      // The release is recorded before the credential leaves the extension.
      if (!(await this.recordCredentialRelease(cipher, userId))) {
        return {};
      }

      return {
        authCredentials: {
          username,
          password,
        },
      };
    } catch (error) {
      this.logService.error(error);
      return {};
    }
  }

  /**
   * Records the release of a cipher's credential to the event log of the account that owns the
   * cipher and resolves to whether the release may proceed.
   */
  private async recordCredentialRelease(cipher: CipherView, userId: UserId): Promise<boolean> {
    // Event logs are organization audit records, so personal vault ciphers are never
    // recorded and always proceed. An organization cipher whose release cannot be
    // recorded does not proceed.
    if (cipher.organizationId == null) {
      return true;
    }

    try {
      await this.eventCollectionService.collect(
        EventType.Cipher_ClientHttpAuthReleased,
        cipher.id,
        false,
        undefined,
        userId,
      );
      return true;
    } catch (error) {
      this.logService.error(
        "Declined an HTTP auth challenge because the credential release could not be recorded.",
        error,
      );
      return false;
    }
  }

  private completeAuthRequest = (details: chrome.webRequest.WebRequestDetails) => {
    this.pendingAuthRequests.delete(details.requestId);
  };
}
