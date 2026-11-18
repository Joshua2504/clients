import { UserId } from "../../types/guid";
import { CipherView } from "../models/view/cipher.view";

/**
 * The ViewPasswordHistoryService is responsible for displaying the password history for a cipher.
 */
export abstract class ViewPasswordHistoryService {
  /**
   * @param cipher The cipher whose password history is shown.
   * @param userId The account whose vault holds `cipher`. Defaults to the active account.
   */
  abstract viewPasswordHistory(cipher: CipherView, userId?: UserId): Promise<void>;
}
