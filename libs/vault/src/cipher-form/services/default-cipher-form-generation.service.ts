import { Injectable } from "@angular/core";

import { UserId } from "@bitwarden/common/types/guid";
import {
  PasswordGenerationServiceAbstraction,
  UsernameGenerationServiceAbstraction,
} from "@bitwarden/generator-legacy";

import { CipherFormGenerationService } from "../abstractions/cipher-form-generation.service";

@Injectable()
export class DefaultCipherFormGenerationService implements CipherFormGenerationService {
  constructor(
    private passwordGenerationService: PasswordGenerationServiceAbstraction,
    private usernameGenerationService: UsernameGenerationServiceAbstraction,
  ) {}

  async generatePassword(userId?: UserId): Promise<string> {
    this.assertActiveAccount(userId);
    const [options] = await this.passwordGenerationService.getOptions();
    return await this.passwordGenerationService.generatePassword(options);
  }

  async generateUsername(_uri?: string, userId?: UserId): Promise<string> {
    this.assertActiveAccount(userId);
    const options = await this.usernameGenerationService.getOptions();
    return await this.usernameGenerationService.generateUsername(options);
  }

  /**
   * The legacy generation services read the active account's options. A form of another account
   * is refused rather than given a credential generated under the wrong account's options.
   */
  private assertActiveAccount(userId?: UserId) {
    if (userId != null) {
      throw new Error(
        "DefaultCipherFormGenerationService generates for the active account only. Provide a CipherFormGenerationService that takes the form's account.",
      );
    }
  }
}
