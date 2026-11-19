import { inject, Injectable } from "@angular/core";
import { Router } from "@angular/router";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { ShareItemPresenter } from "@bitwarden/tools-share";

import { itemAccountQueryParams } from "../../../vault/popup/services/vault-popup-item-account.service";

/**
 * Presents sharing on the extension's own page. The popup has no room for a drawer or a dialog
 * over the item, so it navigates instead — see the `share-item` route.
 *
 * The route loads the item itself, so this needs nothing but the id and deliberately does not
 * decrypt the item first. An item of an account other than the active one carries its account in
 * the route's `userId`, and the page then shares from that account alone.
 */
@Injectable()
export class BrowserShareItemPresenter implements ShareItemPresenter {
  private router = inject(Router);

  async present(cipher: CipherViewLike, userId?: UserId): Promise<void> {
    await this.router.navigate(["/share-item"], {
      queryParams: { cipherId: cipher.id, ...itemAccountQueryParams(userId) },
    });
  }
}
