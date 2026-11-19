import { UserId } from "@bitwarden/common/types/guid";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { SafeInjectionToken } from "@bitwarden/ui-common";

/**
 * Runs the client's master-password re-prompt for a cipher, returning whether the caller may
 * proceed. Implementations return `true` for ciphers that are not re-prompt protected.
 *
 * Re-prompt lives in the Vault layer, which already depends on this library for the share entry
 * points — so it is reached through a token rather than imported, to keep the two packages from
 * depending on each other. Clients that render a share entry point must provide it; the share
 * flow deliberately fails loudly rather than sharing a protected item without verification.
 *
 * `userId` is the account whose vault holds the cipher: its master password is the one asked for.
 * Without it the cipher is the active account's.
 */
export interface SharePasswordReprompt {
  passwordRepromptCheck(cipher: CipherViewLike, userId?: UserId): Promise<boolean>;
}

export const SHARE_PASSWORD_REPROMPT = new SafeInjectionToken<SharePasswordReprompt>(
  "SHARE_PASSWORD_REPROMPT",
);
