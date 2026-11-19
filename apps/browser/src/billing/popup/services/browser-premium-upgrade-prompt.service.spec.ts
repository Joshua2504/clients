import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { PremiumUpgradeDialogComponent } from "@bitwarden/angular/billing/components";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { UserId } from "@bitwarden/common/types/guid";
import { DialogService } from "@bitwarden/components";

import { BrowserPremiumUpgradePromptService } from "./browser-premium-upgrade-prompt.service";

describe("BrowserPremiumUpgradePromptService", () => {
  let service: BrowserPremiumUpgradePromptService;
  let dialogService: MockProxy<DialogService>;

  const activeUserId = "active-user" as UserId;
  const otherUserId = "other-user" as UserId;
  const accountService = {
    activeAccount$: new BehaviorSubject({ id: activeUserId } as Account),
    accounts$: new BehaviorSubject({
      [activeUserId]: { email: "active@example.com" },
      [otherUserId]: { email: "other@example.com" },
    }),
  };

  beforeEach(async () => {
    dialogService = mock<DialogService>();

    await TestBed.configureTestingModule({
      providers: [
        BrowserPremiumUpgradePromptService,
        { provide: DialogService, useValue: dialogService },
        { provide: AccountService, useValue: accountService },
      ],
    }).compileComponents();

    service = TestBed.inject(BrowserPremiumUpgradePromptService);
  });

  describe("promptForPremium", () => {
    let openSpy: jest.SpyInstance;

    beforeEach(() => {
      openSpy = jest.spyOn(PremiumUpgradeDialogComponent, "open").mockImplementation();
    });

    afterEach(() => {
      openSpy.mockRestore();
    });

    it("opens the premium upgrade dialog", async () => {
      await service.promptForPremium();

      expect(openSpy).toHaveBeenCalledWith(dialogService);
      expect(dialogService.openSimpleDialog).not.toHaveBeenCalled();
    });

    it("opens the premium upgrade dialog when the named account is the active account", async () => {
      await service.promptForPremium(undefined, activeUserId);

      expect(openSpy).toHaveBeenCalledWith(dialogService);
      expect(dialogService.openSimpleDialog).not.toHaveBeenCalled();
    });

    it("names the account that needs premium instead of upgrading the active account", async () => {
      await service.promptForPremium("org-id", otherUserId);

      expect(openSpy).not.toHaveBeenCalled();
      expect(dialogService.openSimpleDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: { key: "premiumRequiredForAccountTitle" },
          content: { key: "premiumRequiredForAccount", placeholders: ["other@example.com"] },
        }),
      );
    });
  });
});
