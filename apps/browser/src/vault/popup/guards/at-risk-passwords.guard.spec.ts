import { TestBed } from "@angular/core/testing";
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from "@angular/router";
import { mock } from "jest-mock-extended";
import { firstValueFrom, Observable, of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { SecurityTaskType, TaskService } from "@bitwarden/common/vault/tasks";
import { ToastService } from "@bitwarden/components";

import { canAccessAtRiskPasswords, hasAtRiskPasswords } from "./at-risk-passwords.guard";

describe("at-risk passwords guards", () => {
  const activeUserId = "active-user" as UserId;
  const otherUserId = "other-user" as UserId;
  const vaultTree = new UrlTree();

  const taskService = mock<TaskService>();
  const cipherService = mock<CipherService>();
  const toastService = mock<ToastService>();
  const createUrlTree = jest.fn();
  const isAutofillUser$ = jest.fn();
  /** The accounts that have tasks enabled and an at-risk password. */
  let accountsWithTasks: UserId[];

  const run = (guard: typeof hasAtRiskPasswords, queryParams: Record<string, string>) =>
    firstValueFrom(
      TestBed.runInInjectionContext(() =>
        guard(
          { queryParams } as unknown as ActivatedRouteSnapshot,
          { url: "/at-risk-passwords" } as RouterStateSnapshot,
        ),
      ) as Observable<boolean | UrlTree>,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    accountsWithTasks = [];
    createUrlTree.mockReturnValue(vaultTree);
    isAutofillUser$.mockReturnValue(of(true));
    taskService.tasksEnabled$.mockImplementation((userId) =>
      of(accountsWithTasks.includes(userId)),
    );
    taskService.pendingTasks$.mockImplementation((userId) =>
      of(
        accountsWithTasks.includes(userId)
          ? ([{ type: SecurityTaskType.UpdateAtRiskCredential, cipherId: "cipher-1" }] as any)
          : [],
      ),
    );
    cipherService.cipherViews$.mockReturnValue(of([{ id: "cipher-1", isDeleted: false }] as any));

    TestBed.configureTestingModule({
      providers: [
        { provide: AccountService, useValue: mockAccountServiceWith(activeUserId) },
        { provide: AutofillAccountsService, useValue: { isAutofillUser$ } },
        { provide: TaskService, useValue: taskService },
        { provide: CipherService, useValue: cipherService },
        { provide: ToastService, useValue: toastService },
        { provide: I18nService, useValue: { t: (key: string) => key } },
        { provide: Router, useValue: { createUrlTree } },
      ],
    });
  });

  describe("without `userId`", () => {
    it("asks the active account", async () => {
      accountsWithTasks = [activeUserId];

      expect(await run(canAccessAtRiskPasswords, {})).toBe(true);
      expect(await run(hasAtRiskPasswords, {})).toBe(true);
      expect(taskService.tasksEnabled$).toHaveBeenCalledWith(activeUserId);
      expect(taskService.pendingTasks$).toHaveBeenCalledWith(activeUserId);
      expect(cipherService.cipherViews$).toHaveBeenCalledWith(activeUserId);
      expect(isAutofillUser$).not.toHaveBeenCalled();
    });

    it("goes to the vault when the active account has no at-risk passwords", async () => {
      expect(await run(canAccessAtRiskPasswords, {})).toBe(vaultTree);
      expect(await run(hasAtRiskPasswords, {})).toBe(vaultTree);
      expect(createUrlTree).toHaveBeenCalledWith(["/tabs/vault"]);
    });
  });

  describe("with `userId`", () => {
    it("asks that account and never the active one", async () => {
      accountsWithTasks = [otherUserId];

      expect(await run(canAccessAtRiskPasswords, { userId: otherUserId })).toBe(true);
      expect(await run(hasAtRiskPasswords, { userId: otherUserId })).toBe(true);
      expect(taskService.tasksEnabled$).toHaveBeenCalledWith(otherUserId);
      expect(taskService.pendingTasks$).toHaveBeenCalledWith(otherUserId);
      expect(cipherService.cipherViews$).toHaveBeenCalledWith(otherUserId);
      for (const read of [
        taskService.tasksEnabled$,
        taskService.pendingTasks$,
        cipherService.cipherViews$,
      ]) {
        expect(read).not.toHaveBeenCalledWith(activeUserId);
      }
    });

    it("is not opened by the active account's at-risk passwords", async () => {
      accountsWithTasks = [activeUserId];

      expect(await run(canAccessAtRiskPasswords, { userId: otherUserId })).toBe(vaultTree);
      expect(await run(hasAtRiskPasswords, { userId: otherUserId })).toBe(vaultTree);
    });

    it("reads no vault for an account that does not serve autofill", async () => {
      // The page of such an account loads nothing and leaves; see `VaultPopupItemAccount`.
      isAutofillUser$.mockReturnValue(of(false));
      accountsWithTasks = [activeUserId, otherUserId];

      expect(await run(canAccessAtRiskPasswords, { userId: otherUserId })).toBe(true);
      expect(await run(hasAtRiskPasswords, { userId: otherUserId })).toBe(true);
      expect(taskService.tasksEnabled$).not.toHaveBeenCalled();
      expect(taskService.pendingTasks$).not.toHaveBeenCalled();
      expect(cipherService.cipherViews$).not.toHaveBeenCalled();
    });
  });
});
