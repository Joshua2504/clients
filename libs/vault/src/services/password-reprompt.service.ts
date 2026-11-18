import { Injectable } from "@angular/core";
import { firstValueFrom, lastValueFrom } from "rxjs";

import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherRepromptType } from "@bitwarden/common/vault/enums";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { DialogService } from "@bitwarden/components";

import {
  PasswordRepromptComponent,
  PasswordRepromptDialogData,
} from "../components/password-reprompt.component";

/**
 * Used to verify the user's Master Password for the "Master Password Re-prompt" feature only.
 * See UserVerificationService for any other situation where you need to verify the user's identity.
 */
@Injectable()
export class PasswordRepromptService {
  constructor(
    private dialogService: DialogService,
    private userVerificationService: UserVerificationService,
  ) {}

  enabled$ = Utils.asyncToObservable(() => this.userVerificationService.hasMasterPassword());

  protectedFields() {
    return [
      "TOTP",
      "Password",
      "H_Field",
      "Card Number",
      "Security Code",
      "PIN",
      "Account Number",
      "IBAN",
      "SWIFT",
      "Passport Number",
      "National Identification Number",
      "License Number",
    ];
  }

  /**
   * Asks for the master password when `cipher` requires a reprompt.
   * @param cipher The cipher about to be acted on.
   * @param userId The account whose vault holds `cipher`. Defaults to the active account.
   */
  async passwordRepromptCheck(cipher: CipherViewLike, userId?: UserId) {
    if (cipher.reprompt === CipherRepromptType.None) {
      return true;
    }

    return await this.showPasswordPrompt(userId);
  }

  /**
   * Asks for a master password and verifies it.
   * @param userId The account whose master password is asked for and verified. The dialog names
   * that account when it is not the active one. Defaults to the active account.
   * @returns True when the password was verified, or the account has no master password.
   */
  async showPasswordPrompt(userId?: UserId) {
    if (!(await this.enabled(userId))) {
      return true;
    }

    const dialog = this.dialogService.open<boolean, PasswordRepromptDialogData>(
      PasswordRepromptComponent,
      { ariaModal: true, data: { userId } },
    );

    const result = await lastValueFrom(dialog.closed);

    return result === true;
  }

  /**
   * Whether the reprompt applies, which is when the account has a master password.
   * @param userId The account to ask about. Defaults to the active account.
   */
  enabled(userId?: UserId) {
    return userId == null
      ? firstValueFrom(this.enabled$)
      : this.userVerificationService.hasMasterPassword(userId);
  }
}
