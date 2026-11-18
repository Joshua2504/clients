import { Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { CipherArchiveService } from "@bitwarden/common/vault/abstractions/cipher-archive.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { DialogService, ToastService } from "@bitwarden/components";

import { PasswordRepromptService } from "./password-reprompt.service";

/**
 * Wrapper around {@link CipherArchiveService} to provide UI enhancements for archiving/unarchiving ciphers.
 */
@Injectable({ providedIn: "root" })
export class ArchiveCipherUtilitiesService {
  constructor(
    private cipherArchiveService: CipherArchiveService,
    private dialogService: DialogService,
    private passwordRepromptService: PasswordRepromptService,
    private toastService: ToastService,
    private i18nService: I18nService,
    private accountService: AccountService,
  ) {}

  /** Archive a cipher, with confirmation dialog and password reprompt checks.
   *
   * @param cipher The cipher to archive
   * @param skipReprompt Whether to skip the password reprompt check
   * @param userId The account whose vault holds the cipher. Defaults to the active account.
   * @returns The archived CipherData on success, or undefined on failure or cancellation
   */
  async archiveCipher(cipher: CipherView, skipReprompt = false, userId?: UserId) {
    if (!skipReprompt) {
      const repromptPassed = await this.passwordRepromptService.passwordRepromptCheck(
        cipher,
        userId,
      );
      if (!repromptPassed) {
        return;
      }
    }

    const confirmed = await this.dialogService.openSimpleDialog({
      title: { key: "archiveItem" },
      content: { key: "archiveItemDialogContent" },
      acceptButtonText: { key: "archiveVerb" },
      type: "info",
    });

    if (!confirmed) {
      return;
    }

    const accountId =
      userId ?? (await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId)));
    try {
      const cipherResponse = await this.cipherArchiveService.archiveWithServer(
        cipher.id as CipherId,
        accountId,
      );
      this.toastService.showToast({
        variant: "success",
        message: this.i18nService.t("itemArchiveToast"),
      });
      return cipherResponse;
    } catch {
      this.toastService.showToast({
        variant: "error",
        message: this.i18nService.t("errorOccurred"),
      });
      return;
    }
  }

  /** Unarchives a cipher
   * @param cipher The cipher to unarchive
   * @param skipReprompt Whether to skip the password reprompt check
   * @param userId The account whose vault holds the cipher. Defaults to the active account.
   * @returns The unarchived cipher on success, or undefined on failure
   */
  async unarchiveCipher(cipher: CipherView, skipReprompt = false, userId?: UserId) {
    if (!skipReprompt) {
      const repromptPassed = await this.passwordRepromptService.passwordRepromptCheck(
        cipher,
        userId,
      );
      if (!repromptPassed) {
        return;
      }
    }

    const accountId =
      userId ?? (await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId)));
    try {
      const cipherResponse = await this.cipherArchiveService.unarchiveWithServer(
        cipher.id as CipherId,
        accountId,
      );
      this.toastService.showToast({
        variant: "success",
        message: this.i18nService.t("itemUnarchivedToast"),
      });
      return cipherResponse;
    } catch {
      this.toastService.showToast({
        variant: "error",
        message: this.i18nService.t("errorOccurred"),
      });
      return;
    }
  }
}
