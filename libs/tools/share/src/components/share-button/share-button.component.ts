import { ChangeDetectionStrategy, Component, inject, input } from "@angular/core";
import { toObservable, toSignal } from "@angular/core/rxjs-interop";
import { combineLatest, switchMap } from "rxjs";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { ButtonModule, DialogRef } from "@bitwarden/components";
import { I18nPipe } from "@bitwarden/ui-common";

import { ShareItemService } from "../../services/share-item.service";
import { ShareLinkService } from "../../services/share-link.service";

/**
 * Share entry point for a single vault item, rendered as a button.
 *
 * Drop it wherever an item is on screen and it decides the rest for itself — whether the item can
 * be shared at all, what the button says, and what happens on click. It renders nothing when the
 * item cannot be shared, so hosts need no surrounding condition.
 */
@Component({
  selector: "app-share-button",
  templateUrl: "./share-button.component.html",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, I18nPipe],
  // Hosts previously placed the button element itself. A custom element defaults to `inline`, so
  // without this the wrapper would change how the block-level button lays out.
  host: { class: "tw-block" },
})
export class ShareButtonComponent {
  /** The item to share. */
  readonly cipher = input.required<CipherViewLike>();
  /**
   * The account whose vault holds the item. Whether it can be shared, the re-prompt and the Send
   * are then that account's. Defaults to the active account.
   */
  readonly userId = input<UserId | undefined>(undefined);
  /** Whether to skip the master password reprompt when opening the share form */
  readonly skipPasswordPrompt = input<boolean>(false);

  private readonly shareLinkService = inject(ShareLinkService);
  private readonly shareItemService = inject(ShareItemService);

  /** The dialog this button sits in, when it sits in one. */
  private readonly hostDialog = inject(DialogRef, { optional: true });

  protected readonly canShare = toSignal(
    combineLatest([toObservable(this.cipher), toObservable(this.userId)]).pipe(
      switchMap(([cipher, userId]) =>
        userId == null
          ? this.shareLinkService.cipherCanBeShared$(cipher)
          : this.shareLinkService.cipherCanBeShared$(cipher, userId),
      ),
    ),
    { initialValue: false },
  );

  protected async share(): Promise<void> {
    const userId = this.userId();
    await this.shareItemService.share(this.cipher(), {
      alreadyVerified: this.skipPasswordPrompt() || this.hostDialog != null,
      ...(userId == null ? {} : { userId }),
    });
    await this.hostDialog?.close();
  }
}
