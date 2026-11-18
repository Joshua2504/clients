import { firstValueFrom, map, merge, Observable, of, switchMap } from "rxjs";

import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { AutofillSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/autofill-settings.service";
import {
  AccountCipher,
  accountCipherRef,
  AccountCipherRef,
} from "@bitwarden/common/autofill/types/account-cipher";
import { UriMatchStrategySetting } from "@bitwarden/common/models/domain/domain-service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { CipherUse, FillCipherPolicy, SaveCandidate } from "./abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "./abstractions/multi-account-fill-cipher-policy";

/** How long a rotation keeps its order after it was last read. Matches `SortedCiphersCache`. */
export const ROTATION_TTL_MS = 3000;

const CARD_ROTATION_KEY = "cardCiphers";
const IDENTITY_ROTATION_KEY = "identityCiphers";

/**
 * One keyboard shortcut rotation over several accounts. Holds references only, so no decrypted
 * cipher outlives the lookup that read it.
 */
type Rotation = {
  /** The accounts the order was built for. A different set of accounts rebuilds the order. */
  userIds: string;
  refs: AccountCipherRef[];
  /** Position of the cipher the rotation last moved to, -1 before the first move. */
  index: number;
  expiresAt: number;
};

/**
 * Asks a {@link FillCipherPolicy} for each account Autofill serves and merges the answers.
 *
 * While Autofill serves a single account, every lookup is that account's lookup on the wrapped
 * policy, unchanged. With several accounts, selection and rotation run here, over one list for all
 * accounts: the wrapped policy's own selection keeps one rotation per URL, not per account.
 */
export class DefaultMultiAccountFillCipherPolicy implements MultiAccountFillCipherPolicy {
  readonly changed$: Observable<void>;

  private readonly rotations = new Map<string, Rotation>();

  constructor(
    private readonly fillCipherPolicy: FillCipherPolicy,
    private readonly autofillAccountsService: AutofillAccountsService,
    private readonly autofillSettingsService: Pick<
      AutofillSettingsServiceAbstraction,
      "autofillOnPageLoadDefaultFor$"
    >,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.changed$ = this.autofillAccountsService.autofillUserIds$.pipe(
      switchMap((userIds) =>
        merge(of(undefined), ...userIds.map((userId) => this.fillCipherPolicy.changed$(userId))),
      ),
      map((): void => undefined),
    );
  }

  ciphers(use: CipherUse): Promise<AccountCipher[]> {
    return this.perAccount((userId) => this.fillCipherPolicy.ciphers(userId, use));
  }

  async ciphersForRefs(refs: AccountCipherRef[], use: CipherUse): Promise<AccountCipher[]> {
    const found = new Map<UserId, Map<string, CipherView>>();
    for (const userId of await this.userIds()) {
      const ids = refs.filter((ref) => ref.userId === userId).map((ref) => ref.cipherId);
      if (ids.length === 0) {
        continue;
      }
      const ciphers = await this.fillCipherPolicy.ciphersForIds(userId, ids, use);
      found.set(userId, new Map(ciphers.map((cipher) => [cipher.id, cipher])));
    }

    return refs.flatMap((ref) => {
      const cipher = found.get(ref.userId)?.get(ref.cipherId);
      return cipher == null ? [] : [{ userId: ref.userId, cipher }];
    });
  }

  ciphersForUrl(
    url: string,
    use: CipherUse,
    options?: { includeOtherTypes?: CipherType[]; defaultMatch?: UriMatchStrategySetting },
  ): Promise<AccountCipher[]> {
    return this.perAccount((userId) =>
      this.fillCipherPolicy.ciphersForUrl(url, userId, use, options),
    );
  }

  async lastLaunchedForUrl(
    url: string,
    autofillOnPageLoad: boolean,
  ): Promise<AccountCipher | undefined> {
    const userIds = await this.userIds();
    if (userIds.length === 1) {
      return attribute(
        userIds[0],
        await this.fillCipherPolicy.lastLaunchedForUrl(url, userIds[0], autofillOnPageLoad),
      );
    }

    const launched = (await this.automaticFillCiphers(url, autofillOnPageLoad)).filter(
      ({ cipher }) => cipher.localData?.lastLaunched,
    );
    return launched.sort(
      (a, b) => (b.cipher.localData?.lastLaunched ?? 0) - (a.cipher.localData?.lastLaunched ?? 0),
    )[0];
  }

  async lastUsedForUrl(
    url: string,
    autofillOnPageLoad: boolean,
  ): Promise<AccountCipher | undefined> {
    const userIds = await this.userIds();
    if (userIds.length === 1) {
      return attribute(
        userIds[0],
        await this.fillCipherPolicy.lastUsedForUrl(url, userIds[0], autofillOnPageLoad),
      );
    }

    return (await this.automaticFillCiphers(url, autofillOnPageLoad)).sort(byLastUsed)[0];
  }

  async nextCipherForUrl(url: string): Promise<AccountCipher | undefined> {
    return this.next(
      url,
      (userId) => this.fillCipherPolicy.nextCipherForUrl(url, userId),
      () => this.ciphersForUrl(url, CipherUse.UserFill),
    );
  }

  nextCardCipher(): Promise<AccountCipher | undefined> {
    return this.next(
      CARD_ROTATION_KEY,
      (userId) => this.fillCipherPolicy.nextCardCipher(userId),
      () => this.ciphersOfType(CipherType.Card),
    );
  }

  nextIdentityCipher(): Promise<AccountCipher | undefined> {
    return this.next(
      IDENTITY_ROTATION_KEY,
      (userId) => this.fillCipherPolicy.nextIdentityCipher(userId),
      () => this.ciphersOfType(CipherType.Identity),
    );
  }

  advanceRotation(key: string): void {
    const rotation = this.rotations.get(key);
    if (rotation == null) {
      // The rotation was read for a single account, so the wrapped policy holds it.
      this.fillCipherPolicy.advanceRotation(key);
      return;
    }
    rotation.index = nextIndex(rotation);
  }

  canOfferSave(form: SaveCandidate, userId: UserId): Promise<boolean> {
    return this.fillCipherPolicy.canOfferSave(form, userId);
  }

  private userIds(): Promise<UserId[]> {
    return firstValueFrom(this.autofillAccountsService.autofillUserIds$);
  }

  private async perAccount(lookup: (userId: UserId) => Promise<CipherView[]>) {
    const result: AccountCipher[] = [];
    for (const userId of await this.userIds()) {
      for (const cipher of await lookup(userId)) {
        result.push({ userId, cipher });
      }
    }
    return result;
  }

  /**
   * The logins an automatic fill may choose from. For a page-load fill, a login qualifies by its
   * own page-load setting, or by its own account's default when it has none.
   */
  private async automaticFillCiphers(
    url: string,
    autofillOnPageLoad: boolean,
  ): Promise<AccountCipher[]> {
    const ciphers = await this.ciphersForUrl(url, CipherUse.AutomaticFill);
    if (!autofillOnPageLoad) {
      return ciphers;
    }

    const defaults = new Map<UserId, boolean>();
    const result: AccountCipher[] = [];
    for (const accountCipher of ciphers) {
      const { userId, cipher } = accountCipher;
      if (!defaults.has(userId)) {
        defaults.set(
          userId,
          await firstValueFrom(this.autofillSettingsService.autofillOnPageLoadDefaultFor$(userId)),
        );
      }
      const setting = cipher.login?.autofillOnPageLoad;
      if (setting || (setting == null && defaults.get(userId) !== false)) {
        result.push(accountCipher);
      }
    }
    return result;
  }

  private async ciphersOfType(type: CipherType): Promise<AccountCipher[]> {
    const ciphers = await this.ciphersForUrl("", CipherUse.UserFill, { includeOtherTypes: [type] });
    return ciphers.filter(({ cipher }) => cipher.type === type);
  }

  /**
   * Reads the next cipher of the rotation for `key`. A single account's rotation is the wrapped
   * policy's. Several accounts share one rotation, most recently used first, which keeps its
   * order for {@link ROTATION_TTL_MS} after it was last read.
   */
  private async next(
    key: string,
    single: (userId: UserId) => Promise<CipherView | undefined>,
    candidates: () => Promise<AccountCipher[]>,
  ): Promise<AccountCipher | undefined> {
    const userIds = await this.userIds();
    if (userIds.length <= 1) {
      this.rotations.delete(key);
      return userIds.length === 0 ? undefined : attribute(userIds[0], await single(userIds[0]));
    }

    const accounts = userIds.join();
    const cached = this.rotations.get(key);
    if (cached != null && cached.userIds === accounts && cached.expiresAt > this.now()) {
      cached.expiresAt = this.now() + ROTATION_TTL_MS;
      const [cipher] = await this.ciphersForRefs(
        [cached.refs[nextIndex(cached)]],
        CipherUse.UserFill,
      );
      if (cipher != null) {
        return cipher;
      }
      // The cipher is gone, so the order is stale.
    }

    this.dropExpiredRotations();
    const ordered = (await candidates()).sort(byLastUsed);
    if (ordered.length === 0) {
      this.rotations.delete(key);
      return undefined;
    }
    this.rotations.set(key, {
      userIds: accounts,
      refs: ordered.map(accountCipherRef),
      index: -1,
      expiresAt: this.now() + ROTATION_TTL_MS,
    });
    return ordered[0];
  }

  private dropExpiredRotations() {
    for (const [key, rotation] of this.rotations) {
      if (rotation.expiresAt <= this.now()) {
        this.rotations.delete(key);
      }
    }
  }
}

function attribute(userId: UserId, cipher: CipherView | undefined): AccountCipher | undefined {
  return cipher == null ? undefined : { userId, cipher };
}

function nextIndex(rotation: Rotation): number {
  return (rotation.index + 1) % rotation.refs.length;
}

/**
 * Most recently used first, never used last. `Array.prototype.sort` is stable, so ciphers that
 * tie keep their order: the active account's first.
 */
function byLastUsed(a: AccountCipher, b: AccountCipher): number {
  const aLastUsed = a.cipher.localData?.lastUsedDate || 0;
  const bLastUsed = b.cipher.localData?.lastUsedDate || 0;
  return bLastUsed - aLastUsed;
}
