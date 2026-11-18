import { mock } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom } from "rxjs";

import {
  FakeAccountService,
  FakeStateProvider,
  mockAccountInfoWith,
  mockAccountServiceWith,
} from "../../../spec";
import { AuthService } from "../../auth/abstractions/auth.service";
import { AuthenticationStatus } from "../../auth/enums/authentication-status";
import { UserId } from "../../types/guid";

import {
  DefaultAutofillAccountsService,
  MULTI_ACCOUNT_AUTOFILL_ENABLED,
} from "./autofill-accounts.service";

describe("DefaultAutofillAccountsService", () => {
  // Ids are deliberately out of alphabetical order, so a test that passes proves the order is the
  // one the accounts were added in.
  const active = "user-m" as UserId;
  const second = "user-z" as UserId;
  const third = "user-a" as UserId;

  let accountService: FakeAccountService;
  let stateProvider: FakeStateProvider;
  let statuses: Map<UserId, BehaviorSubject<AuthenticationStatus>>;
  let service: DefaultAutofillAccountsService;

  const setStatus = (userId: UserId, status: AuthenticationStatus) =>
    statusFor(userId).next(status);

  const statusFor = (userId: UserId) => {
    if (!statuses.has(userId)) {
      statuses.set(userId, new BehaviorSubject<AuthenticationStatus>(AuthenticationStatus.Locked));
    }
    return statuses.get(userId)!;
  };

  const collect = () => {
    const emissions: UserId[][] = [];
    const subscription = service.autofillUserIds$.subscribe((userIds) => emissions.push(userIds));
    return { emissions, subscription };
  };

  const current = () => firstValueFrom(service.autofillUserIds$);

  beforeEach(async () => {
    accountService = mockAccountServiceWith(active);
    await accountService.addAccount(second, mockAccountInfoWith());
    await accountService.addAccount(third, mockAccountInfoWith());
    stateProvider = new FakeStateProvider(accountService);

    statuses = new Map();
    for (const userId of [active, second, third]) {
      setStatus(userId, AuthenticationStatus.Unlocked);
    }
    const authService = mock<AuthService>();
    authService.authStatusFor$.mockImplementation((userId) => statusFor(userId));

    service = new DefaultAutofillAccountsService(stateProvider, accountService, authService);
  });

  describe("enabled$", () => {
    it("defaults to false", async () => {
      await expect(firstValueFrom(service.enabled$(second))).resolves.toBe(false);
    });

    it("reads what setEnabled stored for that account only", async () => {
      await service.setEnabled(second, true);

      await expect(firstValueFrom(service.enabled$(second))).resolves.toBe(true);
      await expect(firstValueFrom(service.enabled$(third))).resolves.toBe(false);
    });

    it("is stored per account and cleared on logout", () => {
      expect(MULTI_ACCOUNT_AUTOFILL_ENABLED.clearOn).toEqual(["logout"]);
      expect(MULTI_ACCOUNT_AUTOFILL_ENABLED.stateDefinition.defaultStorageLocation).toBe("disk");
    });
  });

  describe("autofillUserIds$", () => {
    it("is only the active account when no account has opted in", async () => {
      await expect(current()).resolves.toEqual([active]);
    });

    it("is empty when no account has opted in and the active account is locked", async () => {
      setStatus(active, AuthenticationStatus.Locked);

      await expect(current()).resolves.toEqual([]);
    });

    it("does not depend on the active account's own opt-in", async () => {
      await service.setEnabled(active, false);

      await expect(current()).resolves.toEqual([active]);
    });

    it("lists the active account first, then unlocked accounts that opted in", async () => {
      await service.setEnabled(second, true);

      await expect(current()).resolves.toEqual([active, second]);
    });

    it("leaves out an unlocked account that has not opted in", async () => {
      await service.setEnabled(third, true);

      await expect(current()).resolves.toEqual([active, third]);
    });

    it("leaves out an opted-in account that is locked", async () => {
      await service.setEnabled(second, true);
      setStatus(second, AuthenticationStatus.Locked);

      await expect(current()).resolves.toEqual([active]);
    });

    it("lists an opted-in unlocked account while the active account is locked", async () => {
      await service.setEnabled(second, true);
      setStatus(active, AuthenticationStatus.Locked);

      await expect(current()).resolves.toEqual([second]);
    });

    it("lists opted-in unlocked accounts when there is no active account", async () => {
      await service.setEnabled(second, true);
      await accountService.switchAccount(null as unknown as UserId);

      await expect(current()).resolves.toEqual([second]);
    });

    it("is empty when there are no accounts", async () => {
      accountService.accountsSubject.next({});
      await accountService.switchAccount(null as unknown as UserId);

      await expect(current()).resolves.toEqual([]);
    });

    it("reacts to lock and unlock of an account that is not active", async () => {
      await service.setEnabled(second, true);
      const { emissions, subscription } = collect();

      setStatus(second, AuthenticationStatus.Locked);
      setStatus(second, AuthenticationStatus.Unlocked);

      expect(emissions).toEqual([[active, second], [active], [active, second]]);
      subscription.unsubscribe();
    });

    it("reacts to the opt-in changing", async () => {
      const { emissions, subscription } = collect();

      await service.setEnabled(second, true);
      await service.setEnabled(second, false);

      expect(emissions).toEqual([[active], [active, second], [active]]);
      subscription.unsubscribe();
    });

    it("drops an account that logs out", async () => {
      await service.setEnabled(second, true);
      const { emissions, subscription } = collect();

      setStatus(second, AuthenticationStatus.LoggedOut);

      expect(emissions).toEqual([[active, second], [active]]);
      subscription.unsubscribe();
    });

    it("drops an account that is removed from the client", async () => {
      await service.setEnabled(second, true);
      const { emissions, subscription } = collect();

      accountService.accountsSubject.next({
        [active]: mockAccountInfoWith(),
        [third]: mockAccountInfoWith(),
      });

      expect(emissions).toEqual([[active, second], [active]]);
      subscription.unsubscribe();
    });

    it("moves the newly active account to the front on a switch", async () => {
      await service.setEnabled(active, true);
      await service.setEnabled(second, true);
      const { emissions, subscription } = collect();

      await accountService.switchAccount(second);

      expect(emissions).toEqual([
        [active, second],
        [second, active],
      ]);
      subscription.unsubscribe();
    });

    it("drops the previously active account on a switch when it has not opted in", async () => {
      await service.setEnabled(second, true);

      await accountService.switchAccount(second);

      await expect(current()).resolves.toEqual([second]);
    });

    it("keeps the other accounts in the order they were added", async () => {
      await service.setEnabled(third, true);
      await service.setEnabled(second, true);
      await service.setEnabled(active, true);

      await expect(current()).resolves.toEqual([active, second, third]);

      await accountService.switchAccount(third);
      await expect(current()).resolves.toEqual([third, active, second]);

      setStatus(active, AuthenticationStatus.Locked);
      setStatus(active, AuthenticationStatus.Unlocked);
      await expect(current()).resolves.toEqual([third, active, second]);
    });

    it("does not emit when the list is unchanged", async () => {
      await service.setEnabled(second, true);
      const { emissions, subscription } = collect();

      // None of these changes who serves autofill.
      await service.setEnabled(second, true);
      setStatus(third, AuthenticationStatus.Locked);
      await service.setEnabled(active, true);
      await accountService.setAccountActivity(second, new Date());
      accountService.accountsSubject.next({
        [active]: mockAccountInfoWith({ name: "renamed" }),
        [second]: mockAccountInfoWith(),
        [third]: mockAccountInfoWith(),
      });

      expect(emissions).toEqual([[active, second]]);
      subscription.unsubscribe();
    });
  });

  describe("isAutofillUser$", () => {
    it("follows membership of autofillUserIds$", async () => {
      const emissions: boolean[] = [];
      const subscription = service.isAutofillUser$(second).subscribe((is) => emissions.push(is));

      await service.setEnabled(second, true);
      setStatus(third, AuthenticationStatus.Locked);
      setStatus(second, AuthenticationStatus.Locked);

      expect(emissions).toEqual([false, true, false]);
      subscription.unsubscribe();
    });
  });
});
