import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import {
  AccountCipher,
  accountCipherKey,
  accountCipherRef,
} from "@bitwarden/common/autofill/types/account-cipher";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";

import { CipherUse } from "../services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../services/abstractions/multi-account-fill-cipher-policy";
import { AutofillCipherTypeId } from "../types";

import { MainContextMenuHandler } from "./main-context-menu-handler";

export class CipherContextMenuHandler {
  constructor(
    private mainContextMenuHandler: MainContextMenuHandler,
    private autofillAccountsService: AutofillAccountsService,
    private cipherService: CipherService,
    private accountService: AccountService,
    private fillCipherPolicy: MultiAccountFillCipherPolicy,
  ) {}

  async update(url: string, currentUriIsBlocked: boolean = false) {
    if (this.mainContextMenuHandler.initRunning) {
      return;
    }

    // The cipher entries depend on the accounts autofill serves. With none, the menu offers
    // to unlock or log in instead.
    const autofillUserIds = await firstValueFrom(this.autofillAccountsService.autofillUserIds$);
    await MainContextMenuHandler.removeAll();
    if (autofillUserIds.length === 0) {
      // Should I pass in the auth status or even have two separate methods for this
      // on MainContextMenuHandler
      await this.mainContextMenuHandler.noAccess();
      return;
    }

    const menuEnabled = await this.mainContextMenuHandler.init();
    if (!menuEnabled) {
      return;
    }

    const ciphers = await this.fillCipherPolicy.ciphersForUrl(url, CipherUse.UserFill, {
      includeOtherTypes: [CipherType.Card, CipherType.Identity],
    });
    ciphers.sort((a, b) => this.cipherService.sortCiphersByLastUsedThenName(a.cipher, b.cipher));

    const groupedCiphers: Record<AutofillCipherTypeId, AccountCipher[]> = ciphers.reduce(
      (ciphersByType, accountCipher) => {
        const { cipher } = accountCipher;
        if (!cipher?.type) {
          return ciphersByType;
        }

        const existingCiphersOfType = ciphersByType[cipher.type as AutofillCipherTypeId] || [];

        return {
          ...ciphersByType,
          [cipher.type]: [...existingCiphersOfType, accountCipher],
        };
      },
      {
        [CipherType.Login]: [],
        [CipherType.Card]: [],
        [CipherType.Identity]: [],
        // SSH keys are not surfaced in the right-click context menu yet, but the grouping
        // record must cover every AutofillCipherTypeId.
        [CipherType.SshKey]: [],
      },
    );

    if (groupedCiphers[CipherType.Login].length === 0) {
      await this.mainContextMenuHandler.noLogins();
    }

    if (groupedCiphers[CipherType.Identity].length === 0) {
      await this.mainContextMenuHandler.noIdentities();
    }

    if (groupedCiphers[CipherType.Card].length === 0) {
      await this.mainContextMenuHandler.noCards();
    }

    // An entry shows its account once more than one account serves, so the user can tell
    // which vault a cipher comes from.
    const accountLabels = autofillUserIds.length > 1 ? await this.accountLabels() : undefined;
    for (const accountCipher of ciphers) {
      await this.updateForCipher(accountCipher, accountLabels?.get(accountCipher.userId));
    }

    if (currentUriIsBlocked) {
      await this.mainContextMenuHandler.removeBlockedUriMenuItems();
    }
  }

  /** What a menu entry shows for each account: its email. */
  private async accountLabels(): Promise<Map<string, string>> {
    const accounts = await firstValueFrom(this.accountService.accounts$);
    return new Map(Object.entries(accounts).map(([userId, account]) => [userId, account.email]));
  }

  /**
   * Adds the menu entries of one cipher. The entry id names the cipher and the account that
   * owns it, since a shared item has the same cipher id in every member's vault.
   *
   * @param accountLabel Shown after the title when more than one account serves.
   */
  private async updateForCipher(accountCipher: AccountCipher, accountLabel?: string) {
    const { cipher, userId } = accountCipher;
    if (
      cipher == null ||
      !new Set([CipherType.Login, CipherType.Card, CipherType.Identity] as CipherType[]).has(
        cipher.type,
      )
    ) {
      return;
    }

    let title = cipher.name;

    if (cipher.type === CipherType.Login && !Utils.isNullOrEmpty(title) && cipher.login?.username) {
      title += ` (${cipher.login.username})`;
    }

    if (cipher.type === CipherType.Card && cipher.card?.subTitle) {
      title += ` ${cipher.card.subTitle}`;
    }

    if (accountLabel) {
      title += ` \u2014 ${accountLabel}`;
    }

    await this.mainContextMenuHandler.loadOptions(
      title,
      accountCipherKey(accountCipherRef(accountCipher)),
      cipher,
      userId,
    );
  }
}
