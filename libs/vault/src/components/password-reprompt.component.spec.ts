import { ComponentFixture, TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { mock, MockProxy } from "jest-mock-extended";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { MasterPasswordUnlockService } from "@bitwarden/common/key-management/master-password/abstractions/master-password-unlock.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import {
  FakeAccountService,
  mockAccountInfoWith,
  mockAccountServiceWith,
} from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { DIALOG_DATA, DialogRef, ToastService } from "@bitwarden/components";

import {
  PasswordRepromptComponent,
  PasswordRepromptDialogData,
} from "./password-reprompt.component";

describe("PasswordRepromptComponent", () => {
  const activeUserId = "active-user-id" as UserId;
  const otherUserId = "other-user-id" as UserId;

  let fixture: ComponentFixture<PasswordRepromptComponent>;
  let component: PasswordRepromptComponent;
  let masterPasswordUnlockService: MockProxy<MasterPasswordUnlockService>;
  let dialogRef: MockProxy<DialogRef>;
  let toastService: MockProxy<ToastService>;
  let accountService: FakeAccountService;

  /** Each account's master password is its own id. */
  const proofOfDecryption = async (masterPassword: string, userId: UserId) =>
    masterPassword === userId;

  async function setup(data?: PasswordRepromptDialogData) {
    masterPasswordUnlockService = mock<MasterPasswordUnlockService>();
    masterPasswordUnlockService.proofOfDecryption.mockImplementation(proofOfDecryption);
    dialogRef = mock<DialogRef>();
    toastService = mock<ToastService>();
    accountService = mockAccountServiceWith(activeUserId);
    await accountService.addAccount(
      otherUserId,
      mockAccountInfoWith({ email: "other@example.com" }),
    );
    await accountService.switchAccount(activeUserId);

    await TestBed.configureTestingModule({
      imports: [PasswordRepromptComponent],
      providers: [
        { provide: MasterPasswordUnlockService, useValue: masterPasswordUnlockService },
        { provide: PlatformUtilsService, useValue: mock<PlatformUtilsService>() },
        {
          provide: I18nService,
          useValue: { t: (key: string, ...args: string[]) => [key, ...args].join(" ") },
        },
        { provide: DialogRef, useValue: dialogRef },
        { provide: ToastService, useValue: toastService },
        { provide: AccountService, useValue: accountService },
        ...(data === undefined ? [] : [{ provide: DIALOG_DATA, useValue: data }]),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PasswordRepromptComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  const submit = async (masterPassword: string) => {
    component.formGroup.setValue({ masterPassword });
    await component.submit();
  };

  const accountLabel = () => fixture.debugElement.query(By.css('[data-testid="reprompt-account"]'));

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  describe("without an account", () => {
    beforeEach(() => setup());

    it("verifies the master password of the active account", async () => {
      await submit(activeUserId);

      expect(masterPasswordUnlockService.proofOfDecryption).toHaveBeenCalledWith(
        activeUserId,
        activeUserId,
      );
      expect(dialogRef.close).toHaveBeenCalledWith(true);
    });

    it("does not name an account", () => {
      expect(accountLabel()).toBeNull();
    });
  });

  describe("for an account other than the active one", () => {
    beforeEach(() => setup({ userId: otherUserId }));

    it("verifies the master password of that account", async () => {
      await submit(otherUserId);

      expect(masterPasswordUnlockService.proofOfDecryption).toHaveBeenCalledWith(
        otherUserId,
        otherUserId,
      );
      expect(dialogRef.close).toHaveBeenCalledWith(true);
    });

    it("rejects the master password of the active account", async () => {
      await submit(activeUserId);

      expect(masterPasswordUnlockService.proofOfDecryption).toHaveBeenCalledWith(
        activeUserId,
        otherUserId,
      );
      expect(dialogRef.close).not.toHaveBeenCalled();
      expect(toastService.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "error" }),
      );
    });

    it("names the account whose master password is asked for", () => {
      expect(accountLabel().nativeElement.textContent).toContain("other@example.com");
    });
  });

  describe("for the active account by id", () => {
    beforeEach(() => setup({ userId: activeUserId }));

    it("verifies its master password without naming it", async () => {
      await submit(activeUserId);

      expect(dialogRef.close).toHaveBeenCalledWith(true);
      expect(accountLabel()).toBeNull();
    });
  });
});
