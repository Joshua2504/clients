// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import {
  combineLatest,
  distinctUntilChanged,
  firstValueFrom,
  map,
  Observable,
  of,
  switchMap,
  shareReplay,
} from "rxjs";

import { PolicyService } from "../../admin-console/abstractions/policy/policy.service.abstraction";
import { PolicyType } from "../../admin-console/enums/policy-type.enum";
import { getFirstPolicy } from "../../admin-console/services/policy/default-policy.service";
import { AccountService } from "../../auth/abstractions/account.service";
import { AuthService } from "../../auth/abstractions/auth.service";
import { AuthenticationStatus } from "../../auth/enums/authentication-status";
import { getUserId } from "../../auth/services/account.service";
import { FeatureFlag } from "../../enums/feature-flag.enum";
import {
  NeverDomains,
  EquivalentDomains,
  UriMatchStrategySetting,
  UriMatchStrategy,
} from "../../models/domain/domain-service";
import { ConfigService } from "../../platform/abstractions/config/config.service";
import { EnvironmentService } from "../../platform/abstractions/environment.service";
import { Utils } from "../../platform/misc/utils";
import {
  DOMAIN_SETTINGS_DISK,
  ActiveUserState,
  GlobalState,
  KeyDefinition,
  StateProvider,
  UserKeyDefinition,
} from "../../platform/state";
import { UserId } from "../../types/guid";
import { DEFAULT_FILL_ASSIST_RULES_URL, LEGACY_DEFAULT_FILL_ASSIST_RULES_URLS } from "../constants";
import { FormContent, TargetingRulesByDomain } from "../types";
import { matchTargetingRulesForUrl } from "../utils/targeting-rules";

/**
 * Cache key for fill assist targeting rules. Compound so that two accounts on
 * the same server with different effective rules-feed URLs (e.g. one member of
 * an org with a custom policy, one without) get separate cache entries — no
 * cross-account bleed during account switch.
 */
function fillAssistRulesCacheKey(apiUrl: string, effectiveUrl: string): string {
  return `${apiUrl}::${effectiveUrl}`;
}

const SHOW_FAVICONS = new KeyDefinition(DOMAIN_SETTINGS_DISK, "showFavicons", {
  deserializer: (value: boolean) => value ?? true,
});

// Domain exclusion list for notifications
const NEVER_DOMAINS = new KeyDefinition(DOMAIN_SETTINGS_DISK, "neverDomains", {
  deserializer: (value: NeverDomains) => value ?? null,
});

// Domain exclusion list for content script injections
const BLOCKED_INTERACTIONS_URIS = new KeyDefinition(
  DOMAIN_SETTINGS_DISK,
  "blockedInteractionsUris",
  {
    deserializer: (value: NeverDomains) => value ?? {},
  },
);

const EQUIVALENT_DOMAINS = new UserKeyDefinition(DOMAIN_SETTINGS_DISK, "equivalentDomains", {
  deserializer: (value: EquivalentDomains) => value ?? null,
  clearOn: ["logout"],
});

const DEFAULT_URI_MATCH_STRATEGY = new UserKeyDefinition(
  DOMAIN_SETTINGS_DISK,
  "defaultUriMatchStrategy",
  {
    deserializer: (value: UriMatchStrategySetting) => value ?? UriMatchStrategy.Domain,
    clearOn: [],
  },
);

const SERVER_TARGETING_RULES = KeyDefinition.record<TargetingRulesByDomain, string>(
  DOMAIN_SETTINGS_DISK,
  "fillAssistTargetingRulesByServer",
  {
    deserializer: (value: TargetingRulesByDomain) => value ?? null,
  },
);

// Preserve null for pristine state so `resolvedEnableFillAssist$` can
// tell pristine from explicit false. `enableFillAssist$` still coalesces
// to false, so existing consumers see no change.
const ENABLE_FILL_ASSIST = new KeyDefinition<boolean | null>(
  DOMAIN_SETTINGS_DISK,
  "enableFillAssist",
  {
    deserializer: (value) => value ?? null,
  },
);

/**
 * The Domain Settings service; provides client settings state for "active client view" URI concerns
 */
export abstract class DomainSettingsService {
  /**
   * Indicates if the favicons for ciphers' URIs should be shown instead of a placeholder
   */
  showFavicons$: Observable<boolean>;
  setShowFavicons: (newValue: boolean) => Promise<void>;

  /**
   * User-specified URIs for which the client notifications should not appear
   */
  neverDomains$: Observable<NeverDomains>;
  setNeverDomains: (newValue: NeverDomains) => Promise<void>;

  /**
   * User-specified URIs for which client content script injections should not occur, and the state
   * of banner/notice visibility for those domains within the client
   */
  blockedInteractionsUris$: Observable<NeverDomains>;
  setBlockedInteractionsUris: (newValue: NeverDomains) => Promise<void>;

  /**
   * URIs which should be treated as equivalent to each other for various concerns (autofill, etc)
   */
  equivalentDomains$: Observable<EquivalentDomains>;
  /** {@link equivalentDomains$} for `userId` instead of the active user. */
  equivalentDomainsFor$: (userId: UserId) => Observable<EquivalentDomains>;
  setEquivalentDomains: (newValue: EquivalentDomains, userId: UserId) => Promise<void>;

  /**
   * User-specified default for URI-matching strategies (for example, when determining relevant
   * ciphers for an active browser tab). Can be overridden by cipher-specific settings.
   */
  defaultUriMatchStrategy$: Observable<UriMatchStrategySetting>;
  setDefaultUriMatchStrategy: (newValue: UriMatchStrategySetting) => Promise<void>;

  /**
   * Org policy value for default for URI-matching
   * strategies. Can be overridden by cipher-specific settings.
   */
  defaultUriMatchStrategyPolicy$: Observable<UriMatchStrategySetting>;

  /**
   * Resolved (concerning user setting, org policy, etc) default for URI-matching
   * strategies. Can be overridden by cipher-specific settings.
   */
  resolvedDefaultUriMatchStrategy$: Observable<UriMatchStrategySetting>;
  /**
   * {@link resolvedDefaultUriMatchStrategy$} for `userId` instead of the active user: that user's
   * setting, overridden by that user's org policy.
   */
  resolvedDefaultUriMatchStrategyFor$: (userId: UserId) => Observable<UriMatchStrategySetting>;

  /**
   * Helper function for the common resolution of a given URL against equivalent domains
   *
   * @param userId The user whose equivalent domains apply. Defaults to the active user.
   */
  getUrlEquivalentDomains: (url: string, userId?: UserId) => Observable<Set<string>>;

  /**
   * User-controlled setting for whether or not fill assist targeting rules
   * should be used. Bare setting state, distinguished from the resolved state
   * `resolvedEnableFillAssist$`
   */
  enableFillAssist$: Observable<boolean>;
  setEnableFillAssist: (newValue: boolean) => Promise<void>;

  /**
   * Org policy state for fill assist. Emits `null` when no policy applies to
   * the active account, or `{ rulesUrl?: string }` when one does — `rulesUrl`
   * is present only for a well-formed https URL. Any-org-applies-globally: if
   * any of the user's orgs has the policy enabled, it applies to the whole
   * account. See {@link resolvedEnableFillAssist$} for how this combines with
   * the user setting and feature flag.
   */
  fillAssistPolicy$: Observable<{ rulesUrl?: string } | null>;

  /**
   * The effective fill assist rules-feed URL, in priority order: org policy's
   * custom URL (if it differs from the Bitwarden default) → server config's
   * URL. Emits `undefined` when neither source supplies a URL. When defined,
   * always ends with a trailing slash.
   */
  effectiveFillAssistRulesUrl$: Observable<string | undefined>;

  /**
   * Resolved state for enabling fill assist, combining the feature flag, the
   * user setting, and the org policy with user-explicit-wins semantics: if the
   * user has explicitly set the toggle (true or false), their choice wins. If
   * the user has never touched the toggle ("pristine"), the org policy default
   * applies when active. Gated on the {@link FeatureFlag.FillAssistTargetingRules}
   * flag.
   */
  resolvedEnableFillAssist$: Observable<boolean>;

  /**
   * Observable of all cached autofill targeting rules, keyed by normalized URL
   */
  targetingRules$: Observable<TargetingRulesByDomain | null>;

  /**
   * Update the cached targeting rules. Pass `effectiveUrl` from the caller to
   * pin the write to a snapshot of the rules-feed URL, avoiding a re-resolve
   * that could disagree with the URL the caller actually fetched from.
   */
  setTargetingRules: (rules: TargetingRulesByDomain, effectiveUrl?: string) => Promise<void>;

  /**
   * Look up targeting rules for a given URL. Checks pathname-specific
   * rules first, then falls back to hostname-level forms.
   *
   * @returns `FormContent[]` with entries for targeted fill,
   *          `[]` (empty) if the URL is blocklisted (suppress autofill),
   *          `null` if no rules exist (fall through to heuristics)
   */
  getTargetingRulesForUrl: (url: string) => Promise<FormContent[] | null>;
}

/** The fill assist org policy as it applies to an account: `null` when none does. */
type FillAssistPolicy = { rulesUrl?: string } | null;

/**
 * The fill assist policy for accounts that are served together. One page is collected once for
 * all of them, so the stricter reading wins: the policy applies only when it applies to every
 * account, and its custom rules feed is used only when every account names the same one. Accounts
 * that disagree on the feed get the policy without a custom feed, which resolves to the server's.
 */
function fillAssistPolicyAcross(policies: FillAssistPolicy[]): FillAssistPolicy {
  if (policies.length === 0 || policies.some((policy) => policy == null)) {
    return null;
  }
  const rulesUrl = policies[0]?.rulesUrl;
  if (rulesUrl != null && policies.every((policy) => policy?.rulesUrl === rulesUrl)) {
    return { rulesUrl };
  }
  return {};
}

export class DefaultDomainSettingsService implements DomainSettingsService {
  private showFaviconsState: GlobalState<boolean>;
  readonly showFavicons$: Observable<boolean>;

  private neverDomainsState: GlobalState<NeverDomains>;
  readonly neverDomains$: Observable<NeverDomains>;

  private blockedInteractionsUrisState: GlobalState<NeverDomains>;
  readonly blockedInteractionsUris$: Observable<NeverDomains>;

  private equivalentDomainsState: ActiveUserState<EquivalentDomains>;
  readonly equivalentDomains$: Observable<EquivalentDomains>;

  private defaultUriMatchStrategyState: ActiveUserState<UriMatchStrategySetting>;
  readonly defaultUriMatchStrategy$: Observable<UriMatchStrategySetting>;

  readonly defaultUriMatchStrategyPolicy$: Observable<UriMatchStrategySetting>;

  readonly resolvedDefaultUriMatchStrategy$: Observable<UriMatchStrategySetting>;

  private enableFillAssistState: GlobalState<boolean | null>;
  readonly enableFillAssist$: Observable<boolean>;
  readonly fillAssistPolicy$: Observable<{ rulesUrl?: string } | null>;
  readonly effectiveFillAssistRulesUrl$: Observable<string | undefined>;
  readonly resolvedEnableFillAssist$: Observable<boolean>;

  readonly targetingRules$: Observable<TargetingRulesByDomain | null>;

  constructor(
    private stateProvider: StateProvider,
    private policyService: PolicyService,
    private accountService: AccountService,
    private configService: ConfigService,
    private environmentService: EnvironmentService,
    private authService: AuthService,
    /**
     * The accounts whose vaults are served together on a page, in order of precedence. Fill
     * assist is one behaviour for all of them, so its organization policy is resolved across
     * them (see {@link fillAssistPolicyAcross}) and an unlocked one of them suffices for
     * {@link getTargetingRulesForUrl}. While it is absent or emits none, the active account
     * alone decides.
     */
    private servedUserIds$?: Observable<UserId[]>,
  ) {
    this.showFaviconsState = this.stateProvider.getGlobal(SHOW_FAVICONS);
    this.showFavicons$ = this.showFaviconsState.state$.pipe(map((x) => x ?? true));

    this.neverDomainsState = this.stateProvider.getGlobal(NEVER_DOMAINS);
    this.neverDomains$ = this.neverDomainsState.state$.pipe(map((x) => x ?? null));

    // Needs to be global to prevent pre-login injections
    this.blockedInteractionsUrisState = this.stateProvider.getGlobal(BLOCKED_INTERACTIONS_URIS);
    this.blockedInteractionsUris$ = this.blockedInteractionsUrisState.state$.pipe(
      map((x) => x ?? ({} as NeverDomains)),
    );

    this.equivalentDomainsState = this.stateProvider.getActive(EQUIVALENT_DOMAINS);
    this.equivalentDomains$ = this.equivalentDomainsState.state$.pipe(map((x) => x ?? null));

    this.defaultUriMatchStrategyState = this.stateProvider.getActive(DEFAULT_URI_MATCH_STRATEGY);
    this.defaultUriMatchStrategy$ = this.defaultUriMatchStrategyState.state$.pipe(
      map((x) => x ?? UriMatchStrategy.Domain),
    );

    this.enableFillAssistState = this.stateProvider.getGlobal(ENABLE_FILL_ASSIST);
    this.enableFillAssist$ = this.enableFillAssistState.state$.pipe(map((x) => x ?? false));

    this.fillAssistPolicy$ = this.fillAssistUserIds$().pipe(
      switchMap((userIds) =>
        userIds.length === 0
          ? // Logged-out or transient no-account state: no policy applies.
            of<FillAssistPolicy[]>([])
          : combineLatest(userIds.map((userId) => this.fillAssistPolicyFor$(userId))),
      ),
      map((policies) => fillAssistPolicyAcross(policies)),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    this.effectiveFillAssistRulesUrl$ = combineLatest([
      this.fillAssistPolicy$,
      this.configService.serverConfig$,
    ]).pipe(
      map(([policy, serverConfig]) => {
        const withSlash = (u: string) => (u.endsWith("/") ? u : `${u}/`);
        const defaultUrl = withSlash(DEFAULT_FILL_ASSIST_RULES_URL);

        // Normalize both sides so a trailing slash doesn't shadow server config.
        // Legacy defaults count too — policies saved before the constant changed
        // must fetch current server config, not the retired URL.
        const policyUrl = policy?.rulesUrl;
        const isDefault =
          !policyUrl ||
          withSlash(policyUrl) === defaultUrl ||
          LEGACY_DEFAULT_FILL_ASSIST_RULES_URLS.has(policyUrl);
        if (!isDefault) {
          return withSlash(policyUrl);
        }
        const serverUrl = serverConfig?.environment?.fillAssistRules?.trim();
        if (!serverUrl) {
          return undefined;
        }
        return withSlash(serverUrl);
      }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    // Read the raw underlying state (naturally `boolean | null`) so we can
    // distinguish pristine (never touched) from explicit-false.
    this.resolvedEnableFillAssist$ = combineLatest([
      this.enableFillAssistState.state$,
      this.fillAssistPolicy$,
      this.configService.getFeatureFlag$(FeatureFlag.FillAssistTargetingRules),
    ]).pipe(
      map(([rawUserSetting, policy, featureFlag]) => {
        if (!featureFlag) {
          return false;
        }
        if (rawUserSetting == null) {
          // Pristine — policy default applies
          return policy != null;
        }
        // User has explicitly set — respect their choice
        return rawUserSetting;
      }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    this.targetingRules$ = combineLatest([
      this.environmentService.environment$,
      this.effectiveFillAssistRulesUrl$,
    ]).pipe(
      switchMap(([env, effectiveUrl]) => {
        // No rules-feed URL means no cache entry to read.
        if (!effectiveUrl) {
          return of(null);
        }
        return this.stateProvider
          .getGlobal(SERVER_TARGETING_RULES)
          .state$.pipe(
            map(
              (records) =>
                records?.[fillAssistRulesCacheKey(env.getApiUrl(), effectiveUrl)] ?? null,
            ),
          );
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    this.defaultUriMatchStrategyPolicy$ = this.accountService.activeAccount$.pipe(
      getUserId,
      switchMap((userId) => this.defaultUriMatchStrategyPolicyFor$(userId)),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    this.resolvedDefaultUriMatchStrategy$ = combineLatest([
      this.defaultUriMatchStrategy$,
      this.defaultUriMatchStrategyPolicy$,
    ]).pipe(
      map(([userSettingValue, policySettingValue]) => policySettingValue || userSettingValue),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }

  /**
   * The accounts fill assist is resolved for: the served accounts, or the active account alone
   * while none is served.
   */
  private fillAssistUserIds$(): Observable<UserId[]> {
    const activeUserIds$ = this.accountService.activeAccount$.pipe(
      map((account) => (account == null ? [] : [account.id])),
    );
    if (this.servedUserIds$ == null) {
      return activeUserIds$;
    }
    return combineLatest([this.servedUserIds$, activeUserIds$]).pipe(
      map(([servedUserIds, activeUserIds]) =>
        servedUserIds.length > 0 ? servedUserIds : activeUserIds,
      ),
    );
  }

  /** {@link fillAssistPolicy$} for `userId` alone. */
  private fillAssistPolicyFor$(userId: UserId): Observable<FillAssistPolicy> {
    return this.policyService.policiesByType$(PolicyType.FillAssist, userId).pipe(
      getFirstPolicy,
      map((policy) => {
        if (!policy?.enabled) {
          return null;
        }
        // URL is optional (enabled policy still applies without it). Validate
        // https here as defense-in-depth against API-bypass paths.
        const rulesUrl = policy.data?.rulesUrl;
        if (typeof rulesUrl === "string" && rulesUrl) {
          try {
            const parsed = new URL(rulesUrl);
            if (parsed.protocol === "https:") {
              return { rulesUrl };
            }
          } catch {
            // Malformed URL — fall through to "policy applies, no URL".
          }
        }
        return {};
      }),
    );
  }

  /** The org policy value for the default URI match strategy of `userId`, `null` without one. */
  private defaultUriMatchStrategyPolicyFor$(userId: UserId): Observable<UriMatchStrategySetting> {
    return this.policyService.policiesByType$(PolicyType.UriMatchDefaults, userId).pipe(
      getFirstPolicy,
      map((policy) => {
        if (!policy?.enabled || policy?.data == null) {
          return null;
        }
        const data = policy.data?.uriMatchDetection;
        // Validate that data is a valid UriMatchStrategy value
        return Object.values(UriMatchStrategy).includes(data) ? data : null;
      }),
    );
  }

  equivalentDomainsFor$(userId: UserId): Observable<EquivalentDomains> {
    return this.stateProvider
      .getUser(userId, EQUIVALENT_DOMAINS)
      .state$.pipe(map((x) => x ?? null));
  }

  resolvedDefaultUriMatchStrategyFor$(userId: UserId): Observable<UriMatchStrategySetting> {
    return combineLatest([
      this.stateProvider
        .getUser(userId, DEFAULT_URI_MATCH_STRATEGY)
        .state$.pipe(map((x) => x ?? UriMatchStrategy.Domain)),
      this.defaultUriMatchStrategyPolicyFor$(userId),
    ]).pipe(
      map(([userSettingValue, policySettingValue]) => policySettingValue || userSettingValue),
    );
  }

  async setShowFavicons(newValue: boolean): Promise<void> {
    await this.showFaviconsState.update(() => newValue);
  }

  async setNeverDomains(newValue: NeverDomains): Promise<void> {
    await this.neverDomainsState.update(() => newValue);
  }

  async setBlockedInteractionsUris(newValue: NeverDomains): Promise<void> {
    await this.blockedInteractionsUrisState.update(() => newValue);
  }

  async setEquivalentDomains(newValue: EquivalentDomains, userId: UserId): Promise<void> {
    await this.stateProvider.getUser(userId, EQUIVALENT_DOMAINS).update(() => newValue);
  }

  async setDefaultUriMatchStrategy(newValue: UriMatchStrategySetting): Promise<void> {
    await this.defaultUriMatchStrategyState.update(() => newValue);
  }

  getUrlEquivalentDomains(url: string, userId?: UserId): Observable<Set<string>> {
    const equivalentDomains$ =
      userId == null ? this.equivalentDomains$ : this.equivalentDomainsFor$(userId);
    const domains$ = equivalentDomains$.pipe(
      map((equivalentDomains) => {
        const domain = Utils.getDomain(url);
        if (domain == null || equivalentDomains == null) {
          return new Set() as Set<string>;
        }

        const equivalents = equivalentDomains.filter((ed) => ed.includes(domain)).flat();

        return new Set(equivalents);
      }),
    );

    return domains$;
  }

  async setEnableFillAssist(newValue: boolean): Promise<void> {
    await this.enableFillAssistState.update(() => newValue, {
      shouldUpdate: (current) => current !== newValue,
    });
  }

  async setTargetingRules(rules: TargetingRulesByDomain, effectiveUrl?: string): Promise<void> {
    const env = await firstValueFrom(this.environmentService.environment$);
    const url = effectiveUrl ?? (await firstValueFrom(this.effectiveFillAssistRulesUrl$));
    if (!url) {
      return;
    }
    const key = fillAssistRulesCacheKey(env.getApiUrl(), url);
    await this.stateProvider
      .getGlobal(SERVER_TARGETING_RULES)
      .update((existing) => ({ ...existing, [key]: rules }), {
        shouldUpdate: (existing) => existing?.[key] !== rules,
      });
  }

  async getTargetingRulesForUrl(url: URL["href"]): Promise<FormContent[] | null> {
    const fillAssistEnabled = await firstValueFrom(this.resolvedEnableFillAssist$);
    if (!fillAssistEnabled) {
      return null;
    }

    // Fill assist requires an unlocked vault. A served account is unlocked.
    if (this.servedUserIds$ != null && (await firstValueFrom(this.servedUserIds$)).length > 0) {
      return matchTargetingRulesForUrl(await firstValueFrom(this.targetingRules$), url);
    }
    const activeAccount = await firstValueFrom(this.accountService.activeAccount$);
    if (!activeAccount) {
      return null;
    }
    const authStatus = await firstValueFrom(this.authService.authStatusFor$(activeAccount.id));
    if (authStatus !== AuthenticationStatus.Unlocked) {
      return null;
    }

    const rules = await firstValueFrom(this.targetingRules$);

    return matchTargetingRulesForUrl(rules, url);
  }
}
