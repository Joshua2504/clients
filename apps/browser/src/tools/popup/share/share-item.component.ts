import { Location } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, viewChild } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute } from "@angular/router";
import { combineLatest, of, switchMap } from "rxjs";

import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { AsyncActionsModule, ButtonModule, IconModule } from "@bitwarden/components";
import { ShareItemFormComponent } from "@bitwarden/tools-share";
import { I18nPipe } from "@bitwarden/ui-common";

import { PopupFooterComponent } from "../../../platform/popup/layout/popup-footer.component";
import { PopupHeaderComponent } from "../../../platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "../../../platform/popup/layout/popup-page.component";
import { ItemAccountHintComponent } from "../../../vault/popup/components/item-account-hint/item-account-hint.component";
import { VaultPopupItemAccount } from "../../../vault/popup/services/vault-popup-item-account.service";

@Component({
  selector: "app-share-item",
  templateUrl: "share-item.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PopupPageComponent,
    PopupHeaderComponent,
    PopupFooterComponent,
    ButtonModule,
    I18nPipe,
    ShareItemFormComponent,
    IconModule,
    AsyncActionsModule,
    ItemAccountHintComponent,
  ],
  providers: [VaultPopupItemAccount],
})
export class ShareItemComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly cipherService = inject(CipherService);

  /**
   * The account the page shares from: the one the route names, else the active account. A named
   * account that does not serve emits nothing, so the page loads nothing while it is being left.
   */
  protected readonly itemAccount = inject(VaultPopupItemAccount);

  protected readonly cipher = toSignal(
    combineLatest([this.route.queryParams, this.itemAccount.userId$]).pipe(
      switchMap(([qp, userId]) => {
        if (qp.cipherId && userId) {
          return this.cipherService.cipherView$(userId, qp.cipherId);
        } else {
          return of(undefined);
        }
      }),
    ),
    { initialValue: undefined },
  );
  protected readonly shareItemForm = viewChild(ShareItemFormComponent);

  protected readonly createAndCopyLink = async () => {
    const copySuccessful = await this.shareItemForm()?.createAndCopyLink();
    if (copySuccessful) {
      this.onBackClick();
    }
  };

  protected onBackClick(): void {
    this.location.back();
  }
}
