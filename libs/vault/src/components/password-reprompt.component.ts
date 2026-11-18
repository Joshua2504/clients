import { Component, inject } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { combineLatest, firstValueFrom, map, Observable, of } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { MasterPasswordUnlockService } from "@bitwarden/common/key-management/master-password/abstractions/master-password-unlock.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { UserId } from "@bitwarden/common/types/guid";
import {
  DIALOG_DATA,
  DialogRef,
  AsyncActionsModule,
  ButtonModule,
  DialogModule,
  FormFieldModule,
  IconButtonModule,
  ToastService,
  TypographyModule,
} from "@bitwarden/components";

export type PasswordRepromptDialogData = {
  /** The account whose master password is asked for and verified. Defaults to the active account. */
  userId?: UserId;
};

/**
 * Used to verify the user's Master Password for the "Master Password Re-prompt" feature only.
 * See UserVerificationComponent for any other situation where you need to verify the user's identity.
 */
// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "vault-password-reprompt",
  imports: [
    JslibModule,
    AsyncActionsModule,
    ButtonModule,
    DialogModule,
    FormFieldModule,
    IconButtonModule,
    ReactiveFormsModule,
    TypographyModule,
  ],
  templateUrl: "password-reprompt.component.html",
})
export class PasswordRepromptComponent {
  formGroup = this.formBuilder.group({
    masterPassword: ["", { validators: [Validators.required], updateOn: "submit" }],
  });

  private readonly data = inject<PasswordRepromptDialogData | null>(DIALOG_DATA, {
    optional: true,
  });

  /**
   * How the account is named to the user when the reprompt is for an account other than the
   * active one, which is not the account the client shows. Undefined otherwise.
   */
  protected readonly accountLabel = toSignal(this.accountLabel$());

  constructor(
    protected masterPasswordUnlockService: MasterPasswordUnlockService,
    protected platformUtilsService: PlatformUtilsService,
    protected i18nService: I18nService,
    protected formBuilder: FormBuilder,
    protected dialogRef: DialogRef,
    private toastService: ToastService,
    protected accountService: AccountService,
  ) {}

  private accountLabel$(): Observable<string | undefined> {
    const userId = this.data?.userId;
    if (userId == null) {
      return of(undefined);
    }
    return combineLatest([this.accountService.activeAccount$, this.accountService.accounts$]).pipe(
      map(([activeAccount, accounts]) =>
        userId === activeAccount?.id ? undefined : accounts[userId]?.email,
      ),
    );
  }

  submit = async () => {
    // Exit early when a master password is not provided.
    // The form field required error will be shown to users in these cases.
    if (!this.formGroup.value.masterPassword) {
      return;
    }

    const userId =
      this.data?.userId ?? (await firstValueFrom(getUserId(this.accountService.activeAccount$)));

    if (userId == null) {
      throw new Error("An active user is expected while doing password reprompt.");
    }

    if (
      !(await this.masterPasswordUnlockService.proofOfDecryption(
        this.formGroup.value.masterPassword,
        userId,
      ))
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
