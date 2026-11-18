import { ComponentFixture, TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { Router } from "@angular/router";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { UserId } from "@bitwarden/common/types/guid";
import { BiometricsService } from "@bitwarden/key-management";

import { AccountComponent } from "./account.component";
import { AccountSwitcherService, AvailableAccount } from "./services/account-switcher.service";

describe("AccountComponent", () => {
  const userId = "user-1" as UserId;
  const unlockedAccount: AvailableAccount = {
    name: "Test User",
    email: "test@example.com",
    id: userId,
    isActive: false,
    server: "bitwarden.com",
    status: AuthenticationStatus.Unlocked,
  };

  let fixture: ComponentFixture<AccountComponent>;
  let accountSwitcherService: MockProxy<AccountSwitcherService>;
  let autofillAccountsService: MockProxy<AutofillAccountsService>;
  let logService: MockProxy<LogService>;
  let enabled$: BehaviorSubject<boolean>;
  let isAutofillUser$: BehaviorSubject<boolean>;

  beforeEach(async () => {
    accountSwitcherService = mock<AccountSwitcherService>();
    accountSwitcherService.SPECIAL_ADD_ACCOUNT_ID = "addAccount";
    accountSwitcherService.selectAccount.mockResolvedValue(null);

    enabled$ = new BehaviorSubject(false);
    isAutofillUser$ = new BehaviorSubject(false);
    autofillAccountsService = mock<AutofillAccountsService>();
    autofillAccountsService.enabled$.mockReturnValue(enabled$);
    autofillAccountsService.isAutofillUser$.mockReturnValue(isAutofillUser$);
    autofillAccountsService.setEnabled.mockImplementation(async (_, enabled) =>
      enabled$.next(enabled),
    );

    logService = mock<LogService>();
    const i18nService = mock<I18nService>();
    i18nService.t.mockImplementation((key) => key);

    await TestBed.configureTestingModule({
      imports: [AccountComponent],
      providers: [
        { provide: AccountSwitcherService, useValue: accountSwitcherService },
        { provide: AutofillAccountsService, useValue: autofillAccountsService },
        { provide: Router, useValue: mock<Router>() },
        { provide: I18nService, useValue: i18nService },
        { provide: LogService, useValue: logService },
        { provide: BiometricsService, useValue: mock<BiometricsService>() },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AccountComponent);
  });

  function render(account: AvailableAccount, offerAutofillOptIn = true) {
    fixture.componentRef.setInput("account", account);
    fixture.componentRef.setInput("offerAutofillOptIn", offerAutofillOptIn);
    fixture.detectChanges();
  }

  const optInSwitch = () =>
    fixture.debugElement.query(By.css("[data-testid='account-autofill-opt-in']"));
  const optInInput = (): HTMLInputElement =>
    optInSwitch().nativeElement.querySelector("input[type=checkbox]");
  const servingIndicator = () =>
    fixture.debugElement.query(By.css("[data-testid='account-serving-autofill']"));

  describe("autofill opt-in", () => {
    it("is not shown unless offered", () => {
      render(unlockedAccount, false);

      expect(optInSwitch()).toBeNull();
    });

    it("is not shown on the add account row", () => {
      render({ name: "addAccount", id: "addAccount", isActive: false });

      expect(optInSwitch()).toBeNull();
      expect(autofillAccountsService.enabled$).not.toHaveBeenCalled();
    });

    it("shows the stored setting of the account", () => {
      enabled$.next(true);
      render(unlockedAccount);

      expect(autofillAccountsService.enabled$).toHaveBeenCalledWith(userId);
      expect(optInInput().checked).toBe(true);
    });

    it("labels the switch and explains the risk", () => {
      render(unlockedAccount);

      const text = optInSwitch().nativeElement.closest("bit-form-control").textContent;
      expect(text).toContain("useAccountForAutofill");
      expect(text).toContain(unlockedAccount.email);
      expect(text).toContain("useAccountForAutofillDesc");
      expect(text).not.toContain("unlockAccountToChangeAutofill");
    });

    it("saves the setting without switching to the account", () => {
      render(unlockedAccount);

      optInInput().click();
      fixture.detectChanges();

      expect(autofillAccountsService.setEnabled).toHaveBeenCalledWith(userId, true);
      expect(accountSwitcherService.selectAccount).not.toHaveBeenCalled();
      expect(optInInput().checked).toBe(true);
    });

    it("reverts the switch when saving fails", async () => {
      // Saving writes to storage, so a failure arrives after the click has been rendered.
      autofillAccountsService.setEnabled.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("failed")))),
      );
      render(unlockedAccount);

      optInInput().click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(logService.error).toHaveBeenCalled();
      expect(optInInput().checked).toBe(false);
    });

    it("is read-only while the account is locked", () => {
      enabled$.next(true);
      render({ ...unlockedAccount, status: AuthenticationStatus.Locked });

      expect(optInInput().checked).toBe(true);
      expect(optInInput().getAttribute("aria-disabled")).toBe("true");
      expect(optInSwitch().nativeElement.closest("bit-form-control").textContent).toContain(
        "unlockAccountToChangeAutofill",
      );

      optInInput().click();
      fixture.detectChanges();

      expect(autofillAccountsService.setEnabled).not.toHaveBeenCalled();
      expect(optInInput().checked).toBe(true);
    });

    it("becomes changeable once the account is unlocked", () => {
      render({ ...unlockedAccount, status: AuthenticationStatus.Locked });
      render(unlockedAccount);

      expect(optInInput().getAttribute("aria-disabled")).toBe("false");
    });
  });

  describe("serving autofill indicator", () => {
    it("is shown for an inactive account that serves autofill", () => {
      isAutofillUser$.next(true);
      render(unlockedAccount);

      expect(autofillAccountsService.isAutofillUser$).toHaveBeenCalledWith(userId);
      expect(servingIndicator()).not.toBeNull();
    });

    it("is not shown for the active account", () => {
      isAutofillUser$.next(true);
      render({ ...unlockedAccount, isActive: true });

      expect(servingIndicator()).toBeNull();
    });

    it("follows changes of the autofill accounts", () => {
      render(unlockedAccount);
      expect(servingIndicator()).toBeNull();

      isAutofillUser$.next(true);
      fixture.detectChanges();

      expect(servingIndicator()).not.toBeNull();
    });
  });
});
