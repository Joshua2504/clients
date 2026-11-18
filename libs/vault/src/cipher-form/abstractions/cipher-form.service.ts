import { UserId } from "@bitwarden/common/types/guid";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { CipherFormConfig } from "./cipher-form-config.service";

/**
 * Service to save the cipher using the correct endpoint(s) and encapsulating the logic for decrypting the cipher.
 *
 * This service should only be used internally by the CipherFormComponent.
 */
export abstract class CipherFormService {
  /**
   * Helper to decrypt a cipher and avoid the need to call the cipher service directly.
   * (useful for mocking tests/storybook).
   * @param cipher The cipher to decrypt.
   * @param userId The account whose vault holds `cipher`. Defaults to the active account.
   */
  abstract decryptCipher(cipher: Cipher, userId?: UserId): Promise<CipherView>;

  /**
   * Saves the new or modified cipher with the server, to the vault of the account the config
   * names (`config.userId`), else of the active account.
   */
  abstract saveCipher(cipher: CipherView, config: CipherFormConfig): Promise<CipherView>;
}
