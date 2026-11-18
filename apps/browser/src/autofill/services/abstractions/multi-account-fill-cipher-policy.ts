import { Observable } from "rxjs";

import { AccountCipher, AccountCipherRef } from "@bitwarden/common/autofill/types/account-cipher";
import { UriMatchStrategySetting } from "@bitwarden/common/models/domain/domain-service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherType } from "@bitwarden/common/vault/enums";

import { CipherUse, SaveCandidate } from "./fill-cipher-policy";

/**
 * The ciphers Autofill may use, across every account Autofill serves
 * (`AutofillAccountsService.autofillUserIds$`). Each cipher comes with the account that owns it.
 *
 * It asks a {@link FillCipherPolicy} per account, so what an account contributes is decided
 * there. No lookup takes an account: the accounts are read when the lookup runs, and an account
 * that has locked or logged out by then contributes nothing.
 */
export abstract class MultiAccountFillCipherPolicy {
  /**
   * Emits when a lookup result can change: an account joins or leaves the accounts Autofill
   * serves, or the ciphers of one of them change. A cached result must recompute.
   */
  abstract readonly changed$: Observable<void>;
  /** Every account's ciphers, account by account in `autofillUserIds$` order. */
  abstract ciphers(use: CipherUse): Promise<AccountCipher[]>;
  /**
   * The ciphers named by `refs`, in the order of `refs`. Leaves out a cipher that no longer
   * exists and a cipher of an account Autofill does not serve at the time of the call.
   */
  abstract ciphersForRefs(refs: AccountCipherRef[], use: CipherUse): Promise<AccountCipher[]>;
  /**
   * Every account's ciphers for `url`, account by account in `autofillUserIds$` order. Within an
   * account, the order is the one {@link FillCipherPolicy.ciphersForUrl} returns.
   */
  abstract ciphersForUrl(
    url: string,
    use: CipherUse,
    options?: { includeOtherTypes?: CipherType[]; defaultMatch?: UriMatchStrategySetting },
  ): Promise<AccountCipher[]>;
  /** For automatic fills. The most recently launched cipher for `url` in any account. */
  abstract lastLaunchedForUrl(
    url: string,
    autofillOnPageLoad: boolean,
  ): Promise<AccountCipher | undefined>;
  /** For automatic fills. The most recently used cipher for `url` in any account. */
  abstract lastUsedForUrl(
    url: string,
    autofillOnPageLoad: boolean,
  ): Promise<AccountCipher | undefined>;
  /**
   * The next cipher in the keyboard shortcut rotation. Always a user fill. The rotation walks
   * one list for all accounts, most recently used first.
   */
  abstract nextCipherForUrl(url: string): Promise<AccountCipher | undefined>;
  /** The next card in the card keyboard shortcut rotation. Always a user fill. */
  abstract nextCardCipher(): Promise<AccountCipher | undefined>;
  /** The next identity in the identity keyboard shortcut rotation. Always a user fill. */
  abstract nextIdentityCipher(): Promise<AccountCipher | undefined>;
  /**
   * Moves the rotation for `key` to the cipher the last `next…` lookup returned. `key` is the URL
   * for logins, `"cardCiphers"` for cards and `"identityCiphers"` for identities.
   */
  abstract advanceRotation(key: string): void;
  /**
   * False when Autofill must not copy this form into a new or updated cipher of `userId`. Call it
   * before a save prompt, before a save, and before a draft that takes values from the page.
   */
  abstract canOfferSave(form: SaveCandidate, userId: UserId): Promise<boolean>;
}
