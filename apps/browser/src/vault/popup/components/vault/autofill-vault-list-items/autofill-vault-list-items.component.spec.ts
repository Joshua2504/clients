import { NO_ERRORS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { mock } from "jest-mock-extended";
import { BehaviorSubject, of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { GlobalStateProvider } from "@bitwarden/common/platform/state";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CompactModeService, DialogService, ToastService } from "@bitwarden/components";
import { StateProvider } from "@bitwarden/state";
import { PasswordRepromptService } from "@bitwarden/vault";

import BrowserPopupUtils from "../../../../../platform/browser/browser-popup-utils";
import { VaultPopupAutofillService } from "../../../services/vault-popup-autofill.service";
import {
  AccountAutofillCiphers,
  VaultPopupItemsService,
} from "../../../services/vault-popup-items.service";
import { PopupCipherViewLike } from "../../../views/popup-cipher.view";
import { SimplifiedAutofillInfoComponent } from "../simplified-autofill-info/simplified-autofill-info.component";
import { VaultListItemsContainerComponent } from "../vault-list-items-container/vault-list-items-container.component";

import { AutofillVaultListItemsComponent } from "./autofill-vault-list-items.component";

describe("AutofillVaultListItemsComponent", () => {
  let fixture: ComponentFixture<AutofillVaultListItemsComponent>;

  const autoFillCiphers$ = new BehaviorSubject<PopupCipherViewLike[]>([]);
  const otherAccountAutoFillCiphers$ = new BehaviorSubject<AccountAutofillCiphers[]>([]);
  const hasFilterApplied$ = new BehaviorSubject<boolean>(false);
  const autofillAllowed$ = new BehaviorSubject<boolean>(true);
  const currentTabIsOnBlocklist$ = new BehaviorSubject<boolean>(false);

  beforeEach(async () => {
    // Mock getAnimations for all span elements before any components are created
    if (!HTMLSpanElement.prototype.getAnimations) {
      HTMLSpanElement.prototype.getAnimations = jest.fn().mockReturnValue([]);
    }

    autoFillCiphers$.next([]);
    otherAccountAutoFillCiphers$.next([]);
    currentTabIsOnBlocklist$.next(false);

    jest.spyOn(BrowserPopupUtils, "inSidebar").mockReturnValue(false);
    jest.spyOn(BrowserPopupUtils, "inPopup").mockReturnValue(false);

    await TestBed.configureTestingModule({
      imports: [AutofillVaultListItemsComponent],
      providers: [
        { provide: PasswordRepromptService, useValue: mock<PasswordRepromptService>() },
        { provide: CipherService, useValue: mock<CipherService>() },
        { provide: GlobalStateProvider, useValue: mock<GlobalStateProvider>() },
        {
          provide: AccountService,
          useValue: { activeAccount$: new BehaviorSubject({ id: "acct-id" }) },
        },
        { provide: PlatformUtilsService, useValue: mock<PlatformUtilsService>() },
        { provide: ToastService, useValue: mock<ToastService>() },
        { provide: DialogService, useValue: mock<DialogService>() },
        {
          provide: I18nService,
          useValue: {
            // The pipe passes its unused parameters as undefined.
            t: (key: string, ...args: (string | undefined)[]) =>
              [key, ...args.filter((arg) => arg != null)].join("|"),
          },
        },
        { provide: CompactModeService, useValue: { enabled$: new BehaviorSubject(false) } },
        {
          provide: StateProvider,
          useValue: {
            getUserState$: jest.fn().mockReturnValue(of(null)),
            getUser: jest.fn().mockReturnValue({ update: jest.fn().mockResolvedValue(undefined) }),
            getGlobal: jest.fn().mockReturnValue({
              update: jest.fn().mockResolvedValue(undefined),
              state$: new BehaviorSubject(undefined),
            }),
          },
        },
        {
          provide: VaultPopupItemsService,
          useValue: { autoFillCiphers$, hasFilterApplied$, otherAccountAutoFillCiphers$ },
        },
        {
          provide: VaultPopupAutofillService,
          useValue: {
            autofillAllowed$,
            currentTabIsOnBlocklist$,
            refreshCurrentTab: jest.fn(),
            currentAutofillTab$: of(null),
          },
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(AutofillVaultListItemsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  describe("app-simplified-autofill-info visibility", () => {
    it("is not rendered when the ciphers list is empty", async () => {
      autoFillCiphers$.next([]);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(fixture.debugElement.query(By.directive(SimplifiedAutofillInfoComponent))).toBeNull();
    });

    it("is rendered when ciphers are present", async () => {
      autoFillCiphers$.next([{ type: CipherType.Login } as PopupCipherViewLike]);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(
        fixture.debugElement.query(By.directive(SimplifiedAutofillInfoComponent)),
      ).not.toBeNull();
    });
  });

  describe("further autofill accounts", () => {
    const login = { id: "login", type: CipherType.Login, name: "Login" } as PopupCipherViewLike;
    const shared = { id: "shared", type: CipherType.Login, name: "Shared" } as PopupCipherViewLike;
    const otherAccount: AccountAutofillCiphers = {
      userId: "OtherUserId" as UserId,
      email: "other@example.com",
      ciphers: [shared],
    };

    const sections = () =>
      fixture.debugElement
        .queryAll(By.directive(VaultListItemsContainerComponent))
        .map((section) => section.componentInstance as VaultListItemsContainerComponent);

    const render = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };

    it("renders the active account's section alone while no account has opted in", async () => {
      autoFillCiphers$.next([login]);
      await render();

      expect(sections()).toHaveLength(1);
      expect(sections()[0].title()).toBe("autofillSuggestions");
      expect(sections()[0].accountUserId()).toBeUndefined();
    });

    it("renders a section for an account with a match, below the active account's", async () => {
      autoFillCiphers$.next([login]);
      otherAccountAutoFillCiphers$.next([otherAccount]);
      await render();

      const [active, other] = sections();
      expect(sections()).toHaveLength(2);
      expect(active.title()).toBe("autofillSuggestions");
      expect(active.ciphers()).toEqual([login]);
      expect(active.accountUserId()).toBeUndefined();
      expect(other.title()).toBe("suggestionsForAccount|autofillSuggestions|other@example.com");
      expect(other.ciphers()).toEqual([shared]);
      expect(other.accountUserId()).toBe("OtherUserId");
      expect(other.isAutofillList()).toBe(true);
    });

    it("shows a shared item in the section of each account that holds it", async () => {
      autoFillCiphers$.next([shared]);
      otherAccountAutoFillCiphers$.next([otherAccount]);
      await render();

      const [active, other] = sections();
      expect(active.ciphers()).toEqual([shared]);
      expect(active.accountUserId()).toBeUndefined();
      expect(other.ciphers()).toEqual([shared]);
      expect(other.accountUserId()).toBe("OtherUserId");
    });

    it("removes the section when the account locks", async () => {
      autoFillCiphers$.next([login]);
      otherAccountAutoFillCiphers$.next([otherAccount]);
      await render();
      expect(sections()).toHaveLength(2);

      otherAccountAutoFillCiphers$.next([]);
      await render();

      expect(sections()).toHaveLength(1);
      expect(sections()[0].accountUserId()).toBeUndefined();
    });

    it("names the suggested items of the account when the current tab is blocked", async () => {
      currentTabIsOnBlocklist$.next(true);
      otherAccountAutoFillCiphers$.next([otherAccount]);
      await render();

      expect(sections()[1].title()).toBe("suggestionsForAccount|itemSuggestions|other@example.com");
    });

    it("renders the other accounts' sections alone for a page without the active account's list", async () => {
      autoFillCiphers$.next([login]);
      otherAccountAutoFillCiphers$.next([otherAccount]);
      fixture.componentRef.setInput("otherAccountsOnly", true);
      await render();

      expect(sections()).toHaveLength(1);
      expect(sections()[0].accountUserId()).toBe("OtherUserId");
      expect(sections()[0].ciphers()).toEqual([shared]);
    });

    describe("empty autofill tip", () => {
      it("shows when no autofill account has a matching login", async () => {
        await render();

        expect(sections()[0].description()).toBe("autofillSuggestionsTip");
      });

      it("does not show when only another account has a matching login", async () => {
        otherAccountAutoFillCiphers$.next([otherAccount]);
        await render();

        expect(sections()[0].description()).toBeUndefined();
        expect(sections()[1].ciphers()).toEqual([shared]);
      });
    });
  });
});
