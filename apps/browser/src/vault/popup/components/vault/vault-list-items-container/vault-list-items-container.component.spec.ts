import { CdkVirtualScrollViewport } from "@angular/cdk/scrolling";
import {
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  input,
} from "@angular/core";
import { ComponentFixture, fakeAsync, TestBed, tick } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { Router } from "@angular/router";
import { mock } from "jest-mock-extended";
import { BehaviorSubject, of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { DomainSettingsService } from "@bitwarden/common/autofill/services/domain-settings.service";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import { EnvironmentService } from "@bitwarden/common/platform/abstractions/environment.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherRepromptType, CipherType } from "@bitwarden/common/vault/enums";
import { CompactModeService, DialogService, ScrollLayoutService } from "@bitwarden/components";
import { PasswordRepromptService } from "@bitwarden/vault";

import { BrowserApi } from "../../../../../platform/browser/browser-api";
import BrowserPopupUtils from "../../../../../platform/browser/browser-popup-utils";
import { VaultPopupAutofillService } from "../../../services/vault-popup-autofill.service";
import { VaultPopupSectionService } from "../../../services/vault-popup-section.service";
import { PopupCipherViewLike } from "../../../views/popup-cipher.view";
import { ItemCopyActionsComponent } from "../item-copy-action/item-copy-actions.component";
import { ItemMoreOptionsComponent } from "../item-more-options/item-more-options.component";

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

    it("re-prompts for the cipher's account and opens the view page of that account", fakeAsync(() => {
      passwordRepromptService.passwordRepromptCheck.mockResolvedValue(true);

      void component.onViewCipher(mockCipher);
      tick(200);

      expect(passwordRepromptService.passwordRepromptCheck).toHaveBeenCalledWith(
        mockCipher,
        otherUserId,
      );
      expect(router.navigate).toHaveBeenCalledWith(["/view-cipher"], {
        queryParams: { cipherId: "cipher-1", type: CipherType.Login, userId: otherUserId },
      });
    }));

    it("does not open the view page when that account's reprompt is declined", fakeAsync(() => {
      passwordRepromptService.passwordRepromptCheck.mockResolvedValue(false);

      void component.onViewCipher(mockCipher);
      tick(200);

      expect(router.navigate).not.toHaveBeenCalled();
    }));

    it("fills an item that requires a master password reprompt, for its account", async () => {
      await component.onCipherSelect(repromptCipher);

      // The service asks for the master password of the cipher's account before it fills.
      expect(vaultPopupAutofillService.doAutofillForAccount).toHaveBeenCalledWith({
        userId: otherUserId,
        cipher: repromptCipher,
      });
      expect(vaultPopupAutofillService.doAutofill).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();
      expect(component.cipherItemTitleKey()(repromptCipher)).toBe("autofillTitleWithField");
    });

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
    });

    it("views a cipher in the active account without naming an account", fakeAsync(() => {
      passwordRepromptService.passwordRepromptCheck.mockResolvedValue(true);

      void component.onViewCipher(mockCipher);
      tick(200);

      expect(passwordRepromptService.passwordRepromptCheck).toHaveBeenCalledWith(mockCipher);
      expect(router.navigate).toHaveBeenCalledWith(["/view-cipher"], {
        queryParams: { cipherId: "cipher-1", type: CipherType.Login },
      });
    }));

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

/** Stands in for the copy actions of a row and records what the row gives it. */
@Component({
  selector: "app-item-copy-actions",
  template: "",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class ItemCopyActionsStubComponent {
  readonly cipher = input<unknown>();
  readonly userId = input<UserId | undefined>(undefined);
}

/** Stands in for the more-options menu of a row and records what the row gives it. */
@Component({
  selector: "app-item-more-options",
  template: "",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class ItemMoreOptionsStubComponent {
  readonly cipher = input<unknown>();
  readonly userId = input<UserId | undefined>(undefined);
  readonly showAutofill = input<boolean>();
  readonly showViewOption = input<boolean>();
}

describe("VaultListItemsContainerComponent rows", () => {
  const otherUserId = "OtherUserId" as UserId;
  const cipher = {
    id: "cipher-1",
    name: "Test Login",
    type: CipherType.Login,
    login: { username: "user@example.com", uris: [] },
    reprompt: 0,
    collectionIds: [],
  } as any;

  const getEnvironment$ = jest.fn();

  beforeEach(() => getEnvironment$.mockClear());

  async function render(accountUserId: UserId | undefined) {
    await TestBed.configureTestingModule({
      imports: [VaultListItemsContainerComponent, NoopAnimationsModule],
      providers: [
        {
          provide: VaultPopupAutofillService,
          useValue: { currentTabIsOnBlocklist$: of(false) },
        },
        { provide: CompactModeService, useValue: { enabled$: of(false) } },
        {
          provide: VaultPopupSectionService,
          useValue: { getOpenDisplayStateForSection: () => () => true },
        },
        { provide: I18nService, useValue: { t: (k: string) => k } },
        { provide: AccountService, useValue: { activeAccount$: of({ id: "UserId" }) } },
        { provide: CipherService, useValue: mock<CipherService>() },
        { provide: Router, useValue: { navigate: jest.fn() } },
        { provide: PasswordRepromptService, useValue: mock<PasswordRepromptService>() },
        // The row's icon is fetched from the icons server of the account that owns the cipher.
        {
          provide: EnvironmentService,
          useValue: {
            environment$: of({ getIconsUrl: () => "https://icons.active.example" }),
            getEnvironment$: getEnvironment$.mockReturnValue(
              of({ getIconsUrl: () => "https://icons.other.example" }),
            ),
          },
        },
        { provide: DomainSettingsService, useValue: { showFavicons$: of(true) } },
        { provide: ConfigService, useValue: { getFeatureFlag$: () => of(false) } },
        { provide: LogService, useValue: mock<LogService>() },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    })
      .overrideComponent(VaultListItemsContainerComponent, {
        remove: { imports: [ItemCopyActionsComponent, ItemMoreOptionsComponent] },
        add: { imports: [ItemCopyActionsStubComponent, ItemMoreOptionsStubComponent] },
      })
      .overrideProvider(DialogService, { useValue: mock<DialogService>() })
      .compileComponents();

    // The page that hosts the list is what scrolls it.
    TestBed.inject(ScrollLayoutService).scrollableRef.set(new ElementRef(document.body));
    const fixture = TestBed.createComponent(VaultListItemsContainerComponent);
    fixture.componentRef.setInput("ciphers", [cipher]);
    fixture.componentRef.setInput("isAutofillList", true);
    fixture.componentRef.setInput("accountUserId", accountUserId);
    // The rows are virtualized into a viewport, which needs a height to draw any.
    const viewportSize = jest
      .spyOn(CdkVirtualScrollViewport.prototype, "getViewportSize")
      .mockReturnValue(600);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.viewPort.checkViewportSize();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    viewportSize.mockRestore();
    return fixture;
  }

  const copyActions = (fixture: ComponentFixture<VaultListItemsContainerComponent>) =>
    fixture.debugElement
      .queryAll(By.directive(ItemCopyActionsStubComponent))
      .map((el) => el.componentInstance as ItemCopyActionsStubComponent);
  const menus = (fixture: ComponentFixture<VaultListItemsContainerComponent>) =>
    fixture.debugElement
      .queryAll(By.directive(ItemMoreOptionsStubComponent))
      .map((el) => el.componentInstance as ItemMoreOptionsStubComponent);

  it("offers the copy actions and the full menu on a row of another account, for that account", async () => {
    const fixture = await render(otherUserId);

    expect(copyActions(fixture).map((copy) => [copy.cipher(), copy.userId()])).toEqual([
      [cipher, otherUserId],
    ]);
    expect(menus(fixture).map((menu) => [menu.cipher(), menu.userId()])).toEqual([
      [cipher, otherUserId],
    ]);
    // Selecting the row fills, so the menu offers View.
    expect(menus(fixture)[0].showViewOption()).toBe(true);
    expect(fixture.nativeElement.textContent).not.toContain("switchAccountAndViewItem");
    expect(getEnvironment$).toHaveBeenCalledWith(otherUserId);
  });

  it("names no account on a row of the active account", async () => {
    const fixture = await render(undefined);

    expect(copyActions(fixture).map((copy) => copy.userId())).toEqual([undefined]);
    expect(menus(fixture).map((menu) => menu.userId())).toEqual([undefined]);
    expect(getEnvironment$).not.toHaveBeenCalled();
  });
});
