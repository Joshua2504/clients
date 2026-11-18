import { UserId } from "../../types/guid";
import { CipherView } from "../../vault/models/view/cipher.view";

/**
 * A cipher together with the account whose vault it was read from.
 *
 * Autofill that serves several accounts passes this pair instead of a bare cipher. Every effect
 * of using the cipher runs for `userId`: premium checks, last-used updates, event collection,
 * policies, password reprompt and saves. A cipher id does not identify the account: an item
 * shared through an organization has the same id in every member's vault.
 */
export type AccountCipher<C = CipherView> = {
  readonly userId: UserId;
  readonly cipher: C;
};

/**
 * Names a cipher in an account's vault without carrying vault data. Use it wherever a cipher is
 * referenced across a message boundary or held past the lookup that produced it.
 */
export type AccountCipherRef = {
  readonly userId: UserId;
  readonly cipherId: string;
};

/** The reference that names `accountCipher`. */
export function accountCipherRef(accountCipher: AccountCipher<{ id: string }>): AccountCipherRef {
  return { userId: accountCipher.userId, cipherId: accountCipher.cipher.id };
}

/** A string that is equal for two references exactly when they name the same cipher. */
export function accountCipherKey(ref: AccountCipherRef): string {
  return `${ref.userId}:${ref.cipherId}`;
}
