import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, of, Subscription } from "rxjs";

import { ClearClipboardDelay } from "../../autofill/constants";
import { AutofillSettingsServiceAbstraction } from "../../autofill/services/autofill-settings.service";
import { ClearClipboardDelaySetting } from "../../autofill/types";
import { UserId } from "../../types/guid";
import { PlatformUtilsService } from "../abstractions/platform-utils.service";
import { ScheduledTaskNames } from "../scheduling/scheduled-task-name.enum";
import { TaskSchedulerService } from "../scheduling/task-scheduler.service";

import { SystemService } from "./system.service";

describe("SystemService", () => {
  const activeUserId = "active-user" as UserId;
  const otherUserId = "other-user" as UserId;

  let platformUtilsService: MockProxy<PlatformUtilsService>;
  let autofillSettingsService: MockProxy<AutofillSettingsServiceAbstraction>;
  let taskSchedulerService: MockProxy<TaskSchedulerService>;
  let clipboardUserIds$: BehaviorSubject<UserId[]>;
  let delays: Map<UserId, ClearClipboardDelaySetting>;

  const scheduledDelay = () => taskSchedulerService.setTimeout.mock.calls[0]?.[1];

  beforeEach(() => {
    platformUtilsService = mock<PlatformUtilsService>();
    taskSchedulerService = mock<TaskSchedulerService>();
    taskSchedulerService.setTimeout.mockReturnValue(new Subscription());
    delays = new Map([
      [activeUserId, ClearClipboardDelay.FiveMinutes],
      [otherUserId, ClearClipboardDelay.TenSeconds],
    ]);
    autofillSettingsService = mock<AutofillSettingsServiceAbstraction>();
    autofillSettingsService.clearClipboardDelay$ = of(ClearClipboardDelay.TwoMinutes);
    autofillSettingsService.clearClipboardDelayFor$.mockImplementation((userId) =>
      of(delays.get(userId) ?? ClearClipboardDelay.FiveMinutes),
    );
    clipboardUserIds$ = new BehaviorSubject<UserId[]>([activeUserId]);
  });

  describe("clearClipboard", () => {
    it("uses the active account's delay without the accounts that share the clipboard", async () => {
      const service = new SystemService(
        platformUtilsService,
        autofillSettingsService,
        taskSchedulerService,
      );

      await service.clearClipboard("secret");

      expect(taskSchedulerService.setTimeout).toHaveBeenCalledWith(
        ScheduledTaskNames.systemClearClipboardTimeout,
        120 * 1000,
      );
      expect(autofillSettingsService.clearClipboardDelayFor$).not.toHaveBeenCalled();
    });

    describe("with the accounts that share the clipboard", () => {
      let service: SystemService;

      beforeEach(() => {
        service = new SystemService(
          platformUtilsService,
          autofillSettingsService,
          taskSchedulerService,
          clipboardUserIds$,
        );
      });

      it("uses the delay of the one account that serves", async () => {
        await service.clearClipboard("secret");

        expect(scheduledDelay()).toBe(300 * 1000);
      });

      it("uses the shortest delay of the accounts that serve", async () => {
        clipboardUserIds$.next([activeUserId, otherUserId]);

        await service.clearClipboard("secret");

        expect(scheduledDelay()).toBe(10 * 1000);
      });

      it("clears after another account's delay when one account never clears", async () => {
        delays.set(activeUserId, ClearClipboardDelay.Never);
        clipboardUserIds$.next([activeUserId, otherUserId]);

        await service.clearClipboard("secret");

        expect(scheduledDelay()).toBe(10 * 1000);
      });

      it("never clears only when every account says so", async () => {
        delays.set(activeUserId, ClearClipboardDelay.Never);
        delays.set(otherUserId, ClearClipboardDelay.Never);
        clipboardUserIds$.next([activeUserId, otherUserId]);

        await service.clearClipboard("secret");

        expect(taskSchedulerService.setTimeout).not.toHaveBeenCalled();
      });

      it("uses the delay of the serving account while the active account is locked", async () => {
        clipboardUserIds$.next([otherUserId]);

        await service.clearClipboard("secret");

        expect(scheduledDelay()).toBe(10 * 1000);
      });

      it("falls back to the active account's delay while no account serves", async () => {
        clipboardUserIds$.next([]);

        await service.clearClipboard("secret");

        expect(scheduledDelay()).toBe(120 * 1000);
      });

      it("keeps a delay the caller gives", async () => {
        clipboardUserIds$.next([activeUserId, otherUserId]);

        await service.clearClipboard("secret", 5000);

        expect(scheduledDelay()).toBe(5000);
      });
    });
  });
});
