import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { MasterPasswordUnlockService } from "@bitwarden/common/key-management/master-password/abstractions/master-password-unlock.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { UserId } from "@bitwarden/common/types/guid";
import {
  AsyncActionsModule,
  ButtonModule,
  DIALOG_DATA,
  DialogModule,
  DialogRef,
  DialogService,
  FormFieldModule,
  IconButtonModule,
  ToastService,
} from "@bitwarden/components";

export type Fido2AccountPasswordRepromptData = {
  /** The account whose master password is asked for. */
  userId: UserId;
  /** How that account is named to the user. */
  accountLabel: string;
};

/**
 * Master password reprompt for a passkey of an account other than the active one.
 *
 * The vault's `PasswordRepromptComponent` verifies the master password of the active account. A
 * passkey is governed by the account that owns it, so its reprompt must be answered with that
 * account's master password. The dialog names the account, because it is not the one the popup
 * shows.
 */
@Component({
  selector: "app-fido2-account-password-reprompt",
  templateUrl: "fido2-account-password-reprompt.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    JslibModule,
    AsyncActionsModule,
    ButtonModule,
    DialogModule,
    FormFieldModule,
    IconButtonModule,
    ReactiveFormsModule,
  ],
})
export class Fido2AccountPasswordRepromptComponent {
  protected readonly data = inject<Fido2AccountPasswordRepromptData>(DIALOG_DATA);
  private readonly masterPasswordUnlockService = inject(MasterPasswordUnlockService);
  private readonly i18nService = inject(I18nService);
  private readonly dialogRef = inject<DialogRef<boolean>>(DialogRef);
  private readonly toastService = inject(ToastService);

  protected readonly formGroup = inject(FormBuilder).group({
    masterPassword: ["", { validators: [Validators.required], updateOn: "submit" }],
  });

  static open(dialogService: DialogService, data: Fido2AccountPasswordRepromptData) {
    return dialogService.open<boolean, Fido2AccountPasswordRepromptData>(
      Fido2AccountPasswordRepromptComponent,
      { ariaModal: true, data },
    );
  }

  protected readonly submit = async () => {
    const masterPassword = this.formGroup.value.masterPassword;
    // The form field shows its required error when no master password was entered.
    if (!masterPassword) {
      return;
    }

    if (
      !(await this.masterPasswordUnlockService.proofOfDecryption(masterPassword, this.data.userId))
    ) {
      this.toastService.showToast({
        variant: "error",
        title: this.i18nService.t("errorOccurred"),
        message: this.i18nService.t("invalidMasterPassword"),
      });
      return;
    }

    await this.dialogRef.close(true);
  };
}
