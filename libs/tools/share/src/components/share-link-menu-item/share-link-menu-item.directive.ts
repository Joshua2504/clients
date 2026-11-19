import {
  Directive,
  TemplateRef,
  ViewContainerRef,
  effect,
  inject,
  input,
  untracked,
} from "@angular/core";
import { toObservable, toSignal } from "@angular/core/rxjs-interop";
import { combineLatest, switchMap } from "rxjs";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";

import { ShareItemService } from "../../services/share-item.service";
import { ShareLinkService } from "../../services/share-link.service";

/** What the directive hands back to the item it stamps out. */
export interface ShareLinkMenuItemContext {
  /** Opens the share drawer for the item. Bind this to the menu item's click handler. */
  share: () => Promise<void>;
}

/**
 * Share entry point for a single vault item, rendered as a menu item.
 *
 * This is a structural directive rather than a component because `bit-menu` finds its items with a
 * content query, which does not reach into a child component's template — an item rendered by a
 * component would be skipped by the menu's arrow-key navigation. Stamping the item out from the
 * host's own template keeps it registered, so it behaves like every other item in the menu.
 *
 * The host supplies only the item's markup; this directive owns whether the item appears at all
 * and what activating it does:
 *
 * ```html
 * <button
 *   type="button"
 *   bitMenuItem
 *   *appShareLinkMenuItem="cipher; let share = share"
 *   (click)="share()"
 * >
 *   <i class="bwi bwi-fw bwi-share-link" aria-hidden="true"></i>
 *   {{ "shareViaLink" | i18n }}
 * </button>
 * ```
 */
@Directive({
  selector: "[appShareLinkMenuItem]",
  standalone: true,
})
export class ShareLinkMenuItemDirective {
  /** The item to share. */
  readonly cipher = input.required<CipherViewLike>({ alias: "appShareLinkMenuItem" });

  /**
   * The account whose vault holds the item, for a host that lists items of an account other than
   * the active one: `*appShareLinkMenuItem="cipher; userId: userId; let share = share"`. Whether
   * the item can be shared, the re-prompt and the Send are then that account's. Defaults to the
   * active account.
   */
  readonly userId = input<UserId | undefined>(undefined, { alias: "appShareLinkMenuItemUserId" });

  private templateRef = inject<TemplateRef<ShareLinkMenuItemContext>>(
    TemplateRef<ShareLinkMenuItemContext>,
  );
  private viewContainerRef = inject(ViewContainerRef);
  private shareLinkService = inject(ShareLinkService);
  private shareItemService = inject(ShareItemService);

  private readonly canShare = toSignal(
    combineLatest([toObservable(this.cipher), toObservable(this.userId)]).pipe(
      switchMap(([cipher, userId]) =>
        userId == null
          ? this.shareLinkService.cipherCanBeShared$(cipher)
          : this.shareLinkService.cipherCanBeShared$(cipher, userId),
      ),
    ),
    { initialValue: false },
  );

  constructor() {
    effect(() => {
      const canShare = this.canShare();

      untracked(() => {
        this.viewContainerRef.clear();

        if (canShare) {
          this.viewContainerRef.createEmbeddedView(this.templateRef, {
            share: () => {
              const userId = this.userId();
              return userId == null
                ? this.shareItemService.share(this.cipher())
                : this.shareItemService.share(this.cipher(), { userId });
            },
          });
        }
      });
    });
  }

  /** Lets the template use `let share = share` without a type assertion. */
  static ngTemplateContextGuard(
    dir: ShareLinkMenuItemDirective,
    ctx: unknown,
  ): ctx is ShareLinkMenuItemContext {
    return true;
  }
}
