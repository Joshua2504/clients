// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { Component, inject, OnInit } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { firstValueFrom } from "rxjs";
import { first } from "rxjs/operators";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { CipherId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { RevealedCipherService } from "@bitwarden/common/vault/abstractions/revealed-cipher.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { PasswordHistoryViewComponent } from "@bitwarden/vault";

import { PopOutComponent } from "../../../../../platform/popup/components/pop-out.component";
import { PopupHeaderComponent } from "../../../../../platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "../../../../../platform/popup/layout/popup-page.component";
import { PopupRouterCacheService } from "../../../../../platform/popup/view-cache/popup-router-cache.service";
import { VaultPopupItemAccount } from "../../../services/vault-popup-item-account.service";
import { ItemAccountHintComponent } from "../../item-account-hint/item-account-hint.component";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "vault-password-history",
  templateUrl: "vault-password-history.component.html",
  imports: [
    JslibModule,
    PopupPageComponent,
    PopOutComponent,
    PopupHeaderComponent,
    PasswordHistoryViewComponent,
    ItemAccountHintComponent,
  ],
  providers: [VaultPopupItemAccount],
})
export class PasswordHistoryComponent implements OnInit {
  protected cipher: CipherView;
  private readonly revealedCipherService = inject(RevealedCipherService);

  /** The account the page operates on: the one the route names, else the active account. */
  protected readonly itemAccount = inject(VaultPopupItemAccount);

  constructor(
    private browserRouterHistory: PopupRouterCacheService,
    private route: ActivatedRoute,
    private cipherService: CipherService,
  ) {}

  ngOnInit() {
    // eslint-disable-next-line rxjs-angular/prefer-takeuntil
    this.route.queryParams.pipe(first()).subscribe((params) => {
      if (params.cipherId) {
        void this.loadCipher(params.cipherId);
      } else {
        this.close();
      }
    });
  }

  close() {
    void this.browserRouterHistory.back();
  }

  /** Load the cipher based on the given Id */
  private async loadCipher(cipherId: string) {
    const activeUserId = await this.itemAccount.userId();
    if (activeUserId == null) {
      // The named account does not serve. The page is being left and shows nothing.
      return;
    }

    // A restricted cipher's history exists only in its revealed view.
    this.cipher =
      (await firstValueFrom(this.cipherService.cipherView$(activeUserId, cipherId as CipherId))) ??
      this.revealedCipherService.get(activeUserId, cipherId as CipherId);
  }
}
