import { UserId } from "@bitwarden/common/types/guid";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { BitwardenIcon } from "@bitwarden/components";

/**
 * A client-supplied action for a row's overflow menu.
 *
 * @example
 * ```ts
 * protected readonly rowActions = computed<VaultItemsTableRowAction<CipherView>[]>(() => [
 *   {
 *     id: "edit",
 *     label: this.i18nService.t("edit"),
 *     icon: "bwi-pencil-square",
 *     run: (item) => this.onEvent.emit({ type: "editCipher", item }),
 *   },
 * ]);
 * ```
 *
 * Each callback also receives `userId`: the account whose vault holds `item`, when the menu was
 * given one. The browser popup passes it for a row of an account other than the active one. An
 * action that reads or changes the item must do so for that account and never for the active
 * account in its place; an item id does not identify an account. Without `userId` the item is
 * the active account's, which is all web and desktop show.
 */
export type VaultItemsTableRowAction<C extends CipherViewLike> = {
  /** Stable identifier. Drives the menu item's QA id and the `@for` track expression. */
  id: string;

  /** Already-translated label. */
  label: string;

  icon: BitwardenIcon;

  /** Executes the action for `item` when the menu item is chosen. */
  run: (item: C, userId?: UserId) => void | Promise<void>;

  /** Whether the action shows for `item`. Omit for always-shown. */
  show?: (item: C, userId?: UserId) => boolean;

  /** Whether the shown action is disabled for `item`. Omit for always-enabled. */
  disabled?: (item: C, userId?: UserId) => boolean;

  /**
   * Whether the action is gated behind a premium upgrade for `item` — Archive, for one, is only
   * available to premium users. When it returns `true` the menu item carries the Upgrade badge and
   * choosing it opens the upgrade prompt instead of emitting {@link event}; the client decides who
   * counts as gated, so the table never inspects the user's plan itself.
   *
   * Omit for actions that are never gated.
   */
  premiumGated?: (item: C) => boolean;

  /** Menu item styling, passed straight to `bitMenuItem`. Defaults to `"primary"`. */
  variant?: "primary" | "danger";
};
