import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, of, Subject } from "rxjs";

import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { AutofillSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/autofill-settings.service";
import { AccountCipher } from "@bitwarden/common/autofill/types/account-cipher";
import { UriMatchStrategy } from "@bitwarden/common/models/domain/domain-service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { LoginView } from "@bitwarden/common/vault/models/view/login.view";

import { CipherUse, FillCipherPolicy } from "./abstractions/fill-cipher-policy";
import {
  DefaultMultiAccountFillCipherPolicy,
  ROTATION_TTL_MS,
} from "./default-multi-account-fill-cipher-policy";

describe("DefaultMultiAccountFillCipherPolicy", () => {
  const active = "active-user" as UserId;
  const other = "other-user" as UserId;
  const url = "https://example.com";

  let inner: MockProxy<FillCipherPolicy>;
  let autofillUserIds$: BehaviorSubject<UserId[]>;
  let pageLoadDefaults: Map<UserId, boolean>;
  let now: number;
  let policy: DefaultMultiAccountFillCipherPolicy;

  /** The ciphers each account's vault holds for `url`, as the wrapped policy returns them. */
  let vaults: Map<UserId, CipherView[]>;

  const login = (
    id: string,
    data: { lastUsedDate?: number; lastLaunched?: number; autofillOnPageLoad?: boolean } = {},
  ) => {
    const cipher = Object.assign(new CipherView(), { id, type: CipherType.Login });
    cipher.login = Object.assign(new LoginView(), {
      autofillOnPageLoad: data.autofillOnPageLoad,
    });
    cipher.localData = { lastUsedDate: data.lastUsedDate, lastLaunched: data.lastLaunched };
    return cipher;
  };

  const ofType = (id: string, type: CipherType, lastUsedDate?: number) =>
    Object.assign(new CipherView(), { id, type, localData: { lastUsedDate } });

  const ids = (ciphers: (AccountCipher | undefined)[]) =>
    ciphers.map((entry) => (entry == null ? undefined : `${entry.userId}/${entry.cipher.id}`));

  beforeEach(() => {
    now = 1_000_000;
    vaults = new Map();
    pageLoadDefaults = new Map();
    autofillUserIds$ = new BehaviorSubject<UserId[]>([active, other]);

    inner = mock<FillCipherPolicy>();
    inner.ciphersForUrl.mockImplementation(async (_url, userId) => [...(vaults.get(userId) ?? [])]);
    inner.ciphersForIds.mockImplementation(async (userId, cipherIds) =>
      (vaults.get(userId) ?? []).filter((cipher) => cipherIds.includes(cipher.id)),
    );
    inner.changed$.mockReturnValue(new Subject<void>());

    const accounts = mock<AutofillAccountsService>();
    Object.defineProperty(accounts, "autofillUserIds$", { value: autofillUserIds$ });
    const settings = mock<AutofillSettingsServiceAbstraction>();
    settings.autofillOnPageLoadDefaultFor$.mockImplementation((userId) =>
      of(pageLoadDefaults.get(userId) ?? true),
    );

    policy = new DefaultMultiAccountFillCipherPolicy(inner, accounts, settings, () => now);
  });

  describe("with a single account", () => {
    beforeEach(() => autofillUserIds$.next([active]));

    it("returns that account's lookup from the wrapped policy, in its order", async () => {
      const options = {
        includeOtherTypes: [CipherType.Card],
        defaultMatch: UriMatchStrategy.Host,
      };
      vaults.set(active, [login("b", { lastUsedDate: 1 }), login("a", { lastUsedDate: 9 })]);

      const result = await policy.ciphersForUrl(url, CipherUse.UserFill, options);

      expect(ids(result)).toEqual(["active-user/b", "active-user/a"]);
      expect(inner.ciphersForUrl).toHaveBeenCalledTimes(1);
      expect(inner.ciphersForUrl).toHaveBeenCalledWith(url, active, CipherUse.UserFill, options);
    });

    it("leaves selection and rotation to the wrapped policy", async () => {
      const cipher = login("a");
      inner.nextCipherForUrl.mockResolvedValue(cipher);
      inner.lastUsedForUrl.mockResolvedValue(cipher);
      inner.lastLaunchedForUrl.mockResolvedValue(cipher);
      inner.nextCardCipher.mockResolvedValue(cipher);
      inner.nextIdentityCipher.mockResolvedValue(cipher);
      const expected = { userId: active, cipher };

      await expect(policy.nextCipherForUrl(url)).resolves.toEqual(expected);
      await expect(policy.lastUsedForUrl(url, true)).resolves.toEqual(expected);
      await expect(policy.lastLaunchedForUrl(url, false)).resolves.toEqual(expected);
      await expect(policy.nextCardCipher()).resolves.toEqual(expected);
      await expect(policy.nextIdentityCipher()).resolves.toEqual(expected);
      policy.advanceRotation(url);

      expect(inner.nextCipherForUrl).toHaveBeenCalledWith(url, active);
      expect(inner.lastUsedForUrl).toHaveBeenCalledWith(url, active, true);
      expect(inner.lastLaunchedForUrl).toHaveBeenCalledWith(url, active, false);
      expect(inner.nextCardCipher).toHaveBeenCalledWith(active);
      expect(inner.nextIdentityCipher).toHaveBeenCalledWith(active);
      expect(inner.advanceRotation).toHaveBeenCalledWith(url);
      expect(inner.ciphersForUrl).not.toHaveBeenCalled();
    });

    it("returns undefined when the wrapped policy selects nothing", async () => {
      inner.nextCipherForUrl.mockResolvedValue(undefined);

      await expect(policy.nextCipherForUrl(url)).resolves.toBeUndefined();
    });
  });

  describe("with no account", () => {
    beforeEach(() => autofillUserIds$.next([]));

    it("finds nothing and asks the wrapped policy nothing", async () => {
      await expect(policy.ciphers(CipherUse.Badge)).resolves.toEqual([]);
      await expect(policy.ciphersForUrl(url, CipherUse.UserFill)).resolves.toEqual([]);
      await expect(
        policy.ciphersForRefs([{ userId: active, cipherId: "a" }], CipherUse.UserFill),
      ).resolves.toEqual([]);
      await expect(policy.nextCipherForUrl(url)).resolves.toBeUndefined();
      await expect(policy.nextCardCipher()).resolves.toBeUndefined();
      await expect(policy.lastUsedForUrl(url, true)).resolves.toBeUndefined();
      await expect(policy.lastLaunchedForUrl(url, true)).resolves.toBeUndefined();

      expect(inner.ciphers).not.toHaveBeenCalled();
      expect(inner.ciphersForUrl).not.toHaveBeenCalled();
      expect(inner.ciphersForIds).not.toHaveBeenCalled();
      expect(inner.nextCipherForUrl).not.toHaveBeenCalled();
    });
  });

  describe("with several accounts", () => {
    it("returns every account's ciphers with their account, active account first", async () => {
      inner.ciphers.mockImplementation(async (userId) => vaults.get(userId) ?? []);
      vaults.set(active, [login("a"), login("shared")]);
      vaults.set(other, [login("shared"), login("b")]);

      const expected = ["active-user/a", "active-user/shared", "other-user/shared", "other-user/b"];
      expect(ids(await policy.ciphers(CipherUse.Badge))).toEqual(expected);
      expect(ids(await policy.ciphersForUrl(url, CipherUse.Badge))).toEqual(expected);
      expect(inner.ciphers).toHaveBeenCalledWith(active, CipherUse.Badge);
      expect(inner.ciphers).toHaveBeenCalledWith(other, CipherUse.Badge);
    });

    it("stops reading an account that left the accounts autofill serves", async () => {
      vaults.set(active, [login("a")]);
      vaults.set(other, [login("b")]);
      await policy.ciphersForUrl(url, CipherUse.UserFill);
      inner.ciphersForUrl.mockClear();

      autofillUserIds$.next([active]);

      expect(ids(await policy.ciphersForUrl(url, CipherUse.UserFill))).toEqual(["active-user/a"]);
      expect(inner.ciphersForUrl).toHaveBeenCalledTimes(1);
    });

    describe("ciphersForRefs", () => {
      beforeEach(() => {
        vaults.set(active, [login("a"), login("shared")]);
        vaults.set(other, [login("shared"), login("b")]);
      });

      it("reads each cipher from the account its reference names, in reference order", async () => {
        const result = await policy.ciphersForRefs(
          [
            { userId: other, cipherId: "shared" },
            { userId: active, cipherId: "a" },
            { userId: active, cipherId: "shared" },
          ],
          CipherUse.UserFill,
        );

        expect(ids(result)).toEqual(["other-user/shared", "active-user/a", "active-user/shared"]);
        expect(result[0].cipher).toBe(vaults.get(other)![0]);
        expect(result[2].cipher).toBe(vaults.get(active)![1]);
        expect(inner.ciphersForIds).toHaveBeenCalledWith(
          active,
          ["a", "shared"],
          CipherUse.UserFill,
        );
        expect(inner.ciphersForIds).toHaveBeenCalledWith(other, ["shared"], CipherUse.UserFill);
      });

      it("leaves out a cipher that is not in the named account", async () => {
        const result = await policy.ciphersForRefs(
          [
            { userId: active, cipherId: "b" },
            { userId: other, cipherId: "b" },
          ],
          CipherUse.UserFill,
        );

        expect(ids(result)).toEqual(["other-user/b"]);
      });

      it("leaves out a cipher of an account autofill no longer serves", async () => {
        autofillUserIds$.next([active]);

        const result = await policy.ciphersForRefs(
          [{ userId: other, cipherId: "b" }],
          CipherUse.UserFill,
        );

        expect(result).toEqual([]);
        expect(inner.ciphersForIds).not.toHaveBeenCalled();
      });
    });

    describe("nextCipherForUrl", () => {
      beforeEach(() => {
        vaults.set(active, [login("a-old", { lastUsedDate: 10 }), login("a-never")]);
        vaults.set(other, [login("o-new", { lastUsedDate: 30 }), login("o-never")]);
      });

      const walk = async (steps: number) => {
        const seen: (AccountCipher | undefined)[] = [];
        for (let step = 0; step < steps; step++) {
          seen.push(await policy.nextCipherForUrl(url));
          policy.advanceRotation(url);
        }
        return ids(seen);
      };

      it("rotates over one list for all accounts, most recently used first", async () => {
        expect(await walk(5)).toEqual([
          "other-user/o-new",
          "active-user/a-old",
          // Never used: the active account's before the other account's.
          "active-user/a-never",
          "other-user/o-never",
          "other-user/o-new",
        ]);
      });

      it("reads the candidates as a user fill and never the wrapped rotation", async () => {
        await walk(3);

        expect(inner.ciphersForUrl).toHaveBeenCalledWith(
          url,
          active,
          CipherUse.UserFill,
          undefined,
        );
        expect(inner.ciphersForUrl).toHaveBeenCalledWith(url, other, CipherUse.UserFill, undefined);
        expect(inner.nextCipherForUrl).not.toHaveBeenCalled();
        expect(inner.advanceRotation).not.toHaveBeenCalled();
      });

      it("returns the same cipher until the rotation advances", async () => {
        const first = await policy.nextCipherForUrl(url);
        const second = await policy.nextCipherForUrl(url);

        expect(ids([first, second])).toEqual(["other-user/o-new", "other-user/o-new"]);
      });

      it("keeps the order while a fill updates last-used dates", async () => {
        const seen = [await policy.nextCipherForUrl(url)];
        policy.advanceRotation(url);
        // The fill made the first cipher the most recently used one.
        vaults.get(other)![0].localData = { lastUsedDate: 99 };
        vaults.get(active)![1].localData = { lastUsedDate: 98 };

        seen.push(await policy.nextCipherForUrl(url));

        expect(ids(seen)).toEqual(["other-user/o-new", "active-user/a-old"]);
      });

      it("returns a fresh read of the cipher from its own account", async () => {
        await policy.nextCipherForUrl(url);
        policy.advanceRotation(url);
        inner.ciphersForIds.mockClear();

        const next = await policy.nextCipherForUrl(url);

        expect(next).toEqual({ userId: active, cipher: vaults.get(active)![0] });
        expect(inner.ciphersForIds).toHaveBeenCalledTimes(1);
        expect(inner.ciphersForIds).toHaveBeenCalledWith(active, ["a-old"], CipherUse.UserFill);
      });

      it("starts over once the rotation has not been read for its lifetime", async () => {
        await walk(2);
        now += ROTATION_TTL_MS;

        expect(await walk(1)).toEqual(["other-user/o-new"]);
      });

      it("keeps rotating while reads keep it alive", async () => {
        const seen: (string | undefined)[] = [];
        for (let step = 0; step < 3; step++) {
          seen.push(...(await walk(1)));
          now += ROTATION_TTL_MS - 1;
        }

        expect(seen).toEqual(["other-user/o-new", "active-user/a-old", "active-user/a-never"]);
      });

      it("starts over without an account that locked mid-rotation", async () => {
        await walk(1);

        autofillUserIds$.next([active, "third-user" as UserId]);

        expect(await walk(3)).toEqual([
          "active-user/a-old",
          "active-user/a-never",
          "active-user/a-old",
        ]);
        expect(inner.ciphersForIds).not.toHaveBeenCalledWith(
          other,
          expect.anything(),
          expect.anything(),
        );
      });

      it("hands the rotation back to the wrapped policy when one account remains", async () => {
        await walk(1);
        autofillUserIds$.next([active]);
        const cipher = login("a-old");
        inner.nextCipherForUrl.mockResolvedValue(cipher);

        await expect(policy.nextCipherForUrl(url)).resolves.toEqual({ userId: active, cipher });
        policy.advanceRotation(url);

        expect(inner.advanceRotation).toHaveBeenCalledWith(url);
      });

      it("starts over when the cipher it would return was deleted", async () => {
        await walk(1);
        vaults.set(active, [login("a-never")]);

        expect(await walk(1)).toEqual(["other-user/o-new"]);
      });

      it("returns undefined when no account has a cipher for the URL", async () => {
        vaults.clear();

        await expect(policy.nextCipherForUrl(url)).resolves.toBeUndefined();
      });

      it("keeps a rotation per URL", async () => {
        await walk(1);

        const elsewhere = await policy.nextCipherForUrl("https://elsewhere.example");

        expect(ids([elsewhere, await policy.nextCipherForUrl(url)])).toEqual([
          "other-user/o-new",
          "active-user/a-old",
        ]);
      });
    });

    describe.each([
      ["nextCardCipher", CipherType.Card, "cardCiphers"],
      ["nextIdentityCipher", CipherType.Identity, "identityCiphers"],
    ] as const)("%s", (method, type, rotationKey) => {
      it("rotates over that type in all accounts, most recently used first", async () => {
        vaults.set(active, [ofType("a-1", type, 5), login("a-login", { lastUsedDate: 50 })]);
        vaults.set(other, [ofType("o-1", type, 7), ofType("o-2", type)]);

        const seen: (AccountCipher | undefined)[] = [];
        for (let step = 0; step < 4; step++) {
          seen.push(await policy[method]());
          policy.advanceRotation(rotationKey);
        }

        expect(ids(seen)).toEqual([
          "other-user/o-1",
          "active-user/a-1",
          "other-user/o-2",
          "other-user/o-1",
        ]);
        expect(inner.ciphersForUrl).toHaveBeenCalledWith("", active, CipherUse.UserFill, {
          includeOtherTypes: [type],
        });
        expect(inner[method]).not.toHaveBeenCalled();
      });
    });

    describe("lastUsedForUrl", () => {
      it("returns the most recently used cipher of any account", async () => {
        vaults.set(active, [login("a", { lastUsedDate: 10 })]);
        vaults.set(other, [login("o", { lastUsedDate: 30 })]);

        expect(ids([await policy.lastUsedForUrl(url, false)])).toEqual(["other-user/o"]);
        expect(inner.ciphersForUrl).toHaveBeenCalledWith(
          url,
          other,
          CipherUse.AutomaticFill,
          undefined,
        );
        expect(inner.lastUsedForUrl).not.toHaveBeenCalled();
      });

      it("prefers the active account when no cipher was used", async () => {
        vaults.set(active, [login("a")]);
        vaults.set(other, [login("o")]);

        expect(ids([await policy.lastUsedForUrl(url, false)])).toEqual(["active-user/a"]);
      });

      it("applies each account's own page-load default to its own ciphers", async () => {
        pageLoadDefaults.set(active, true);
        pageLoadDefaults.set(other, false);
        vaults.set(active, [login("a", { lastUsedDate: 10 })]);
        vaults.set(other, [login("o", { lastUsedDate: 30 })]);

        expect(ids([await policy.lastUsedForUrl(url, true)])).toEqual(["active-user/a"]);
        expect(ids([await policy.lastUsedForUrl(url, false)])).toEqual(["other-user/o"]);
      });

      it("lets a cipher's own page-load setting override its account's default", async () => {
        pageLoadDefaults.set(active, true);
        pageLoadDefaults.set(other, false);
        vaults.set(active, [login("a", { lastUsedDate: 90, autofillOnPageLoad: false })]);
        vaults.set(other, [
          login("o-off", { lastUsedDate: 50 }),
          login("o-on", { lastUsedDate: 30, autofillOnPageLoad: true }),
        ]);

        expect(ids([await policy.lastUsedForUrl(url, true)])).toEqual(["other-user/o-on"]);
      });

      it("returns undefined when no cipher may fill on page load", async () => {
        pageLoadDefaults.set(active, false);
        pageLoadDefaults.set(other, false);
        vaults.set(active, [login("a")]);
        vaults.set(other, [login("o")]);

        await expect(policy.lastUsedForUrl(url, true)).resolves.toBeUndefined();
      });
    });

    describe("lastLaunchedForUrl", () => {
      it("returns the most recently launched cipher of any account", async () => {
        vaults.set(active, [login("a", { lastLaunched: 10, lastUsedDate: 99 })]);
        vaults.set(other, [login("o", { lastLaunched: 30 }), login("o-never")]);

        expect(ids([await policy.lastLaunchedForUrl(url, false)])).toEqual(["other-user/o"]);
        expect(inner.lastLaunchedForUrl).not.toHaveBeenCalled();
      });

      it("returns undefined when no cipher was launched", async () => {
        vaults.set(active, [login("a", { lastUsedDate: 10 })]);

        await expect(policy.lastLaunchedForUrl(url, false)).resolves.toBeUndefined();
      });

      it("applies each account's own page-load default", async () => {
        pageLoadDefaults.set(other, false);
        vaults.set(active, [login("a", { lastLaunched: 10 })]);
        vaults.set(other, [login("o", { lastLaunched: 30 })]);

        expect(ids([await policy.lastLaunchedForUrl(url, true)])).toEqual(["active-user/a"]);
      });
    });
  });

  describe("canOfferSave", () => {
    it("asks the wrapped policy for the given account", async () => {
      const form = { uri: url, username: "user" };
      inner.canOfferSave.mockResolvedValue(false);

      await expect(policy.canOfferSave(form, other)).resolves.toBe(false);
      expect(inner.canOfferSave).toHaveBeenCalledWith(form, other);
    });
  });

  describe("changed$", () => {
    let changes: Map<UserId, Subject<void>>;
    let emissions: number;

    beforeEach(() => {
      changes = new Map([
        [active, new Subject<void>()],
        [other, new Subject<void>()],
      ]);
      inner.changed$.mockImplementation((userId) => changes.get(userId)!);
      emissions = 0;
      policy.changed$.subscribe(() => emissions++);
    });

    it("emits on subscription", () => {
      expect(emissions).toBe(1);
    });

    it("emits when the ciphers of any served account change", () => {
      changes.get(active)!.next();
      changes.get(other)!.next();

      expect(emissions).toBe(3);
    });

    it("emits when the served accounts change and stops watching an account that left", () => {
      autofillUserIds$.next([active]);
      expect(emissions).toBe(2);

      changes.get(other)!.next();
      expect(emissions).toBe(2);
      expect(changes.get(other)!.observed).toBe(false);

      changes.get(active)!.next();
      expect(emissions).toBe(3);
    });
  });
});
