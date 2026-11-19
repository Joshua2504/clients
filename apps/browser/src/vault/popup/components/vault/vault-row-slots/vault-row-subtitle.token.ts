import { Observable } from "rxjs";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { SafeInjectionToken } from "@bitwarden/ui-common";

/** Replaces a popup vault row's subtitle for the items the provider governs. */
export interface VaultRowSubtitle {
  /**
   * The already-translated subtitle for `cipher`, or `null` for the row's default subtitle. Live:
   * the row re-renders on each emission.
   *
   * @param userId The account whose vault holds `cipher`, given for a row of an account other
   * than the active one. The answer must then be that account's: a cipher id does not identify
   * an account. Without it the cipher is the active account's.
   */
  subtitle$(cipher: CipherViewLike, userId?: UserId): Observable<string | null>;
}

/** Optional subtitle provider for popup vault rows. Unprovided, rows show their default subtitle. */
export const VAULT_ROW_SUBTITLE = new SafeInjectionToken<VaultRowSubtitle>("VaultRowSubtitle");
