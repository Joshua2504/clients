import { inject, Injectable, Injector } from "@angular/core";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";

import { SHARE_ITEM_PRESENTER, ShareItemPresenter } from "../tokens/share-item-presenter.token";
import {
  SHARE_PASSWORD_REPROMPT,
  SharePasswordReprompt,
} from "../tokens/share-password-reprompt.token";

/** How a share entry point was reached, which decides whether re-prompt is owed. */
export interface ShareItemOptions {
  /**
   * Whether the user has already verified their identity to reach this entry point — true for an
   * entry point inside an item's dialog, which cannot be opened without passing re-prompt. Skips
   * asking a second time.
   */
  alreadyVerified?: boolean;
  /**
   * The account whose vault holds the item. The re-prompt asks for its master password and the
   * sharing surface shares from it. Defaults to the active account.
   */
  userId?: UserId;
}

/**
 * Starts the share flow for a vault item.
 *
 * Owns the part of the flow every client shares — master-password re-prompt — and hands off to the
 * client's sharing surface, which decides what it needs of the item. See
 * {@link SHARE_ITEM_PRESENTER}.
 *
 * Share entry points call this so the flow stays identical wherever it is triggered from, and so
 * the Vault components hosting those entry points carry none of it.
 */
@Injectable({ providedIn: "root" })
export class ShareItemService {
  private injector = inject(Injector);

  /**
   * Re-prompts if the item requires it, then presents the client's sharing surface. Does nothing
   * if the user fails or dismisses the re-prompt.
   */
  async share(cipher: CipherViewLike, options: ShareItemOptions = {}): Promise<void> {
    // Resolved here rather than in fields so that merely rendering a share entry point does not
    // require these tokens — a client that forgot to provide one fails when sharing is attempted,
    // not when the vault list paints. The explicit type arguments keep `SafeInjectionToken`'s
    // tagged generic from widening in consuming projects.
    const presenter = this.injector.get<ShareItemPresenter>(SHARE_ITEM_PRESENTER);

    if (!options.alreadyVerified) {
      const passwordReprompt = this.injector.get<SharePasswordReprompt>(SHARE_PASSWORD_REPROMPT);

      const passed =
        options.userId == null
          ? await passwordReprompt.passwordRepromptCheck(cipher)
          : await passwordReprompt.passwordRepromptCheck(cipher, options.userId);
      if (!passed) {
        return;
      }
    }

    if (options.userId == null) {
      await presenter.present(cipher);
    } else {
      await presenter.present(cipher, options.userId);
    }
  }
}
