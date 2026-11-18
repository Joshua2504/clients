import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom, Observable, Subject } from "rxjs";

import { FakeAccountService, FakeStateProvider, mockAccountServiceWith } from "../../../spec";
import { PolicyService } from "../../admin-console/abstractions/policy/policy.service.abstraction";
import { PolicyType } from "../../admin-console/enums";
import { FeatureFlag } from "../../enums/feature-flag.enum";
import { ConfigService } from "../../platform/abstractions/config/config.service";
import { SingleUserState } from "../../platform/state";
import { UserId } from "../../types/guid";
import { CipherType } from "../../vault/enums";
import {
  RestrictedCipherType,
  RestrictedItemTypesService,
} from "../../vault/services/restricted-item-types.service";
import { ClearClipboardDelay } from "../constants";

import { AutofillSettingsService } from "./autofill-settings.service";

describe("AutofillSettingsService", () => {
  const userId = "user-id" as UserId;
  const otherUserId = "other-user-id" as UserId;

  let accountService: FakeAccountService;
  let stateProvider: FakeStateProvider;
  let configService: MockProxy<ConfigService>;
  let featureFlag$: BehaviorSubject<boolean>;
  let enableBasicAuthResponseByUser: Map<UserId, Observable<boolean | null>>;
  let restrictedItemTypesService: MockProxy<RestrictedItemTypesService>;
  let policyService: MockProxy<PolicyService>;
  let autofillSettingsService: AutofillSettingsService;

  const collectEmissions = (observable$: Observable<boolean>) => {
    const emissions: boolean[] = [];
    const subscription = observable$.subscribe((value) => emissions.push(value));
    return { emissions, subscription };
  };

  beforeEach(() => {
    accountService = mockAccountServiceWith(userId);
    stateProvider = new FakeStateProvider(accountService);

    featureFlag$ = new BehaviorSubject<boolean>(true);
    configService = mock<ConfigService>();
    configService.getFeatureFlag$
      .calledWith(FeatureFlag.EnableBasicAuthResponse)
      .mockReturnValue(featureFlag$);

    // Only the resolved basic auth response state reads single-user state, so
    // each user's stored setting is supplied here as its own stream.
    enableBasicAuthResponseByUser = new Map<UserId, Observable<boolean | null>>([
      [userId, new BehaviorSubject<boolean | null>(true)],
      [otherUserId, new BehaviorSubject<boolean | null>(false)],
    ]);
    jest
      .spyOn(stateProvider, "getUser")
      .mockImplementation(
        (requestedUserId: UserId) =>
          ({ state$: enableBasicAuthResponseByUser.get(requestedUserId) }) as SingleUserState<any>,
      );

    restrictedItemTypesService = mock<RestrictedItemTypesService>();

    policyService = mock<PolicyService>();
    autofillSettingsService = new AutofillSettingsService(
      stateProvider,
      policyService,
      accountService,
      restrictedItemTypesService,
      configService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("autofillOnPageLoadDefaultFor$", () => {
    const storedDefault = (value: boolean | null) =>
      jest.spyOn(stateProvider, "getUser").mockReturnValue({
        state$: new BehaviorSubject(value) as Observable<boolean | null>,
      } as SingleUserState<any>);

    it("reads the page-load default of the given user, not the active one", async () => {
      storedDefault(false);

      await expect(
        firstValueFrom(autofillSettingsService.autofillOnPageLoadDefaultFor$(otherUserId)),
      ).resolves.toBe(false);
      expect(stateProvider.getUser).toHaveBeenCalledWith(
        otherUserId,
        expect.objectContaining({ key: "autofillOnPageLoadDefault" }),
      );
    });

    it("defaults to true when the user never set it", async () => {
      storedDefault(null);

      await expect(
        firstValueFrom(autofillSettingsService.autofillOnPageLoadDefaultFor$(otherUserId)),
      ).resolves.toBe(true);
    });
  });

  describe("readers and writers for a user other than the active one", () => {
    it("clearClipboardDelayFor$ reads the given user's delay, five minutes when never set", async () => {
      const getUser = jest.spyOn(stateProvider, "getUser");
      getUser.mockReturnValue({
        state$: new BehaviorSubject(ClearClipboardDelay.TenSeconds),
      } as unknown as SingleUserState<any>);

      await expect(
        firstValueFrom(autofillSettingsService.clearClipboardDelayFor$(otherUserId)),
      ).resolves.toBe(ClearClipboardDelay.TenSeconds);
      expect(getUser).toHaveBeenCalledWith(
        otherUserId,
        expect.objectContaining({ key: "clearClipboardDelay" }),
      );

      getUser.mockReturnValue({
        state$: new BehaviorSubject(null),
      } as unknown as SingleUserState<any>);
      await expect(
        firstValueFrom(autofillSettingsService.clearClipboardDelayFor$(otherUserId)),
      ).resolves.toBe(ClearClipboardDelay.FiveMinutes);
    });

    it("activateAutofillOnPageLoadFromPolicyFor$ asks the policy of the given user", async () => {
      policyService.policyAppliesToUser$.mockImplementation(
        (_type, id) => new BehaviorSubject(id === otherUserId),
      );

      await expect(
        firstValueFrom(
          autofillSettingsService.activateAutofillOnPageLoadFromPolicyFor$(otherUserId),
        ),
      ).resolves.toBe(true);
      await expect(
        firstValueFrom(autofillSettingsService.activateAutofillOnPageLoadFromPolicyFor$(userId)),
      ).resolves.toBe(false);
      expect(policyService.policyAppliesToUser$).toHaveBeenCalledWith(
        PolicyType.ActivateAutofill,
        otherUserId,
      );
    });

    it("setAutofillOnPageLoadFor writes the given user's setting, not the active user's", async () => {
      const update = jest.fn().mockResolvedValue(undefined);
      const getUser = jest
        .spyOn(stateProvider, "getUser")
        .mockReturnValue({ update } as unknown as SingleUserState<any>);

      await autofillSettingsService.setAutofillOnPageLoadFor(true, otherUserId);

      expect(getUser).toHaveBeenCalledWith(
        otherUserId,
        expect.objectContaining({ key: "autofillOnPageLoad" }),
      );
      expect(update.mock.calls[0][0]()).toBe(true);
    });

    it("httpAuthenticationAvailableFor$ follows the feature flag without an active user", async () => {
      accountService.activeAccountSubject.next(null);

      await expect(
        firstValueFrom(autofillSettingsService.httpAuthenticationAvailableFor$(otherUserId)),
      ).resolves.toBe(true);
      await expect(
        firstValueFrom(autofillSettingsService.httpAuthenticationAvailable$),
      ).resolves.toBe(false);

      featureFlag$.next(false);
      await expect(
        firstValueFrom(autofillSettingsService.httpAuthenticationAvailableFor$(otherUserId)),
      ).resolves.toBe(false);
    });
  });

  describe("per-user readers", () => {
    const stored = (value: boolean | null) =>
      jest.spyOn(stateProvider, "getUser").mockReturnValue({
        state$: new BehaviorSubject(value) as Observable<boolean | null>,
      } as SingleUserState<any>);

    const restricted = (...cipherTypes: CipherType[]) =>
      restrictedItemTypesService.restrictedFor$.mockReturnValue(
        new BehaviorSubject<RestrictedCipherType[]>(
          cipherTypes.map((cipherType) => ({ cipherType, allowViewOrgIds: [] as string[] })),
        ),
      );

    it.each([
      ["autofillOnPageLoadFor$", "autofillOnPageLoad", false],
      ["autoCopyTotpFor$", "autoCopyTotp", true],
      ["showInlineMenuIdentitiesFor$", "showInlineMenuIdentities", true],
      ["showInlineMenuCardsFor$", "showInlineMenuCards", true],
      ["showInlineMenuSshKeysFor$", "showInlineMenuSshKeys", true],
      ["enableBasicAuthResponseFor$", "enableBasicAuthResponse", false],
    ] as const)(
      "%s reads the given user's stored %s, defaulting to %s",
      async (reader, key, defaultValue) => {
        restricted();

        stored(!defaultValue);
        await expect(firstValueFrom(autofillSettingsService[reader](otherUserId))).resolves.toBe(
          !defaultValue,
        );
        expect(stateProvider.getUser).toHaveBeenCalledWith(
          otherUserId,
          expect.objectContaining({ key }),
        );

        stored(null);
        await expect(firstValueFrom(autofillSettingsService[reader](otherUserId))).resolves.toBe(
          defaultValue,
        );
      },
    );

    it.each([
      ["showInlineMenuCardsFor$", CipherType.Card, CipherType.SshKey],
      ["showInlineMenuSshKeysFor$", CipherType.SshKey, CipherType.Card],
    ] as const)(
      "%s is off while the given user's organizations restrict the type",
      async (reader, ownType, otherType) => {
        stored(true);

        restricted(ownType);
        await expect(firstValueFrom(autofillSettingsService[reader](otherUserId))).resolves.toBe(
          false,
        );
        expect(restrictedItemTypesService.restrictedFor$).toHaveBeenCalledWith(otherUserId);

        restricted(otherType);
        await expect(firstValueFrom(autofillSettingsService[reader](otherUserId))).resolves.toBe(
          true,
        );
      },
    );

    it("resolvedEnableBasicAuthResponseFor$ gates the given user's setting on the feature flag", async () => {
      await expect(
        firstValueFrom(autofillSettingsService.resolvedEnableBasicAuthResponseFor$(userId)),
      ).resolves.toBe(true);
      await expect(
        firstValueFrom(autofillSettingsService.resolvedEnableBasicAuthResponseFor$(otherUserId)),
      ).resolves.toBe(false);

      featureFlag$.next(false);

      await expect(
        firstValueFrom(autofillSettingsService.resolvedEnableBasicAuthResponseFor$(userId)),
      ).resolves.toBe(false);
    });
  });

  describe("resolvedEnableBasicAuthResponse$", () => {
    it("emits true when the feature flag and the user setting are both enabled", async () => {
      await expect(
        firstValueFrom(autofillSettingsService.resolvedEnableBasicAuthResponse$),
      ).resolves.toBe(true);
    });

    it("emits false when the feature flag is disabled", async () => {
      featureFlag$.next(false);

      await expect(
        firstValueFrom(autofillSettingsService.resolvedEnableBasicAuthResponse$),
      ).resolves.toBe(false);
    });

    it("emits false when the user setting is disabled", async () => {
      enableBasicAuthResponseByUser.set(userId, new BehaviorSubject<boolean | null>(false));

      await expect(
        firstValueFrom(autofillSettingsService.resolvedEnableBasicAuthResponse$),
      ).resolves.toBe(false);
    });

    it("treats a user setting that was never set as disabled", async () => {
      enableBasicAuthResponseByUser.set(userId, new BehaviorSubject<boolean | null>(null));

      await expect(
        firstValueFrom(autofillSettingsService.resolvedEnableBasicAuthResponse$),
      ).resolves.toBe(false);
    });

    it("emits false when there is no active user", async () => {
      await accountService.switchAccount(null);

      await expect(
        firstValueFrom(autofillSettingsService.resolvedEnableBasicAuthResponse$),
      ).resolves.toBe(false);
    });

    it("reads the basic auth response setting of the active user", async () => {
      await firstValueFrom(autofillSettingsService.resolvedEnableBasicAuthResponse$);

      expect(stateProvider.getUser).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ key: "enableBasicAuthResponse" }),
      );
    });

    it("follows a change of active user", async () => {
      const { emissions, subscription } = collectEmissions(
        autofillSettingsService.resolvedEnableBasicAuthResponse$,
      );

      await accountService.switchAccount(otherUserId);

      expect(emissions).toEqual([true, false]);
      subscription.unsubscribe();
    });

    it("updates when the feature flag changes", () => {
      const { emissions, subscription } = collectEmissions(
        autofillSettingsService.resolvedEnableBasicAuthResponse$,
      );

      featureFlag$.next(false);
      featureFlag$.next(true);

      expect(emissions).toEqual([true, false, true]);
      subscription.unsubscribe();
    });

    it("does not re-emit an unchanged resolved value", () => {
      const { emissions, subscription } = collectEmissions(
        autofillSettingsService.resolvedEnableBasicAuthResponse$,
      );

      featureFlag$.next(true);

      expect(emissions).toEqual([true]);
      subscription.unsubscribe();
    });

    it("follows HTTP authentication availability", () => {
      const resolved = collectEmissions(autofillSettingsService.resolvedEnableBasicAuthResponse$);
      const available = collectEmissions(autofillSettingsService.httpAuthenticationAvailable$);

      featureFlag$.next(false);
      featureFlag$.next(true);

      expect(resolved.emissions).toEqual([true, false, true]);
      expect(available.emissions).toEqual([true, false, true]);
      resolved.subscription.unsubscribe();
      available.subscription.unsubscribe();
    });

    it("does not give a new subscriber the previous user's value before the active user's setting is read", async () => {
      // Stands in for a newly active user whose setting is still being read from storage.
      const pendingOtherUserSetting$ = new Subject<boolean | null>();
      enableBasicAuthResponseByUser.set(otherUserId, pendingOtherUserSetting$);
      // A long-lived subscriber, as the background holds, keeps any shared state alive.
      const longLived = collectEmissions(autofillSettingsService.resolvedEnableBasicAuthResponse$);
      expect(longLived.emissions).toEqual([true]);

      await accountService.switchAccount(otherUserId);
      const newSubscriber = collectEmissions(
        autofillSettingsService.resolvedEnableBasicAuthResponse$,
      );

      expect(newSubscriber.emissions).toEqual([]);

      pendingOtherUserSetting$.next(false);

      expect(newSubscriber.emissions).toEqual([false]);
      longLived.subscription.unsubscribe();
      newSubscriber.subscription.unsubscribe();
    });
  });

  describe("httpAuthenticationAvailable$", () => {
    it("emits true when there is an active user and the feature flag is on", async () => {
      await expect(
        firstValueFrom(autofillSettingsService.httpAuthenticationAvailable$),
      ).resolves.toBe(true);
    });

    it("emits true when the user setting is off", async () => {
      enableBasicAuthResponseByUser.set(userId, new BehaviorSubject<boolean | null>(false));

      await expect(
        firstValueFrom(autofillSettingsService.httpAuthenticationAvailable$),
      ).resolves.toBe(true);
    });

    it("emits false when the feature flag is off", async () => {
      featureFlag$.next(false);

      await expect(
        firstValueFrom(autofillSettingsService.httpAuthenticationAvailable$),
      ).resolves.toBe(false);
    });

    it("emits false when there is no active user", async () => {
      await accountService.switchAccount(null);

      await expect(
        firstValueFrom(autofillSettingsService.httpAuthenticationAvailable$),
      ).resolves.toBe(false);
    });

    it("follows a change of active user", async () => {
      const { emissions, subscription } = collectEmissions(
        autofillSettingsService.httpAuthenticationAvailable$,
      );

      await accountService.switchAccount(null);
      await accountService.switchAccount(otherUserId);

      expect(emissions).toEqual([true, false, true]);
      subscription.unsubscribe();
    });

    it("updates when the feature flag changes", () => {
      const { emissions, subscription } = collectEmissions(
        autofillSettingsService.httpAuthenticationAvailable$,
      );

      featureFlag$.next(false);
      featureFlag$.next(true);

      expect(emissions).toEqual([true, false, true]);
      subscription.unsubscribe();
    });

    it("does not re-emit an unchanged value", async () => {
      const { emissions, subscription } = collectEmissions(
        autofillSettingsService.httpAuthenticationAvailable$,
      );

      featureFlag$.next(true);
      await accountService.switchAccount(otherUserId);

      expect(emissions).toEqual([true]);
      subscription.unsubscribe();
    });
  });
});
