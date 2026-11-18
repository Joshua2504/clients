import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, Observable, Subject, Subscription } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { BadgeSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/badge-settings.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { Tab } from "../../platform/badge/badge-browser-api";
import { BadgeService } from "../../platform/badge/badge.service";
import { BadgeStatePriority } from "../../platform/badge/priority";
import { flushPromises } from "../spec/testing-utils";

import { CipherUse } from "./abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "./abstractions/multi-account-fill-cipher-policy";
import { AutofillBadgeUpdaterService } from "./autofill-badge-updater.service";

describe("AutofillBadgeUpdaterService", () => {
  const userId = "user-1" as UserId;
  const otherUserId = "user-2" as UserId;
  const accountCipher = (owner: UserId, id: string) => ({
    userId: owner,
    cipher: mock<CipherView>({ id }),
  });
  const tab: Tab = { tabId: 1, url: "https://example.com" };

  let setState: jest.Mock;
  let activeAccount$: BehaviorSubject<{ id: UserId } | null>;
  let enableBadgeCounter$: BehaviorSubject<boolean>;
  let otherEnableBadgeCounter$: BehaviorSubject<boolean>;
  let enableBadgeCounterFor$: jest.Mock;
  let changed$: Subject<void>;
  let autofillUserIds$: BehaviorSubject<UserId[]>;
  let fillCipherPolicy: MockProxy<MultiAccountFillCipherPolicy>;
  let emissions: unknown[];
  let subscription: Subscription;

  const subscribeToBadgeState = () => {
    const stateFunction = setState.mock.calls[0][1] as (tab: Tab) => Observable<unknown>;
    subscription = stateFunction(tab).subscribe((state) => emissions.push(state));
  };

  beforeEach(() => {
    setState = jest.fn();
    activeAccount$ = new BehaviorSubject<{ id: UserId } | null>({ id: userId });
    enableBadgeCounter$ = new BehaviorSubject(true);
    otherEnableBadgeCounter$ = new BehaviorSubject(true);
    enableBadgeCounterFor$ = jest.fn((id: UserId) =>
      id === userId ? enableBadgeCounter$ : otherEnableBadgeCounter$,
    );
    changed$ = new Subject<void>();
    autofillUserIds$ = new BehaviorSubject<UserId[]>([userId]);
    fillCipherPolicy = mock<MultiAccountFillCipherPolicy>();
    (fillCipherPolicy as any).changed$ = changed$;
    fillCipherPolicy.ciphersForUrl.mockResolvedValue([
      accountCipher(userId, "a"),
      accountCipher(userId, "b"),
    ]);
    emissions = [];

    new AutofillBadgeUpdaterService(
      { setState } as unknown as BadgeService,
      { activeAccount$ } as unknown as AccountService,
      fillCipherPolicy,
      { enableBadgeCounterFor$ } as unknown as BadgeSettingsServiceAbstraction,
      mock<LogService>(),
      { autofillUserIds$ } as unknown as AutofillAccountsService,
    ).init();
  });

  afterEach(() => {
    subscription?.unsubscribe();
  });

  it("registers its state function on init", () => {
    expect(setState).toHaveBeenCalledWith("autofill-badge-updater", expect.any(Function));
  });

  it("counts the badge ciphers for the tab URL when the policy reports a change", async () => {
    subscribeToBadgeState();

    changed$.next();
    await flushPromises();

    expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledWith(tab.url, CipherUse.Badge);
    expect(emissions).toEqual([{ state: { text: "2" }, priority: BadgeStatePriority.Default }]);
  });

  it("recounts on every policy change", async () => {
    subscribeToBadgeState();
    changed$.next();
    await flushPromises();

    fillCipherPolicy.ciphersForUrl.mockResolvedValueOnce([]);
    changed$.next();
    await flushPromises();

    expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledTimes(2);
    expect(emissions).toEqual([
      { state: { text: "2" }, priority: BadgeStatePriority.Default },
      { state: { text: undefined }, priority: BadgeStatePriority.Default },
    ]);
  });

  it("shows 9+ for more than nine ciphers", async () => {
    fillCipherPolicy.ciphersForUrl.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => accountCipher(userId, `${index}`)),
    );
    subscribeToBadgeState();

    changed$.next();
    await flushPromises();

    expect(emissions).toEqual([{ state: { text: "9+" }, priority: BadgeStatePriority.Default }]);
  });

  it("does not count when the badge counter is disabled", async () => {
    enableBadgeCounter$.next(false);
    subscribeToBadgeState();

    changed$.next();
    await flushPromises();

    expect(fillCipherPolicy.ciphersForUrl).not.toHaveBeenCalled();
    expect(emissions).toEqual([undefined]);
  });

  it("does not ask the policy without an active account or an account to serve", async () => {
    activeAccount$.next(null);
    autofillUserIds$.next([]);
    subscribeToBadgeState();

    changed$.next();
    await flushPromises();

    expect(fillCipherPolicy.ciphersForUrl).not.toHaveBeenCalled();
    expect(emissions).toEqual([undefined]);
  });

  describe("with two accounts serving autofill", () => {
    beforeEach(() => {
      autofillUserIds$.next([userId, otherUserId]);
    });

    it("counts the ciphers of both accounts for the tab URL", async () => {
      fillCipherPolicy.ciphersForUrl.mockResolvedValue([
        accountCipher(userId, "personal"),
        accountCipher(otherUserId, "work-1"),
        accountCipher(otherUserId, "work-2"),
      ]);
      subscribeToBadgeState();

      changed$.next();
      await flushPromises();

      expect(emissions).toEqual([{ state: { text: "3" }, priority: BadgeStatePriority.Default }]);
    });

    it("counts the same shared item once for each account that holds it", async () => {
      fillCipherPolicy.ciphersForUrl.mockResolvedValue([
        accountCipher(userId, "shared"),
        accountCipher(otherUserId, "shared"),
      ]);
      subscribeToBadgeState();

      changed$.next();
      await flushPromises();

      expect(emissions).toEqual([{ state: { text: "2" }, priority: BadgeStatePriority.Default }]);
    });

    it("recounts when one of them locks", async () => {
      subscribeToBadgeState();
      changed$.next();
      await flushPromises();

      // The policy reports the change of accounts and then answers for the one that remains.
      autofillUserIds$.next([userId]);
      fillCipherPolicy.ciphersForUrl.mockResolvedValue([accountCipher(userId, "a")]);
      changed$.next();
      await flushPromises();

      expect(emissions).toEqual([
        { state: { text: "2" }, priority: BadgeStatePriority.Default },
        { state: { text: "1" }, priority: BadgeStatePriority.Default },
      ]);
    });

    it("does not count when an account that is not active has the badge counter disabled", async () => {
      otherEnableBadgeCounter$.next(false);
      subscribeToBadgeState();

      changed$.next();
      await flushPromises();

      expect(fillCipherPolicy.ciphersForUrl).not.toHaveBeenCalled();
      expect(emissions).toEqual([undefined]);
    });

    it("counts again once the account that disabled the badge counter stops serving", async () => {
      otherEnableBadgeCounter$.next(false);
      subscribeToBadgeState();
      changed$.next();
      await flushPromises();

      autofillUserIds$.next([userId]);
      await flushPromises();

      expect(enableBadgeCounterFor$).toHaveBeenCalledWith(otherUserId);
      expect(emissions).toEqual([
        undefined,
        { state: { text: "2" }, priority: BadgeStatePriority.Default },
      ]);
    });

    it("counts for an account that serves autofill when there is no active account", async () => {
      activeAccount$.next(null);
      autofillUserIds$.next([otherUserId]);
      subscribeToBadgeState();

      changed$.next();
      await flushPromises();

      expect(emissions).toEqual([{ state: { text: "2" }, priority: BadgeStatePriority.Default }]);
    });
  });
});
