// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { firstValueFrom, Observable, Subscription } from "rxjs";

import { ClearClipboardDelay } from "../../autofill/constants";
import { AutofillSettingsServiceAbstraction } from "../../autofill/services/autofill-settings.service";
import { ClearClipboardDelaySetting } from "../../autofill/types";
import { UserId } from "../../types/guid";
import { PlatformUtilsService } from "../abstractions/platform-utils.service";
import { SystemService as SystemServiceAbstraction } from "../abstractions/system.service";
import { Utils } from "../misc/utils";
import { ScheduledTaskNames } from "../scheduling/scheduled-task-name.enum";
import { TaskSchedulerService } from "../scheduling/task-scheduler.service";

export class SystemService implements SystemServiceAbstraction {
  private clearClipboardTimeoutSubscription: Subscription;
  private clearClipboardTimeoutFunction: () => Promise<any> = null;

  constructor(
    private platformUtilsService: PlatformUtilsService,
    private autofillSettingsService: AutofillSettingsServiceAbstraction,
    private taskSchedulerService: TaskSchedulerService,
    /**
     * The accounts that share the clipboard, such as the accounts autofill serves. The clipboard
     * is then cleared after the shortest delay any of them has set. While it is absent or emits
     * none, the active account's delay applies.
     */
    private clipboardUserIds$?: Observable<UserId[]>,
  ) {
    this.taskSchedulerService.registerTaskHandler(
      ScheduledTaskNames.systemClearClipboardTimeout,
      () => this.clearPendingClipboard(),
    );
  }

  async clearClipboard(clipboardValue: string, timeoutMs: number = null): Promise<void> {
    this.clearClipboardTimeoutSubscription?.unsubscribe();

    if (Utils.isNullOrWhitespace(clipboardValue)) {
      return;
    }

    let taskTimeoutInMs = timeoutMs;
    if (!taskTimeoutInMs) {
      taskTimeoutInMs = await this.clearClipboardDelayMs();
    }

    if (!taskTimeoutInMs) {
      return;
    }

    this.clearClipboardTimeoutFunction = async () => {
      const clipboardValueNow = await this.platformUtilsService.readFromClipboard();
      if (clipboardValue === clipboardValueNow) {
        this.platformUtilsService.copyToClipboard("", { clearing: true });
      }
    };

    this.clearClipboardTimeoutSubscription = this.taskSchedulerService.setTimeout(
      ScheduledTaskNames.systemClearClipboardTimeout,
      taskTimeoutInMs,
    );
  }

  /**
   * The delay after which the clipboard is cleared, `null` for never. With several accounts
   * sharing the clipboard the shortest delay wins, and "never" only when all of them say so.
   */
  private async clearClipboardDelayMs(): Promise<number | null> {
    const userIds =
      this.clipboardUserIds$ == null ? [] : await firstValueFrom(this.clipboardUserIds$);
    if (userIds.length === 0) {
      return this.convertClearClipboardDelayToMs(
        await firstValueFrom(this.autofillSettingsService.clearClipboardDelay$),
      );
    }

    const delays = await Promise.all(
      userIds.map(async (userId) =>
        this.convertClearClipboardDelayToMs(
          await firstValueFrom(this.autofillSettingsService.clearClipboardDelayFor$(userId)),
        ),
      ),
    );
    const finiteDelays = delays.filter((delay): delay is number => delay != null);
    return finiteDelays.length > 0 ? Math.min(...finiteDelays) : null;
  }

  private convertClearClipboardDelayToMs(setting: ClearClipboardDelaySetting): number | null {
    switch (setting) {
      case ClearClipboardDelay.Never:
        return null;
      case ClearClipboardDelay.TenSeconds:
        return 10 * 1000;
      case ClearClipboardDelay.TwentySeconds:
        return 20 * 1000;
      case ClearClipboardDelay.ThirtySeconds:
        return 30 * 1000;
      case ClearClipboardDelay.OneMinute:
        return 60 * 1000;
      case ClearClipboardDelay.TwoMinutes:
        return 120 * 1000;
      case ClearClipboardDelay.FiveMinutes:
        return 300 * 1000;
      default:
        return 300 * 1000; // Default to 5 minutes
    }
  }

  async clearPendingClipboard() {
    if (this.clearClipboardTimeoutFunction != null) {
      await this.clearClipboardTimeoutFunction();
      this.clearClipboardTimeoutFunction = null;
    }
  }
}
