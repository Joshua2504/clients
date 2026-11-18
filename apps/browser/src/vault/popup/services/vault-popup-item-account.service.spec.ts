import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Params, Router } from "@angular/router";
import { BehaviorSubject, firstValueFrom, Observable } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import {
  FakeAccountService,
  mockAccountInfoWith,
  mockAccountServiceWith,
} from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";

import BrowserPopupUtils from "../../../platform/browser/browser-popup-utils";
import { PopupRouterCacheService } from "../../../platform/popup/view-cache/popup-router-cache.service";
import { PopupCloseWarningService } from "../../../popup/services/popup-close-warning.service";

import {
  itemAccountFromParams,
  itemAccountQueryParams,
  VaultPopupItemAccount,
} from "./vault-popup-item-account.service";

describe("VaultPopupItemAccount", () => {
  const activeUserId = "active-user-id" as UserId;
  const otherUserId = "other-user-id" as UserId;

  let queryParams$: BehaviorSubject<Params>;
  let accountService: FakeAccountService;
  let serves: Map<UserId, BehaviorSubject<boolean>>;
  let isAutofillUser$: jest.Mock<Observable<boolean>, [UserId]>;
  const navigate = jest.fn().mockResolvedValue(true);
  const setHistory = jest.fn().mockResolvedValue([]);
  const disableCloseWarning = jest.fn();
  let inPopout: jest.SpyInstance;
  let closeCurrentPopupOrPopout: jest.SpyInstance;

  /** Lets the promises that leaving the page awaits settle. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

  const create = async (params: Params = {}) => {
    queryParams$.next(params);
    const itemAccount = TestBed.inject(VaultPopupItemAccount);
    await settle();
    return itemAccount;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    queryParams$ = new BehaviorSubject<Params>({});
    accountService = mockAccountServiceWith(activeUserId, { email: "active@example.com" });
    await accountService.addAccount(
      otherUserId,
      mockAccountInfoWith({ email: "other@example.com" }),
    );
    await accountService.switchAccount(activeUserId);
    serves = new Map([
      [activeUserId, new BehaviorSubject(true)],
      [otherUserId, new BehaviorSubject(true)],
    ]);
    isAutofillUser$ = jest.fn((userId: UserId) => serves.get(userId)!.asObservable());
    inPopout = jest.spyOn(BrowserPopupUtils, "inPopout").mockReturnValue(false);
    closeCurrentPopupOrPopout = jest
      .spyOn(BrowserPopupUtils, "closeCurrentPopupOrPopout")
      .mockResolvedValue();

    TestBed.configureTestingModule({
      providers: [
        VaultPopupItemAccount,
        { provide: ActivatedRoute, useValue: { queryParams: queryParams$ } },
        { provide: Router, useValue: { navigate } },
        { provide: AccountService, useValue: accountService },
        { provide: AutofillAccountsService, useValue: { isAutofillUser$ } },
        { provide: PopupRouterCacheService, useValue: { setHistory } },
        { provide: PopupCloseWarningService, useValue: { disable: disableCloseWarning } },
      ],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("without a userId", () => {
    it("operates on the active account", async () => {
      const itemAccount = await create({ cipherId: "cipher-id" });

      expect(itemAccount.explicitUserId()).toBeUndefined();
      await expect(itemAccount.userId()).resolves.toBe(activeUserId);
      await expect(firstValueFrom(itemAccount.userId$)).resolves.toBe(activeUserId);
      expect(itemAccount.queryParams()).toEqual({});
      expect(itemAccount.accountHint()).toBeUndefined();
    });

    it("does not ask whether any account serves autofill", async () => {
      const itemAccount = await create();
      await itemAccount.userId();

      expect(isAutofillUser$).not.toHaveBeenCalled();
    });

    it("stays when another account locks", async () => {
      await create();

      serves.get(otherUserId)!.next(false);
      await settle();

      expect(navigate).not.toHaveBeenCalled();
      expect(closeCurrentPopupOrPopout).not.toHaveBeenCalled();
    });
  });

  describe("with the userId of another unlocked autofill account", () => {
    it("operates on that account", async () => {
      const itemAccount = await create({ cipherId: "cipher-id", userId: otherUserId });

      expect(itemAccount.explicitUserId()).toBe(otherUserId);
      await expect(itemAccount.userId()).resolves.toBe(otherUserId);
      await expect(firstValueFrom(itemAccount.userId$)).resolves.toBe(otherUserId);
      expect(itemAccount.queryParams()).toEqual({ userId: otherUserId });
    });

    it("names that account for the header hint", async () => {
      const itemAccount = await create({ userId: otherUserId });

      expect(itemAccount.accountHint()).toBe("other@example.com");
    });

    it("drops the hint once that account is the active one", async () => {
      const itemAccount = await create({ userId: otherUserId });

      await accountService.switchAccount(otherUserId);
      await settle();

      expect(itemAccount.accountHint()).toBeUndefined();
      await expect(itemAccount.userId()).resolves.toBe(otherUserId);
    });

    it("keeps operating on that account when the active account changes", async () => {
      const itemAccount = await create({ userId: otherUserId });
      const thirdUserId = "third-user-id" as UserId;
      await accountService.addAccount(thirdUserId, mockAccountInfoWith());

      await accountService.switchAccount(thirdUserId);
      await settle();

      await expect(itemAccount.userId()).resolves.toBe(otherUserId);
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe("when the named account stops serving autofill", () => {
    it("leaves a popup page for the vault and never uses the active account", async () => {
      const itemAccount = await create({ userId: otherUserId });

      serves.get(otherUserId)!.next(false);
      await settle();

      expect(setHistory).toHaveBeenCalledWith([]);
      expect(navigate).toHaveBeenCalledWith(["/tabs/vault"]);
      await expect(itemAccount.userId()).resolves.toBeNull();
    });

    it("closes a single action popout", async () => {
      inPopout.mockReturnValue(true);
      const href = jest.spyOn(window, "location", "get").mockReturnValue({
        href: "chrome-extension://id/popup/index.html?uilocation=popout&singleActionPopout=vault_viewVaultItem_1#/view-cipher",
      } as Location);
      await create({ userId: otherUserId });

      serves.get(otherUserId)!.next(false);
      await settle();

      expect(disableCloseWarning).toHaveBeenCalled();
      expect(closeCurrentPopupOrPopout).toHaveBeenCalledWith(window);
      expect(navigate).not.toHaveBeenCalled();
      href.mockRestore();
    });

    it("leaves only once", async () => {
      await create({ userId: otherUserId });

      serves.get(otherUserId)!.next(false);
      serves.get(otherUserId)!.next(true);
      serves.get(otherUserId)!.next(false);
      await settle();

      expect(navigate).toHaveBeenCalledTimes(1);
    });

    it("leaves a page that was opened for an account that does not serve", async () => {
      serves.get(otherUserId)!.next(false);

      const itemAccount = await create({ userId: otherUserId });

      await expect(itemAccount.userId()).resolves.toBeNull();
      expect(navigate).toHaveBeenCalledWith(["/tabs/vault"]);
    });

    it("leaves the lock of the active account to the popup's lock handling", async () => {
      const itemAccount = await create({ userId: activeUserId });

      serves.get(activeUserId)!.next(false);
      await settle();

      expect(navigate).not.toHaveBeenCalled();
      expect(closeCurrentPopupOrPopout).not.toHaveBeenCalled();
      await expect(itemAccount.userId()).resolves.toBeNull();
    });
  });

  describe("query params", () => {
    it("reads the account from `userId`", () => {
      expect(itemAccountFromParams({ userId: otherUserId })).toBe(otherUserId);
      expect(itemAccountFromParams({ cipherId: "cipher-id" })).toBeUndefined();
      expect(itemAccountFromParams({ userId: "" })).toBeUndefined();
    });

    it("carries the account as `userId`", () => {
      expect(itemAccountQueryParams(otherUserId)).toEqual({ userId: otherUserId });
      expect(itemAccountQueryParams(undefined)).toEqual({});
    });
  });
});
