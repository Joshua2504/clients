import {
  combineLatest,
  distinctUntilChanged,
  firstValueFrom,
  map,
  mergeMap,
  Observable,
  of,
  switchMap,
} from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { BadgeSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/badge-settings.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";

import { Tab } from "../../platform/badge/badge-browser-api";
import { BadgeService } from "../../platform/badge/badge.service";
import { BadgeStatePriority } from "../../platform/badge/priority";

import { CipherUse } from "./abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "./abstractions/multi-account-fill-cipher-policy";

const StateName = "autofill-badge-updater";

/**
 * Shows on the toolbar badge how many ciphers the accounts autofill serves hold for a tab's URL.
 * See `multi-account.design.md`.
 */
export class AutofillBadgeUpdaterService {
  constructor(
    private badgeService: BadgeService,
    private accountService: AccountService,
    private fillCipherPolicy: MultiAccountFillCipherPolicy,
    private badgeSettingsService: BadgeSettingsServiceAbstraction,
    private logService: LogService,
    private autofillAccountsService: AutofillAccountsService,
  ) {}

  init() {
    this.badgeService.setState(StateName, (tab) => {
      return combineLatest({
        account: this.accountService.activeAccount$,
        enableBadgeCounter: this.enableBadgeCounter$(),
        // Emits when the accounts autofill serves change and when any of their ciphers do.
        ciphersChanged: this.fillCipherPolicy.changed$,
      }).pipe(
        mergeMap(async ({ account, enableBadgeCounter }) => {
          if (!enableBadgeCounter || !(account || (await this.servesAutofill()))) {
            return undefined;
          }

          return {
            state: {
              text: await this.calculateCountText(tab),
            },
            priority: BadgeStatePriority.Default,
          };
        }),
      );
    });
  }

  /**
   * One badge covers every account autofill serves, so the stricter setting wins
   * (`multi-account.design.md`, "When accounts disagree"): the counter is on only while the active
   * account and every account autofill serves have it on.
   */
  private enableBadgeCounter$(): Observable<boolean> {
    return combineLatest([
      this.accountService.activeAccount$.pipe(map((account) => account?.id)),
      this.autofillAccountsService.autofillUserIds$,
    ]).pipe(
      map(([activeUserId, autofillUserIds]) => [
        ...new Set(activeUserId ? [activeUserId, ...autofillUserIds] : autofillUserIds),
      ]),
      distinctUntilChanged((a, b) => a.length === b.length && a.every((id, i) => id === b[i])),
      switchMap((userIds) =>
        userIds.length === 0
          ? of(false)
          : combineLatest(
              userIds.map((userId) => this.badgeSettingsService.enableBadgeCounterFor$(userId)),
            ).pipe(map((settings) => settings.every(Boolean))),
      ),
      distinctUntilChanged(),
    );
  }

  /** Whether autofill serves an account, so there are ciphers to count without an active one. */
  private async servesAutofill(): Promise<boolean> {
    return (await firstValueFrom(this.autofillAccountsService.autofillUserIds$)).length > 0;
  }

  private async calculateCountText(tab: Tab) {
    if (!tab.tabId) {
      this.logService.warning("Tab event received but tab id is undefined");
      return;
    }

    // Counted across every account autofill serves.
    const ciphers = tab.url
      ? await this.fillCipherPolicy.ciphersForUrl(tab.url, CipherUse.Badge)
      : [];
    const cipherCount = ciphers.length;

    if (cipherCount === 0) {
      return undefined;
    }

    return cipherCount > 9 ? "9+" : cipherCount.toString();
  }
}
