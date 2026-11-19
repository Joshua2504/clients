import { AccountCipherRef } from "../../../autofill/types/account-cipher";
import { UserId } from "../../../types/guid";

/**
 * Parameters used to ask the user to confirm the creation of a new credential.
 */
export interface NewCredentialParams {
  /**
   * The name of the credential.
   */
  credentialName: string;

  /**
   * The name of the user.
   */
  userName: string;

  /**
   * The userhandle (userid) of the user.
   */
  userHandle: string;

  /**
   * Whether or not the user must be verified before completing the operation.
   */
  userVerification: boolean;
  /**
   * The relying party ID is usually the URL
   */
  rpId: string;

  /**
   * The accounts the credential may be saved to, the default first. A user interface that lets
   * the user choose offers exactly these and returns the choice as `userId`. A user interface
   * that ignores this saves to the active account.
   */
  userIds?: UserId[];

  /**
   * The accounts that could receive the credential but are locked. See
   * {@link Fido2RetryAnswer}.
   */
  lockedUserIds?: UserId[];
}

/**
 * The answer of a user interface in which the user unlocked an account instead of answering.
 *
 * A request names the accounts that are logged in and would serve it, but are locked
 * (`lockedUserIds`). A user interface may offer to unlock them. When the user unlocked one, the
 * user interface answers with `retry`, and the authenticator runs the request again from the
 * search of the vaults and asks anew, in the same session. A user interface that ignores
 * `lockedUserIds` never answers with it.
 */
export interface Fido2RetryAnswer {
  retry?: boolean;
}

/**
 * Parameters used to ask the user to pick a credential from a list of existing credentials.
 */
export interface PickCredentialParams {
  /**
   * The IDs of the credentials that the user can pick from.
   */
  cipherIds: string[];

  /**
   * The same credentials as {@link cipherIds}, in the same order, each with the account whose
   * vault holds it. A cipher id alone does not identify the account: an item shared through an
   * organization has the same id in every member's vault.
   */
  cipherRefs?: AccountCipherRef[];

  /**
   * The accounts that could hold further credentials but are locked. See
   * {@link Fido2RetryAnswer}.
   */
  lockedUserIds?: UserId[];

  /**
   * Whether or not the user must be verified before completing the operation.
   */
  userVerification: boolean;

  /**
   * Bypass the UI and assume that the user has already interacted with the authenticator.
   */
  assumeUserPresence?: boolean;

  /**
   * Identifies whether a cipher requires a master password reprompt when getting a credential.
   */
  masterPasswordRepromptRequired?: boolean;
}

/**
 * This service is used to provide a user interface with which the user can control FIDO2 operations.
 * It acts as a way to remote control the user interface from the background script.
 *
 * The service is session based and is intended to be used by the FIDO2 authenticator to open a window,
 * and then use this window to ask the user for input and/or display messages to the user.
 */
export abstract class Fido2UserInterfaceService<ParentWindowReference> {
  /**
   * Creates a new session.
   * Note: This will not necessarily open a window until it is needed to request something from the user.
   *
   * @param fallbackSupported Whether or not the browser natively supports WebAuthn.
   * @param abortController An abort controller that can be used to cancel/close the session.
   */
  abstract newSession(
    fallbackSupported: boolean,
    window: ParentWindowReference,
    abortController?: AbortController,
  ): Promise<Fido2UserInterfaceSession>;
}

export abstract class Fido2UserInterfaceSession {
  /**
   * Ask the user to pick a credential from a list of existing credentials.
   *
   * @param params The parameters to use when asking the user to pick a credential.
   * @param abortController An abort controller that can be used to cancel/close the session.
   * @returns The ID of the cipher that contains the credentials the user picked. If not cipher was picked, return cipherId = undefined to to let the authenticator throw the error.
   * `userId` is the account of the picked cipher, as named in {@link PickCredentialParams.cipherRefs}.
   * It is required when the credentials offered belong to more than one account; the authenticator
   * rejects an answer that does not name one of the offered credentials. `userVerified` must be
   * the result of verifying the user of that account. With `retry`, nothing was picked: see
   * {@link Fido2RetryAnswer}.
   */
  abstract pickCredential(
    params: PickCredentialParams,
  ): Promise<
    { cipherId: string | undefined; userVerified: boolean; userId?: UserId } & Fido2RetryAnswer
  >;

  /**
   * Ask the user to confirm the creation of a new credential.
   *
   * @param params The parameters to use when asking the user to confirm the creation of a new credential.
   * @param abortController An abort controller that can be used to cancel/close the session.
   * @returns The ID of the cipher where the new credential should be saved. `userId` is the
   * account whose vault holds that cipher, one of {@link NewCredentialParams.userIds}; when it is
   * left out, the cipher is looked up in the active account. `userVerified` must be the result
   * of verifying the user of that account. With `retry`, nothing was confirmed: see
   * {@link Fido2RetryAnswer}.
   */
  abstract confirmNewCredential(
    params: NewCredentialParams,
  ): Promise<{ cipherId?: string; userVerified: boolean; userId?: UserId } & Fido2RetryAnswer>;

  /**
   * Make sure that the vault is unlocked.
   * This will open a window and ask the user to login or unlock the vault if necessary.
   */
  abstract ensureUnlockedVault(): Promise<void>;

  /**
   * Inform the user that the operation was cancelled because their vault contains excluded credentials.
   *
   * @param existingCipherIds The IDs of the excluded credentials.
   * @param existingCipherRefs The same credentials, in the same order, each with the account
   * whose vault holds it.
   */
  abstract informExcludedCredential(
    existingCipherIds: string[],
    existingCipherRefs?: AccountCipherRef[],
  ): Promise<void>;

  /**
   * Inform the user that the operation was cancelled because their vault does not contain any useable credentials.
   *
   * @param options.lockedUserIds The accounts that could hold a credential but are locked.
   * @returns Nothing when the user was informed. `retry` when the user unlocked one of
   * `lockedUserIds` instead: see {@link Fido2RetryAnswer}.
   */
  abstract informCredentialNotFound(
    abortController?: AbortController,
    options?: { lockedUserIds?: UserId[] },
  ): Promise<void | Fido2RetryAnswer>;

  /**
   * Close the session, including any windows that may be open.
   */
  abstract close(): void;
}
