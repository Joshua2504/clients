import { CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { ComponentFixture, fakeAsync, TestBed, tick } from "@angular/core/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { Router } from "@angular/router";
import { mock } from "jest-mock-extended";
import { BehaviorSubject, of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherRepromptType, CipherType } from "@bitwarden/common/vault/enums";
import { CompactModeService, DialogService } from "@bitwarden/components";
import { PasswordRepromptService } from "@bitwarden/vault";

import { BrowserApi } from "../../../../../platform/browser/browser-api";
import BrowserPopupUtils from "../../../../../platform/browser/browser-popup-utils";
import { VaultPopupAutofillService } from "../../../services/vault-popup-autofill.service";
import { VaultPopupSectionService } from "../../../services/vault-popup-section.service";
import { PopupCipherViewLike } from "../../../views/popup-cipher.view";

import { VaultListItemsContainerComponent } from "./vault-list-items-container.component";

describe("VaultListItemsContainerComponent", () => {
  let fixture: ComponentFixture<VaultListItemsContainerComponent>;
  let component: VaultListItemsContainerComponent;

  const currentTabIsOnBlocklist$ = new BehaviorSubject<boolean>(false);

  const mockCipher = {
    id: "cipher-1",
    name: "Test Login",
    type: CipherType.Login,
    login: {
      username: "user@example.com",
      uris: [{ uri: "https://example.com", match: null }],
    },
    favorite: false,
    reprompt: 0,
    organizationId: null,
    collectionIds: [],
    edit: true,
    viewPassword: true,
  } as any;

  const vaultPopupAutofillService = {
    currentTabIsOnBlocklist$: currentTabIsOnBlocklist$.asObservable(),
    doAutofill: jest.fn(),
    doAutofillForAccount: jest.fn(),
    viewAccountCipher: jest.fn(),
  };

  const cipherService = mock<CipherService>();
  const router = { navigate: jest.fn() };
  const passwordRepromptService = mock<PasswordRepromptService>();

  const compactModeService = {
    enabled$: of(false),
  };

  const vaultPopupSectionService = {
    getOpenDisplayStateForSection: jest.fn().mockReturnValue(() => true),
    updateSectionOpenStoredState: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    currentTabIsOnBlocklist$.next(false);

    await TestBed.configureTestingModule({
      imports: [VaultListItemsContainerComponent, NoopAnimationsModule],
      providers: [
        { provide: VaultPopupAutofillService, useValue: vaultPopupAutofillService },
        { provide: CompactModeService, useValue: compactModeService },
        { provide: VaultPopupSectionService, useValue: vaultPopupSectionService },
        { provide: I18nService, useValue: { t: (k: string) => k } },
        { provide: AccountService, useValue: { activeAccount$: of({ id: "UserId" }) } },
        { provide: CipherService, useValue: cipherService },
        { provide: Router, useValue: router },
        { provide: PasswordRepromptService, useValue: passwordRepromptService },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    })
      .overrideProvider(DialogService, { useValue: mock<DialogService>() })
      .compileComponents();

    fixture = TestBed.createComponent(VaultListItemsContainerComponent);
    component = fixture.componentInstance;
  });

  describe("item actions", () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it("should show fill text on hover for autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", true);
      fixture.detectChanges();

      expect(component.showFillTextOnHover()).toBe(true);
    });

    it("should not show fill text on hover for non-autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", false);
      fixture.detectChanges();

      expect(component.showFillTextOnHover()).toBe(false);
    });

    it("should hide launch button for autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", true);
      fixture.detectChanges();

      expect(component.showLaunchButton()).toBe(false);
    });

    it("should show launch button for non-autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", false);
      fixture.detectChanges();

      expect(component.showLaunchButton()).toBe(true);
    });

    it("should show autofill in menu for non-autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", false);
      fixture.detectChanges();

      expect(component.showAutofillInMenu()).toBe(true);
    });

    it("should hide autofill in menu for autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", true);
      fixture.detectChanges();

      expect(component.showAutofillInMenu()).toBe(false);
    });

    it("should show view in menu for autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", true);
      fixture.detectChanges();

      expect(component.showViewInMenu()).toBe(true);
    });

    it("should hide view in menu for non-autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", false);
      fixture.detectChanges();

      expect(component.showViewInMenu()).toBe(false);
    });

    it("should autofill on select for autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", true);
      fixture.detectChanges();

      expect(component.canAutofill()).toBe(true);
    });

    it("should not autofill on select for non-autofill list items", () => {
      fixture.componentRef.setInput("isAutofillList", false);
      fixture.detectChanges();

      expect(component.canAutofill()).toBe(false);
    });

    describe("when current URI is blocked", () => {
      beforeEach(() => {
        currentTabIsOnBlocklist$.next(true);
        fixture.detectChanges();
      });

      it("should not autofill on select even when isAutofillList is true", () => {
        fixture.componentRef.setInput("isAutofillList", true);
        fixture.detectChanges();

        expect(component.canAutofill()).toBe(false);
      });
    });
  });

  describe("ciphers of a further autofill account", () => {
    const otherUserId = "OtherUserId" as UserId;
    const repromptCipher = { ...mockCipher, reprompt: CipherRepromptType.Password };

    beforeEach(() => {
      fixture.componentRef.setInput("isAutofillList", true);
      fixture.componentRef.setInput("accountUserId", otherUserId);
      fixture.detectChanges();
    });

    it("fills for the account that owns the cipher", async () => {
      await component.onCipherSelect(mockCipher);

      expect(vaultPopupAutofillService.doAutofillForAccount).toHaveBeenCalledWith({
        userId: otherUserId,
        cipher: mockCipher,
      });
      // Never the active account's fill.
      expect(vaultPopupAutofillService.doAutofill).not.toHaveBeenCalled();
    });

    it("fills a shared item under the account of the section it was picked from", async () => {
      await component.doAutofill(mockCipher);
      fixture.componentRef.setInput("accountUserId", undefined);
      fixture.detectChanges();
      await component.doAutofill(mockCipher);

      expect(vaultPopupAutofillService.doAutofillForAccount).toHaveBeenCalledTimes(1);
      expect(vaultPopupAutofillService.doAutofillForAccount).toHaveBeenCalledWith({
        userId: otherUserId,
        cipher: mockCipher,
      });
      expect(vaultPopupAutofillService.doAutofill).toHaveBeenCalledTimes(1);
      expect(vaultPopupAutofillService.doAutofill).toHaveBeenCalledWith(mockCipher);
    });

    it("opens the item in its own account instead of viewing it in the active account", fakeAsync(() => {
      void component.onViewCipher(mockCipher);
      tick(200);

      expect(vaultPopupAutofillService.viewAccountCipher).toHaveBeenCalledWith({
        userId: otherUserId,
        cipher: mockCipher,
      });
      // The reprompt and the view page act on the active account: they wait for the switch.
      expect(passwordRepromptService.passwordRepromptCheck).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();
    }));

    it("opens an item that requires a master password reprompt instead of filling it", fakeAsync(() => {
      void component.onCipherSelect(repromptCipher);
      tick(200);

      expect(vaultPopupAutofillService.doAutofillForAccount).not.toHaveBeenCalled();
      expect(vaultPopupAutofillService.doAutofill).not.toHaveBeenCalled();
      expect(vaultPopupAutofillService.viewAccountCipher).toHaveBeenCalledWith({
        userId: otherUserId,
        cipher: repromptCipher,
      });
      expect(component.cipherItemTitleKey()(repromptCipher)).toBe("viewItemTitleWithField");
      expect(component.cipherItemTitleKey()(mockCipher)).toBe("autofillTitleWithField");
    }));

    it("records a launch for the account that owns the cipher", async () => {
      jest.spyOn(BrowserApi, "createNewTab").mockResolvedValue(undefined as any);
      jest.spyOn(BrowserPopupUtils, "inPopup").mockReturnValue(false);

      await component.launchCipher(mockCipher);

      expect(cipherService.updateLastLaunchedDate).toHaveBeenCalledWith("cipher-1", otherUserId);
    });
  });

  describe("ciphers of the active account", () => {
    beforeEach(() => {
      fixture.componentRef.setInput("isAutofillList", true);
      fixture.detectChanges();
    });

    it("fills a cipher that requires a master password reprompt as before", async () => {
      const repromptCipher = { ...mockCipher, reprompt: CipherRepromptType.Password };

      await component.onCipherSelect(repromptCipher);

      expect(vaultPopupAutofillService.doAutofill).toHaveBeenCalledWith(repromptCipher);
      expect(vaultPopupAutofillService.doAutofillForAccount).not.toHaveBeenCalled();
      expect(vaultPopupAutofillService.viewAccountCipher).not.toHaveBeenCalled();
    });

    it("records a launch for the active account", async () => {
      jest.spyOn(BrowserApi, "createNewTab").mockResolvedValue(undefined as any);
      jest.spyOn(BrowserPopupUtils, "inPopup").mockReturnValue(false);

      await component.launchCipher(mockCipher);

      expect(cipherService.updateLastLaunchedDate).toHaveBeenCalledWith("cipher-1", "UserId");
    });
  });

  describe("cipherItemTitleKey", () => {
    it("should return autofillTitle when canAutofill is true", () => {
      fixture.componentRef.setInput("isAutofillList", true);
      fixture.detectChanges();

      const titleKeyFn = component.cipherItemTitleKey();
      const result = titleKeyFn(mockCipher);

      expect(result).toBe("autofillTitleWithField");
    });

    it("should return viewItemTitle when canAutofill is false", () => {
      fixture.componentRef.setInput("isAutofillList", false);
      fixture.detectChanges();

      const titleKeyFn = component.cipherItemTitleKey();
      const result = titleKeyFn(mockCipher);

      expect(result).toBe("viewItemTitleWithField");
    });

    it("should return title without WithField when cipher has no username", () => {
      fixture.componentRef.setInput("isAutofillList", false);
      fixture.detectChanges();

      const cipherWithoutUsername = {
        ...mockCipher,
        login: { ...mockCipher.login, username: null },
      } as PopupCipherViewLike;

      const titleKeyFn = component.cipherItemTitleKey();
      const result = titleKeyFn(cipherWithoutUsername);

      expect(result).toBe("viewItemTitle");
    });
  });
});
