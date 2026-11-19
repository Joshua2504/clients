import { Observable } from "rxjs";

import { UserId } from "../../types/guid";

/**
 * This interface defines the a contract for a service that prompts the user to upgrade to premium.
 * It ensures that PremiumUpgradePromptService contains a promptForPremium method.
 */
export abstract class PremiumUpgradePromptService {
  /**
   * @param organizationId The organization of the item the premium feature was used on, if any.
   * @param userId The account that needs premium. Defaults to the active account. An
   * implementation that is given another account must not start the active account's upgrade.
   */
  abstract promptForPremium(organizationId?: string, userId?: UserId): Promise<void>;
  abstract upgradeConfirmed$: Observable<boolean>;
}
