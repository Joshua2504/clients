import { inject } from "@angular/core";
import { Router } from "@angular/router";

import { UserId } from "@bitwarden/common/types/guid";
import { ViewPasswordHistoryService } from "@bitwarden/common/vault/abstractions/view-password-history.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { itemAccountQueryParams } from "./vault-popup-item-account.service";

/**
 * This class handles the premium upgrade process for the browser extension.
 */
export class BrowserViewPasswordHistoryService implements ViewPasswordHistoryService {
  private router = inject(Router);

  /**
   * Navigates to the password history screen.
   * @param cipher The cipher whose password history is shown.
   * @param userId The account whose vault holds `cipher`. Defaults to the active account.
   */
  async viewPasswordHistory(cipher: CipherView, userId?: UserId) {
    await this.router.navigate(["/cipher-password-history"], {
      queryParams: { cipherId: cipher.id, ...itemAccountQueryParams(userId) },
    });
  }
}
