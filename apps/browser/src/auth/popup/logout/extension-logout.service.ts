import { filter, firstValueFrom, map, of, timeout } from "rxjs";

import {
  DefaultLogoutService,
  LogoutReason,
  LogoutService,
  NewActiveUser,
} from "@bitwarden/common/auth/logout";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { SdkService } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { UserId } from "@bitwarden/common/types/guid";
import { LogService } from "@bitwarden/logging";

import { fromChromeEvent } from "../../../platform/browser/from-chrome-event";
import { AccountSwitcherService } from "../account-switching/services/account-switcher.service";

/** As long as waiting for the account switch that follows logging out the active account. */
const BACKGROUND_ACCOUNT_LOGOUT_TIMEOUT_MS = 60_000;

export class ExtensionLogoutService extends DefaultLogoutService implements LogoutService {
  constructor(
    protected messagingService: MessagingService,
    protected logService: LogService,
    private accountSwitcherService: AccountSwitcherService,
    sdkService: SdkService,
  ) {
    super(messagingService, logService, sdkService);
  }

  override async logout(
    userId: UserId,
    logoutReason: LogoutReason,
  ): Promise<NewActiveUser | undefined> {
    this.logService.info("Logging out user %s for reason: %s", userId, logoutReason);
    // Logging out the active account switches to the next up user. Logging out another account
    // leaves the active account where it is, so no switch follows: wait for that logout instead.
    const accountSwitchFinishPromise = (await this.isActiveAccount(userId))
      ? this.accountSwitcherService.listenForSwitchAccountFinish(null)
      : this.listenForLogoutFinish(userId);

    // Dispose the SDK client before broadcasting logout, so nothing reacting to the logout
    // (including the account switch) can still use it.
    this.sdkService.logout(userId);

    // send the logout message
    this.messagingService.send("logout", { userId, logoutReason });

    // wait for the account switch to finish
    const result = await accountSwitchFinishPromise;
    if (result) {
      return { userId: result.userId, authenticationStatus: result.authenticationStatus };
    }
    // if there is no account switch, return undefined
    return undefined;
  }

  /** Whether `userId` is the active account; an account the switcher does not list counts as it. */
  private async isActiveAccount(userId: UserId): Promise<boolean> {
    const accounts = await firstValueFrom(this.accountSwitcherService.availableAccounts$);
    const account = accounts?.find((a) => a.id === userId);
    return account == null || account.isActive;
  }

  /** Resolves with `null` once the background has logged out `userId`, or after a timeout. */
  private listenForLogoutFinish(userId: UserId): Promise<null> {
    return firstValueFrom(
      fromChromeEvent<[message?: { command?: string; userId?: UserId }]>(
        chrome.runtime.onMessage,
      ).pipe(
        filter(([message]) => message?.command === "doneLoggingOut" && message.userId === userId),
        map((): null => null),
        timeout({
          first: BACKGROUND_ACCOUNT_LOGOUT_TIMEOUT_MS,
          with: () => {
            this.logService.warning("message 'logout' never responded.");
            return of(null);
          },
        }),
      ),
    );
  }
}
