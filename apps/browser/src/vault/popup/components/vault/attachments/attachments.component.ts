// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { CommonModule } from "@angular/common";
import { Component, inject } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute } from "@angular/router";
import { first } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { CipherId } from "@bitwarden/common/types/guid";
import { ButtonModule } from "@bitwarden/components";
import { CipherAttachmentsComponent } from "@bitwarden/vault";

import { PopOutComponent } from "../../../../../platform/popup/components/pop-out.component";
import { PopupFooterComponent } from "../../../../../platform/popup/layout/popup-footer.component";
import { PopupHeaderComponent } from "../../../../../platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "../../../../../platform/popup/layout/popup-page.component";
import { PopupRouterCacheService } from "../../../../../platform/popup/view-cache/popup-router-cache.service";
import { VaultPopupItemAccount } from "../../../services/vault-popup-item-account.service";
import { ItemAccountHintComponent } from "../../item-account-hint/item-account-hint.component";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-attachments",
  templateUrl: "./attachments.component.html",
  imports: [
    CommonModule,
    ButtonModule,
    JslibModule,
    CipherAttachmentsComponent,
    PopupPageComponent,
    PopupHeaderComponent,
    PopupFooterComponent,
    PopOutComponent,
    ItemAccountHintComponent,
  ],
  providers: [VaultPopupItemAccount],
})
export class AttachmentsComponent {
  /** The `id` tied to the underlying HTMLFormElement */
  attachmentFormId = CipherAttachmentsComponent.attachmentFormID;

  /** Id of the cipher */
  cipherId: CipherId;

  /** The account the page operates on: the one the route names, else the active account. */
  protected readonly itemAccount = inject(VaultPopupItemAccount);

  constructor(
    private popupRouterCacheService: PopupRouterCacheService,
    route: ActivatedRoute,
  ) {
    route.queryParams.pipe(takeUntilDestroyed(), first()).subscribe(({ cipherId }) => {
      if (this.itemAccount.explicitUserId() == null) {
        this.cipherId = cipherId;
        return;
      }
      // Nothing of the named account's vault is shown unless that account serves.
      void this.itemAccount.userId().then((userId) => {
        if (userId != null) {
          this.cipherId = cipherId;
        }
      });
    });
  }

  /** Navigate the user back to the edit screen after uploading an attachment */
  async navigateBack() {
    await this.popupRouterCacheService.back(true);
  }
}
