import { InputSignal, Type } from "@angular/core";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { SafeInjectionToken } from "@bitwarden/ui-common";

export type VaultRowIcon = Type<{
  cipher: InputSignal<CipherViewLike | null>;
  userId?: InputSignal<UserId | undefined>;
}>;

/**
 * Optional icon after the name in a popup vault row, such as a status icon for an item another
 * feature governs. Rendered once per row with `cipher` as its input; it renders nothing for a
 * row it has no icon for. Unprovided, rows show no extra icon.
 *
 * A row of an autofill account other than the active one also sets `userId`, the account whose
 * vault holds the cipher: a cipher id does not identify an account. A component that declares
 * no `userId` input can only answer for the active account and is not rendered on such a row.
 */
export const VAULT_ROW_ICON = new SafeInjectionToken<VaultRowIcon>("VaultRowIcon");
