import { UserId } from "@bitwarden/common/types/guid";

/**
 * Service responsible for generating random passwords and usernames.
 */
export abstract class CipherFormGenerationService {
  /**
   * Generates a random password. Called when the user clicks the "Generate Password" button in the UI.
   * @param userId The account whose vault the form writes to (`CipherFormConfig.userId`). The
   * generator then uses that account's options, policies and history. Defaults to the active
   * account.
   */
  abstract generatePassword(userId?: UserId): Promise<string | null>;

  /**
   * Generates a random username. Called when the user clicks the "Generate Username" button in the UI.
   * @param uri The URI associated with the username generation request.
   * @param userId The account whose vault the form writes to (`CipherFormConfig.userId`). The
   * generator then uses that account's options, policies and history. Defaults to the active
   * account.
   */
  abstract generateUsername(uri: string, userId?: UserId): Promise<string | null>;
}
