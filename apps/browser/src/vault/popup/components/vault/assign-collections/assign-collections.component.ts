// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { CommonModule, Location } from "@angular/common";
import { Component, inject } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute } from "@angular/router";
import { Observable, combineLatest, filter, first, switchMap } from "rxjs";

import { CollectionService } from "@bitwarden/admin-console/common";
import { JslibModule } from "@bitwarden/angular/jslib.module";
import { CipherId, OrganizationId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  ButtonModule,
  CardComponent,
  SelectModule,
  FormFieldModule,
  AsyncActionsModule,
} from "@bitwarden/components";
import {
  AssignCollectionsComponent,
  CollectionAssignmentParams,
  Vfo1I18nPipe,
} from "@bitwarden/vault";

import { PopOutComponent } from "../../../../../platform/popup/components/pop-out.component";
import { PopupFooterComponent } from "../../../../../platform/popup/layout/popup-footer.component";
import { PopupHeaderComponent } from "../../../../../platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "../../../../../platform/popup/layout/popup-page.component";
import { VaultPopupItemAccount } from "../../../services/vault-popup-item-account.service";
import { ItemAccountHintComponent } from "../../item-account-hint/item-account-hint.component";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-assign-collections",
  templateUrl: "./assign-collections.component.html",
  imports: [
    AsyncActionsModule,
    ButtonModule,
    CommonModule,
    JslibModule,
    SelectModule,
    FormFieldModule,
    AssignCollectionsComponent,
    CardComponent,
    ReactiveFormsModule,
    PopupPageComponent,
    PopupHeaderComponent,
    PopupFooterComponent,
    PopOutComponent,
    Vfo1I18nPipe,
    ItemAccountHintComponent,
  ],
  providers: [VaultPopupItemAccount],
})
// FIXME(https://bitwarden.atlassian.net/browse/PM-28231): Use Component suffix
// eslint-disable-next-line @angular-eslint/component-class-suffix
export class AssignCollections {
  /** Params needed to populate the assign collections component */
  params: CollectionAssignmentParams;

  protected submitButtonText: string;

  /** The account the page operates on: the one the route names, else the active account. */
  protected readonly itemAccount = inject(VaultPopupItemAccount);

  constructor(
    private location: Location,
    private collectionService: CollectionService,
    private cipherService: CipherService,
    route: ActivatedRoute,
  ) {
    const userId$ = this.itemAccount.userId$;

    const cipher$: Observable<CipherView> = userId$.pipe(
      switchMap((userId) =>
        route.queryParams.pipe(
          switchMap(({ cipherId }) => this.cipherService.cipherView$(userId, cipherId as CipherId)),
        ),
      ),
      filter((cipher): cipher is CipherView => cipher != null),
    );

    const decryptedCollection$ = userId$.pipe(
      switchMap((userId) => this.collectionService.decryptedCollections$(userId)),
    );

    combineLatest([cipher$, decryptedCollection$])
      .pipe(takeUntilDestroyed(), first())
      .subscribe(([cipherView, collections]) => {
        let availableCollections = collections;
        const organizationId = (cipherView?.organizationId as OrganizationId) ?? null;

        // If the cipher is already a part of an organization,
        // only show collections that belong to that organization
        if (organizationId) {
          availableCollections = availableCollections.filter(
            (c) => c.organizationId === organizationId,
          );
        }

        this.params = {
          ciphers: [cipherView],
          organizationId,
          availableCollections,
          userId: this.itemAccount.explicitUserId(),
        };
      });
  }

  /** Navigates the user back to the previous screen */
  navigateBack() {
    this.location.back();
  }
}
