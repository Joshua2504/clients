// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { Overlay } from "@angular/cdk/overlay";
import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { UserId } from "@bitwarden/common/types/guid";
import { DialogService } from "@bitwarden/components";
import { CipherFormGenerationService } from "@bitwarden/vault";

import { VaultGeneratorDialogComponent } from "../components/vault/vault-generator-dialog/vault-generator-dialog.component";

@Injectable()
export class BrowserCipherFormGenerationService implements CipherFormGenerationService {
  private dialogService = inject(DialogService);
  private overlay = inject(Overlay);

  /**
   * @param userId The account the cipher form writes to. The generator dialog then uses that
   * account's options, policies and history. Defaults to the active account.
   */
  async generatePassword(userId?: UserId): Promise<string> {
    const dialogRef = VaultGeneratorDialogComponent.open(this.dialogService, this.overlay, {
      data: { type: "password", ...(userId == null ? {} : { userId }) },
    });

    const result = await firstValueFrom(dialogRef.closed);

    if (result == null || result.action === "canceled") {
      return null;
    }

    return result.generatedValue;
  }

  /** @param userId See {@link generatePassword}. */
  async generateUsername(uri: string, userId?: UserId): Promise<string> {
    const dialogRef = VaultGeneratorDialogComponent.open(this.dialogService, this.overlay, {
      data: { type: "username", uri: uri, ...(userId == null ? {} : { userId }) },
    });

    const result = await firstValueFrom(dialogRef.closed);

    if (result == null || result.action === "canceled") {
      return null;
    }

    return result.generatedValue;
  }
}
