import { ChangeDetectionStrategy, Component, input } from "@angular/core";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { IconModule, TypographyModule } from "@bitwarden/components";

/**
 * Tells the user that a vault item page shows the vault of an account other than the active one.
 * Render it in the `above-scroll-area` slot of the page while
 * `VaultPopupItemAccount.accountHint` holds an email:
 *
 * ```html
 * @if (itemAccount.accountHint(); as email) {
 *   <app-item-account-hint slot="above-scroll-area" [email]="email" />
 * }
 * ```
 */
@Component({
  selector: "app-item-account-hint",
  templateUrl: "item-account-hint.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JslibModule, IconModule, TypographyModule],
})
export class ItemAccountHintComponent {
  /** The email of the account whose vault the page shows. */
  readonly email = input.required<string>();
}
