import {
  combineLatest,
  concatMap,
  debounceTime,
  filter,
  firstValueFrom,
  groupBy,
  map,
  mergeMap,
  Observable,
  of,
  retry,
  Subject,
  switchMap,
  take,
  takeUntil,
  withLatestFrom,
} from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { AutofillSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/autofill-settings.service";
import { AccountCipher } from "@bitwarden/common/autofill/types/account-cipher";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { withLatestReady } from "@bitwarden/common/tools/rx";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherRepromptType } from "@bitwarden/common/vault/enums/cipher-reprompt-type";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { BrowserApi } from "../../platform/browser/browser-api";
import { AutofillOutcome } from "../enums/autofill-outcome.enum";
import {
  AutofillLifecycleService,
  AutomationWorkflow,
} from "../services/abstractions/autofill-lifecycle.service";
import {
  AutoFillOptions,
  AutofillService,
  PageDetail,
} from "../services/abstractions/autofill.service";
import { CipherUse } from "../services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../services/abstractions/multi-account-fill-cipher-policy";
import { AutofillTriageResponse } from "../types/autofill-triage";
import {
  AUTOFILL_ABSENT,
  AUTOFILL_DENIED,
  FillResult,
  shouldAutoCopyTotp,
} from "../types/fill-result";

import { AutofillOrchestrator } from "./abstractions/autofill-orchestrator";

/**
 * A fill the background drives from a runtime message or a resolved page
 * transition.
 */
type FillRequest =
  | {
      kind: "pageLoad";
      tab: chrome.tabs.Tab;
      tabId: number;
      frameId: number | undefined;
      // The reporting frame's URL, from the message sender. Validated against the frame's live URL
      // at dispatch so a navigated frame is not filled with a cipher chosen for the old page.
      frameUrl: string;
    }
  | {
      kind: "command";
      tab: chrome.tabs.Tab;
      tabId: number;
      frameId: number | undefined;
    }
  | {
      kind: "cipherType";
      tab: chrome.tabs.Tab;
      tabId: number;
      frameId: number | undefined;
      cipherType: CipherType;
    };

/**
 * How many times the dispatch pipe re-seeds the live-tab set after a seed failure
 * before giving up. Bounded so a persistently failing seed cannot loop forever.
 */
export const LIVE_TAB_SEED_MAX_RETRIES = 4;

/** Delay between live-tab seed retries, giving a transient failure time to clear. */
export const LIVE_TAB_SEED_RETRY_DELAY_MS = 250;

/**
 * Quiescence window a multi-frame collection waits for before it is used. A tab's
 * frames answer a collect independently; this lets their responses accumulate into
 * one settled result instead of dispatching a fill per frame as each replies.
 */
export const COLLECT_SETTLE_MS = 50;

/**
 * How recently a cipher must have been launched for a page-load fill to prefer it over the
 * last-used cipher for the URL.
 */
export const LOGIN_LAST_LAUNCHED_WINDOW_MS = 30000;

/** Why `selectLogin` chooses a cipher, and whether the page-load cipher filter applies. */
const FillReason = Object.freeze({
  /** Keyboard shortcut or login cipher-type fill. Next cipher in the URL rotation. */
  userCommand: "userCommand",
  /** Auto-submit. Last-launched or last-used, from every cipher for the URL. */
  policyCommand: "policyCommand",
  /** Page-load fill. Last-launched or last-used, with the page-load cipher filter. */
  automatic: "automatic",
} as const);
type FillReason = (typeof FillReason)[keyof typeof FillReason];

/**
 * A concrete fill boiled down from a request: the chosen cipher and the account whose vault it
 * was read from, the rotation key its fillable cipher cycles under (the tab URL for logins, the
 * cipher-type cache key for card/identity), and the {@link AutoFillOptions} flags the service
 * fill needs.
 */
interface PlannedFill {
  cipher: CipherView;
  userId: UserId;
  cycleKey: string;
  options: Partial<AutoFillOptions>;
}

/**
 * The {@link AutoFillOptions} flags a caller-supplied fill applies unless the
 * caller overrides them.
 */
const CALLER_FILL_DEFAULTS = Object.freeze({
  fillNewPassword: true,
  allowTotpAutofill: true,
});

/**
 * Opt-out key for {@link DefaultAutofillOrchestrator.commit}'s foreground verification. It is a symbol
 * private to this module, so no code outside this file can build the options object that turns the
 * check off. This prohibits logic outside the orchestrator from circumventing the type system to
 * invoke a commit without active tab support. The most an external caller can do
 * is omit the key, which fails safe by requiring the active tab.
 */
const requireActiveTab = Symbol("requireActiveTab");

/** {@link DefaultAutofillOrchestrator.commit} overrides, keyed by the module-private {@link requireActiveTab}.
 *
 * DANGER: {@link requireActiveTab} exists only to support extension-initiated fills. NEVER disable this
 * flag from a code path initiated outside of the extension.
 */
type CommitOverrides = { [requireActiveTab]?: boolean };

/**
 * Default implementation of {@link AutofillOrchestrator}. See `orchestrator.design.md` for the
 * sequencing and invariants it upholds.
 */
export class DefaultAutofillOrchestrator implements AutofillOrchestrator {
  /** Serialized-core input; public methods and the page-load subscription feed it. */
  private readonly fillRequest$ = new Subject<FillRequest>();

  /**
   * The autofill accounts that have autofill on page load enabled, in precedence order. A
   * page-load fill offers a cipher of these accounts only: a cipher is governed by the setting of
   * its own account.
   */
  private readonly pageLoadUserIds$: Observable<UserId[]>;

  constructor(
    private lifecycleService: AutofillLifecycleService,
    private autofillService: AutofillService,
    private autofillSettingsService: AutofillSettingsServiceAbstraction,
    private accountService: AccountService,
    private platformUtilsService: PlatformUtilsService,
    private updateOverlayCiphers: () => Promise<void>,
    private logService: LogService,
    private fillCipherPolicy: MultiAccountFillCipherPolicy,
    private autofillAccountsService: AutofillAccountsService,
    /** Injected wall-clock source (epoch ms), overridable so time-dependent selection is testable. */
    private now: () => number = () => Date.now(),
  ) {
    this.pageLoadUserIds$ = this.autofillAccountsService.autofillUserIds$.pipe(
      switchMap((userIds) =>
        userIds.length === 0
          ? of([] as UserId[])
          : combineLatest(
              userIds.map((userId) => this.autofillSettingsService.autofillOnPageLoadFor$(userId)),
            ).pipe(map((enabled) => userIds.filter((_, index) => enabled[index]))),
      ),
    );
  }

  init() {
    // sequence and dispatch fill requests through a common pipe to prevent dispatch
    // calls from interleaving async collections and fills.
    this.fillRequest$
      .pipe(
        // Drop any request whose tab id is not a currently-open tab before it can
        // open a per-tab group.
        withLatestReady(this.lifecycleService.liveTabs$),
        filter(([request, liveTabs]) => liveTabs.has(request.tabId)),
        map(([request]) => request),
        groupBy((request) => request.tabId),
        mergeMap((tabGroup) =>
          tabGroup.pipe(
            groupBy((request) => request.frameId ?? -1),
            mergeMap((frameGroup) =>
              frameGroup.pipe(concatMap((request) => this.dispatch(request))),
            ),
            takeUntil(this.lifecycleService.tabRemoved$(tabGroup.key)),
          ),
        ),
        // circuit-break fill requests when tab validation repeatedly fails
        retry({ count: LIVE_TAB_SEED_MAX_RETRIES, delay: LIVE_TAB_SEED_RETRY_DELAY_MS }),
      )
      .subscribe({
        error: (error: unknown) =>
          this.logService.error(
            "Autofill dispatch stopped: live-tab set could not be established.",
            error,
          ),
      });

    // Page-load opportunities feed the same serialized stream, gated reactively on
    // the current autofill-on-page-load setting of the accounts autofill serves: an
    // opportunity is abandoned when none of them has it enabled, or when there are none.
    this.lifecycleService.pageTransitionResolved$
      .pipe(
        withLatestFrom(this.pageLoadUserIds$),
        filter(([, pageLoadUserIds]) => pageLoadUserIds.length > 0),
        map(([opportunity]) => opportunity),
      )
      .subscribe(({ tab, tabId, frameId, frameUrl }) =>
        this.fillRequest$.next({ kind: "pageLoad", tab, tabId, frameId, frameUrl }),
      );

    // The auto-submit-login workflow reports each step as a fact; interpret it as one
    // collect → fill → submit.
    this.lifecycleService.automatedLoginStepReady$
      .pipe(filter((signal) => signal.workflow === AutomationWorkflow.autoSubmitLogin))
      .subscribe((signal) => {
        void this.autoSubmitLoginOnTab(signal.tab, signal.userIds, signal.frameId).catch(
          (error: unknown) => this.logService.error(error),
        );
      });
  }

  autofillActiveTabFromCommand(tab: chrome.tabs.Tab) {
    this.enqueueUserInitiated("command", tab);
  }

  autofillActiveTabForCipherType(tab: chrome.tabs.Tab, cipherType: CipherType) {
    this.enqueueUserInitiated("cipherType", tab, cipherType);
  }

  collectPageDetails(tab: chrome.tabs.Tab, frameId?: number): Promise<PageDetail[]> {
    return firstValueFrom(
      this.autofillService
        .collectPageDetailsFromTab$(tab, frameId)
        .pipe(debounceTime(COLLECT_SETTLE_MS), take(1)),
    );
  }

  collectAutofillTriage(
    tabId: number,
    frameId?: number,
  ): Promise<AutofillTriageResponse | undefined> {
    return new Promise<AutofillTriageResponse | undefined>((resolve) => {
      BrowserApi.sendTabsMessage<AutofillTriageResponse>(
        tabId,
        { command: "collectAutofillTriage" },
        frameId !== undefined ? { frameId } : undefined,
        (response) => {
          // A tab with no autofill receiver rejects via lastError; treat it as "no analysis".
          if (chrome.runtime.lastError) {
            resolve(undefined);
            return;
          }
          resolve(response ?? undefined);
        },
      );
    });
  }

  async fillCipher(options: AutoFillOptions): Promise<FillResult> {
    return this.commit(options);
  }

  async autofillTabWithCipher(
    tab: chrome.tabs.Tab,
    cipher: CipherView,
    userId: UserId,
    options?: Partial<AutoFillOptions>,
  ): Promise<FillResult> {
    const pageDetails = await this.collectPageDetails(tab);
    if (pageDetails.length === 0) {
      return AUTOFILL_ABSENT;
    }
    // The cipher and its account come last, so the options cannot separate the pair.
    const fill = { tab, pageDetails, ...CALLER_FILL_DEFAULTS, ...options, cipher, userId };
    return this.fillCipher(fill);
  }

  async unsafeAutofillTabWithCipher(
    tab: chrome.tabs.Tab,
    cipher: CipherView,
    userId: UserId,
    options?: Partial<AutoFillOptions>,
  ): Promise<FillResult> {
    const pageDetails = await this.collectPageDetails(tab);
    if (pageDetails.length === 0) {
      return AUTOFILL_ABSENT;
    }

    // FIXME (PM-39579): gate these on the target tab's lifecycle state once that gate lands. Only "warm"
    // tabs should allow unsafe fills.
    // The cipher and its account come last, so the options cannot separate the pair.
    const fill = { tab, pageDetails, ...CALLER_FILL_DEFAULTS, ...options, cipher, userId };
    return this.commit(fill, { [requireActiveTab]: false });
  }

  /**
   * Runs the orchestrator's *submit* phase using a `collect → fill → submit` workflow.
   *
   * A step is one `collect → fill → submit`. The content script drives the *cadence* across a
   * multi-step form, re-invoking this once each step's DOM has settled.
   *
   * Only a cipher of an account whose policy approved the workflow is submitted: a host approved
   * by one account's organization never submits another account's cipher.
   *
   * @param tab The tab whose frame is running the auto-submit workflow
   * @param approvingUserIds The accounts whose policy approved the workflow
   * @param frameId The frame that reported the auto-submit opportunity
   */
  private async autoSubmitLoginOnTab(
    tab: chrome.tabs.Tab,
    approvingUserIds: readonly UserId[],
    frameId?: number,
  ): Promise<void> {
    if (!tab.url) {
      return;
    }
    const userIds = (await this.autofillUserIds()).filter((userId) =>
      approvingUserIds.includes(userId),
    );
    if (userIds.length === 0) {
      return;
    }
    const pageDetails = await this.read(tab, frameId);
    if (pageDetails.length === 0) {
      return;
    }
    const selection = await this.selectLogin(tab.url, FillReason.policyCommand, userIds);
    if (selection == null || (await this.resolveReprompt(selection, tab, true, tab.url))) {
      return;
    }

    await this.commit({
      tab,
      cipher: selection.cipher,
      userId: selection.userId,
      pageDetails,
      fillNewPassword: true,
      allowUntrustedIframe: true,
      allowTotpAutofill: true,
      autoSubmitLogin: true,
    });
  }

  private enqueueUserInitiated(
    kind: "command" | "cipherType",
    tab: chrome.tabs.Tab,
    cipherType?: CipherType,
  ) {
    const tabId = tab?.id;
    if (tabId == null) {
      // A fill with no tab id cannot be targeted or keyed for serialization.
      return;
    }
    // A user-initiated fill is tab-scoped: it fills the active tab across all frames in one pass,
    // so it carries no frame id and serializes per tab (see `orchestrator.design.md`, "Fills do not
    // race"). It deliberately does not share a per-frame lane with page-load fills.
    this.fillRequest$.next(
      kind === "command"
        ? { kind, tab, tabId, frameId: undefined }
        : { kind: "cipherType", tab, tabId, frameId: undefined, cipherType: cipherType! },
    );
  }

  /**
   * Runs one request to completion as read → select → commit. Errors are logged, never rethrown,
   * so a single failed fill cannot terminate the serialized stream.
   *
   * The three request kinds share this skeleton and differ only in the read scope, the cipher
   * selection, and the post-commit effects — the consolidation this owner exists to provide.
   */
  private async dispatch(request: FillRequest): Promise<void> {
    try {
      const target =
        request.kind === "pageLoad" ? await this.resolveFreshTarget(request) : request.tab;
      if (target == null) {
        return;
      }

      const [pageDetails, plan] = await Promise.all([
        this.read(target, request.frameId),
        this.selectFill(request, target),
      ]);
      if (
        pageDetails.length == 0 ||
        plan == null ||
        !this.reportedFrameIsFresh(request, pageDetails)
      ) {
        return;
      }
      const fromCommand = request.kind !== "pageLoad";
      if (await this.resolveReprompt(plan, target, fromCommand, plan.cycleKey)) {
        return;
      }

      const result = await this.commit({
        tab: target,
        cipher: plan.cipher,
        userId: plan.userId,
        pageDetails,
        ...plan.options,
      });

      // A commanded fill cycles the rotation so its next invocation offers the next cipher;
      // a page-load fill uses last-used/last-launched selection and leaves the rotation alone.
      if (fromCommand && result.outcome === AutofillOutcome.Filled) {
        this.cycleFillableCipher(plan.cycleKey);
      }

      // Login fills copy the TOTP and refresh the overlay ciphers once a credential is placed.
      // Avoids overwriting the clipboard, since the user does not choose the filled cipher.
      if (
        result.outcome === AutofillOutcome.Filled &&
        (request.kind === "pageLoad" || request.kind === "command")
      ) {
        if (shouldAutoCopyTotp(result)) {
          this.platformUtilsService.copyToClipboard(result.totp);
        }

        await this.updateOverlayCiphers();
      }
    } catch (error) {
      this.logService.error(error);
    }
  }

  /**
   * The read operation: collects a target's page details for a fill.
   *
   * A tab-wide collect (no `frameId`) waits `COLLECT_SETTLE_MS` for the tab's frames to answer
   * independently and accumulate into one settled result. A frame-scoped collect gets exactly one
   * response, already complete, so it needs no settle.
   */
  private async read(tab: chrome.tabs.Tab, frameId?: number): Promise<PageDetail[]> {
    const pageDetails$ = this.autofillService.collectPageDetailsFromTab$(tab, frameId);
    const pageDetails = await firstValueFrom(
      frameId == null ? pageDetails$.pipe(debounceTime(COLLECT_SETTLE_MS), take(1)) : pageDetails$,
    );
    const details = pageDetails.filter(({ details }) => !!details?.fields?.length);

    return details;
  }

  /**
   * Correct-origin guard for a page-load fill: its cipher is chosen against the URL the frame
   * reported, so a same-document navigation between {@link resolveFreshTarget} (a live-target check)
   * and the collect must not fill a cipher meant for the old page. Confirms the collected details
   * still show that URL. Other fill kinds carry no per-URL cipher choice to invalidate, so they are
   * always fresh.
   *
   * A rejection here abandons the fill silently. That is safe because it is confined to page-load
   * and self-correcting — the page now in the frame raises its own opportunity — and because a
   * user-initiated fill never reaches this guard. See `orchestrator.design.md`, "A credential
   * reaches only the origin it was chosen for", for the security/UX rationale.
   */
  private reportedFrameIsFresh(request: FillRequest, pageDetails: PageDetail[]): boolean {
    if (request.kind !== "pageLoad") {
      return true;
    }
    return pageDetails.some(({ details }) => details?.url === request.frameUrl);
  }

  /**
   * The select operation: boils a request down to a concrete {@link PlannedFill}, or `undefined`
   * when no cipher applies. Login selection (page load, command, and the defensive cipher-type=login
   * case) reads by URL; card/identity selection reads the next cipher of that type. Selection
   * runs over every account autofill serves; with none, the request is abandoned.
   */
  private async selectFill(
    request: FillRequest,
    target: chrome.tabs.Tab,
  ): Promise<PlannedFill | undefined> {
    const userIds = await this.autofillUserIds();
    if (userIds.length === 0 || !target.url) {
      return undefined;
    }
    const fromCommand = request.kind !== "pageLoad";

    if (request.kind === "cipherType" && request.cipherType !== CipherType.Login) {
      const selection = await this.selectCipherTypeCipher(request.cipherType);
      if (selection == null) {
        return undefined;
      }
      return {
        cipher: selection.cipher,
        userId: selection.userId,
        cycleKey: selection.cacheKey,
        options: {
          skipLastUsed: false,
          skipUsernameOnlyFill: false,
          onlyEmptyFields: false,
          fillNewPassword: false,
          allowUntrustedIframe: true,
          allowTotpAutofill: false,
        },
      };
    }

    // A page-load fill offers only the ciphers of accounts that have autofill on page load on.
    const selection =
      request.kind === "pageLoad"
        ? await this.selectLogin(
            target.url,
            FillReason.automatic,
            await firstValueFrom(this.pageLoadUserIds$),
          )
        : await this.selectLogin(target.url, FillReason.userCommand, userIds);
    if (selection == null) {
      return undefined;
    }
    return {
      cipher: selection.cipher,
      userId: selection.userId,
      cycleKey: target.url,
      options: {
        skipLastUsed: !fromCommand,
        skipUsernameOnlyFill: !fromCommand,
        onlyEmptyFields: !fromCommand,
        fillNewPassword: fromCommand,
        allowUntrustedIframe: fromCommand,
        allowTotpAutofill: fromCommand,
      },
    };
  }

  /**
   * Selects the login cipher for a URL. `userCommand` takes the next cipher in the URL's rotation.
   * `policyCommand` and `automatic` prefer a cipher launched within the last
   * {@link LOGIN_LAST_LAUNCHED_WINDOW_MS}, else the last one used for the URL. Only `automatic`
   * applies the per-item autofill-on-page-load filter.
   *
   * @param userIds The accounts whose ciphers `policyCommand` and `automatic` may select. The
   * rotation of `userCommand` always walks every account autofill serves.
   */
  private async selectLogin(
    tabUrl: string,
    reason: FillReason,
    userIds: readonly UserId[],
  ): Promise<AccountCipher | undefined> {
    if (reason === FillReason.userCommand) {
      return this.fillCipherPolicy.nextCipherForUrl(tabUrl);
    }
    if (userIds.length === 0) {
      return undefined;
    }
    const isAutomatic = reason === FillReason.automatic;
    const select = await this.automaticLoginSelection(tabUrl, isAutomatic, userIds);
    const lastLaunchedCipher = await select.lastLaunched();
    const lastLaunched = lastLaunchedCipher?.cipher.localData?.lastLaunched;
    if (
      lastLaunchedCipher &&
      lastLaunched &&
      this.now() - lastLaunched.valueOf() < LOGIN_LAST_LAUNCHED_WINDOW_MS
    ) {
      return lastLaunchedCipher;
    }
    return select.lastUsed();
  }

  /**
   * How an automatic fill finds its last-launched and last-used login among the ciphers of
   * `userIds`. When those are all the accounts autofill serves, the policy chooses, which for a
   * single account is that account's own selection, unchanged. When some serving account is
   * left out, the policy's choice could be a cipher of that account, so the choice is made here
   * from the logins of `userIds` alone, by the rules the policy applies across accounts.
   */
  private async automaticLoginSelection(
    tabUrl: string,
    isAutomatic: boolean,
    userIds: readonly UserId[],
  ): Promise<{
    lastLaunched: () => Promise<AccountCipher | undefined>;
    lastUsed: () => Promise<AccountCipher | undefined>;
  }> {
    const serving = await this.autofillUserIds();
    if (serving.every((userId) => userIds.includes(userId))) {
      return {
        lastLaunched: () => this.fillCipherPolicy.lastLaunchedForUrl(tabUrl, isAutomatic),
        lastUsed: () => this.fillCipherPolicy.lastUsedForUrl(tabUrl, isAutomatic),
      };
    }

    const logins = await this.automaticLoginsOf(tabUrl, isAutomatic, userIds);
    return {
      lastLaunched: async () =>
        logins
          .filter(({ cipher }) => cipher.localData?.lastLaunched)
          .sort(
            (a, b) =>
              (b.cipher.localData?.lastLaunched ?? 0) - (a.cipher.localData?.lastLaunched ?? 0),
          )[0],
      lastUsed: async () =>
        [...logins].sort(
          (a, b) =>
            (b.cipher.localData?.lastUsedDate || 0) - (a.cipher.localData?.lastUsedDate || 0),
        )[0],
    };
  }

  /**
   * The logins of `userIds` an automatic fill may choose from. For a page-load fill, a login
   * qualifies by its own page-load setting, or by its own account's default when it has none.
   */
  private async automaticLoginsOf(
    tabUrl: string,
    isAutomatic: boolean,
    userIds: readonly UserId[],
  ): Promise<AccountCipher[]> {
    const logins = (
      await this.fillCipherPolicy.ciphersForUrl(tabUrl, CipherUse.AutomaticFill)
    ).filter(({ userId }) => userIds.includes(userId));
    if (!isAutomatic) {
      return logins;
    }

    const defaults = new Map<UserId, boolean>();
    for (const userId of userIds) {
      defaults.set(
        userId,
        await firstValueFrom(this.autofillSettingsService.autofillOnPageLoadDefaultFor$(userId)),
      );
    }
    return logins.filter(({ userId, cipher }) => {
      const setting = cipher.login?.autofillOnPageLoad;
      return setting || (setting == null && defaults.get(userId) !== false);
    });
  }

  /** Selects the next card or identity cipher and the cache key its rotation index advances under. */
  private async selectCipherTypeCipher(
    cipherType: CipherType,
  ): Promise<(AccountCipher & { cacheKey: string }) | undefined> {
    const cacheKey = cipherType === CipherType.Card ? "cardCiphers" : "identityCiphers";
    const selection =
      cipherType === CipherType.Card
        ? await this.fillCipherPolicy.nextCardCipher()
        : await this.fillCipherPolicy.nextIdentityCipher();
    return selection ? { ...selection, cacheKey } : undefined;
  }

  /**
   * Resolves password reprompt for a selected cipher. Returns `true` to abandon the fill: a
   * page-load fill never surfaces a reprompt popout (a reprompt-protected cipher is simply not
   * filled); a command-strength fill surfaces the master-password popout and abandons this fill,
   * cycling past the reprompt-protected cipher so the next command offers the next one. The
   * reprompt is judged for the account that owns the cipher.
   */
  private async resolveReprompt(
    { cipher, userId }: AccountCipher,
    target: chrome.tabs.Tab,
    fromCommand: boolean,
    cycleKey: string,
  ): Promise<boolean> {
    if (cipher.reprompt === CipherRepromptType.Password && !fromCommand) {
      return true;
    }
    if (await this.autofillService.isPasswordRepromptRequired(cipher, target, userId)) {
      if (fromCommand) {
        this.cycleFillableCipher(cycleKey);
      }
      return true;
    }
    return false;
  }

  /**
   * The commit operation: the single point where a concrete fill is sent to the service. It confirms
   * the target still shows the URL the fill was aimed at and optionally that it is the foreground tab.
   * It also confirms that the cipher's account is still one autofill serves: a lock, a logout, or a
   * switch that ends its service between selection and here denies the fill.
   *
   * A successful commit counts as activity of the cipher's account.
   */
  private async commit(
    options: AutoFillOptions,
    overrides: CommitOverrides = {},
  ): Promise<FillResult> {
    // Fail safe: absent or any value other than an explicit `false` keeps the verification on.
    const requireForeground = overrides[requireActiveTab] !== false;
    const liveTab = await this.liveTargetTab(options.tab, requireForeground);
    if (!liveTab) {
      return AUTOFILL_DENIED;
    }

    // The target tab must still show the URL the fill was aimed at, so a tab that navigated
    // after the request is abandoned rather than filled.
    if (liveTab?.url !== options.tab.url) {
      return AUTOFILL_DENIED;
    }

    // Checked last, as the credential is placed. A held cipher never falls back to another account.
    const servesAutofill =
      options.userId != null &&
      (await firstValueFrom(this.autofillAccountsService.isAutofillUser$(options.userId)));
    if (!servesAutofill) {
      return AUTOFILL_DENIED;
    }

    const result = await this.autofillService.doAutoFill(options);
    if (result.outcome === AutofillOutcome.Filled) {
      await this.recordAccountActivity(options.userId);
    }
    return result;
  }

  /**
   * Reads the fill's target tab from the browser. If the tab no longer exists or the require
   * foreground check fails, returns `undefined`. Otherwise returns the tab's description.
   */
  private async liveTargetTab(
    target: chrome.tabs.Tab,
    requireForeground: boolean,
  ): Promise<chrome.tabs.Tab | undefined> {
    let result: chrome.tabs.Tab | null | undefined;

    if (requireForeground) {
      const liveTab = await BrowserApi.getTabFromCurrentWindow();
      result = liveTab?.id === target.id ? (liveTab ?? undefined) : undefined;
    } else {
      result = target.id == null ? undefined : await BrowserApi.getTab(target.id);
    }

    return result ?? undefined;
  }

  /**
   * Advances the rotation cursor for a URL (or card/identity cache key) so the *next* fill for it
   * offers the next matching cipher. `advanceRotation` is that cursor — a way to cycle
   * through the ciphers that fit a page across repeated fills — not a record that a cipher was used.
   */
  private cycleFillableCipher(key: string): void {
    this.fillCipherPolicy.advanceRotation(key);
  }

  /** The accounts autofill serves at this moment, in precedence order. */
  private autofillUserIds(): Promise<UserId[]> {
    return firstValueFrom(this.autofillAccountsService.autofillUserIds$);
  }

  /**
   * Re-resolves the reported frame's tab live by id and confirms the frame still shows the URL it
   * reported. Returns the live tab when the fill may proceed, or undefined to abandon.
   */
  private async resolveFreshTarget(
    request: Extract<FillRequest, { kind: "pageLoad" }>,
  ): Promise<chrome.tabs.Tab | undefined> {
    // `getTab` may return null synchronously (no tab id) or a promise that rejects (tab gone);
    // both collapse to a clean abandon rather than a logged error.
    const liveTab = await BrowserApi.getTab(request.tabId)?.catch((): undefined => undefined);
    if (liveTab == null) {
      return undefined;
    }

    // A sub-frame's URL is not the tab's, so its own live URL is resolved
    const liveFrameUrl =
      request.frameId == null || request.frameId === 0
        ? liveTab.url
        : await BrowserApi.getFrameDetails({ tabId: request.tabId, frameId: request.frameId })
            .then((frame) => frame?.url)
            .catch((): undefined => undefined);
    return liveFrameUrl === request.frameUrl ? liveTab : undefined;
  }

  /** Records a placed credential as activity of the account that owns the cipher. */
  private async recordAccountActivity(userId: UserId) {
    await this.accountService.setAccountActivity(userId, new Date(this.now()));
  }
}
