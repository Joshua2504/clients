import { inject } from "@angular/core";
import { EMPTY, firstValueFrom, Observable } from "rxjs";

import { PremiumUpgradeDialogComponent } from "@bitwarden/angular/billing/components";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { UserId } from "@bitwarden/common/types/guid";
import { PremiumUpgradePromptService } from "@bitwarden/common/vault/abstractions/premium-upgrade-prompt.service";
import { DialogService } from "@bitwarden/components";

/**
 * This class handles the premium upgrade process for the browser extension.
 */
export class BrowserPremiumUpgradePromptService implements PremiumUpgradePromptService {
  private dialogService = inject(DialogService);
  private accountService = inject(AccountService);

  readonly upgradeConfirmed$: Observable<boolean> = EMPTY;

  /**
   * Opens the upgrade dialog for the active account. The upgrade it starts, a checkout session or
   * the web vault's subscription page, belongs to the active account and cannot be started for
   * another one. For an item of another account the user is therefore told which account needs
   * premium, and no upgrade is started.
   */
  async promptForPremium(organizationId?: string, userId?: UserId) {
    if (userId != null) {
      const [activeAccount, accounts] = await Promise.all([
        firstValueFrom(this.accountService.activeAccount$),
        firstValueFrom(this.accountService.accounts$),
      ]);

      if (activeAccount?.id !== userId) {
        await this.dialogService.openSimpleDialog({
          title: { key: "premiumRequiredForAccountTitle" },
          content: {
            key: "premiumRequiredForAccount",
            placeholders: [accounts[userId]?.email ?? ""],
          },
          acceptButtonText: { key: "ok" },
          cancelButtonText: null,
          type: "info",
        });
        return;
      }
    }

    PremiumUpgradeDialogComponent.open(this.dialogService);
  }
}
