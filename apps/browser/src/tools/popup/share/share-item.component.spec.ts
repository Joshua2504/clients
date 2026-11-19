import { ComponentFixture, TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { ActivatedRoute } from "@angular/router";
import { RouterTestingModule } from "@angular/router/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, of } from "rxjs";

import { CollectionService } from "@bitwarden/admin-console/common";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { mockAccountInfoWith } from "@bitwarden/common/spec";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { FolderService } from "@bitwarden/common/vault/abstractions/folder/folder.service.abstraction";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { ToastService } from "@bitwarden/components";
import { LogService } from "@bitwarden/logging";
import { SendPolicyService } from "@bitwarden/send-ui";
import { ShareItemFormComponent, ShareLinkService } from "@bitwarden/tools-share";

import { PopupRouterCacheService } from "../../../platform/popup/view-cache/popup-router-cache.service";
import { PopupCloseWarningService } from "../../../popup/services/popup-close-warning.service";
import { ItemAccountHintComponent } from "../../../vault/popup/components/item-account-hint/item-account-hint.component";

import { ShareItemComponent } from "./share-item.component";

describe("ShareItemComponent", () => {
  let component: ShareItemComponent;
  let fixture: ComponentFixture<ShareItemComponent>;
  let cipherService: MockProxy<CipherService>;

  let collectionService: MockProxy<CollectionService>;
  let autofillAccountsService: MockProxy<AutofillAccountsService>;
  let shareLinkService: { links$: unknown; setCipher: jest.Mock };
  let otherAccountServes: BehaviorSubject<boolean>;

  const queryParams$ = new BehaviorSubject<Record<string, string>>({
    cipherId: "cipher-123" as CipherId,
  });

  const mockCipher = Object.assign(new CipherView(), {
    id: "cipher-123",
    name: "Test Login",
    type: CipherType.Login,
    login: { username: "user@example.com", uris: [] },
  });

  const mockUserId = "user-123" as UserId;
  const otherUserId = "user-456" as UserId;

  const activeAccount = {
    id: mockUserId,
    ...mockAccountInfoWith({ email: "test@email.com", name: "Test User" }),
  };
  const accounts = {
    [mockUserId]: mockAccountInfoWith({ email: "test@email.com", name: "Test User" }),
    [otherUserId]: mockAccountInfoWith({ email: "other@email.com", name: "Other User" }),
  };

  function create() {
    fixture = TestBed.createComponent(ShareItemComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  const hint = () => fixture.debugElement.query(By.directive(ItemAccountHintComponent));
  const form = () => fixture.debugElement.query(By.directive(ShareItemFormComponent));

  beforeEach(async () => {
    queryParams$.next({ cipherId: "cipher-123" as CipherId });
    otherAccountServes = new BehaviorSubject(true);
    autofillAccountsService = mock<AutofillAccountsService>();
    autofillAccountsService.isAutofillUser$.mockImplementation((userId) =>
      userId === otherUserId ? otherAccountServes : of(false),
    );
    shareLinkService = { links$: of([]), setCipher: jest.fn() };

    cipherService = mock<CipherService>();
    const i18nService = mock<I18nService>();
    i18nService.t.mockImplementation((key: string) => key);

    cipherService.cipherView$.mockReturnValue(of(mockCipher));

    collectionService = mock<CollectionService>();
    collectionService.decryptedCollections$.mockReturnValue(of([]));

    const folderService = mock<FolderService>();
    folderService.folderViews$.mockReturnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [RouterTestingModule, ShareItemComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParams: queryParams$ },
        },
        {
          provide: AccountService,
          useValue: { activeAccount$: of(activeAccount), accounts$: of(accounts) },
        },
        { provide: AutofillAccountsService, useValue: autofillAccountsService },
        { provide: PopupCloseWarningService, useValue: mock<PopupCloseWarningService>() },
        { provide: CipherService, useValue: cipherService },
        { provide: PlatformUtilsService, useValue: mock<PlatformUtilsService>() },
        { provide: ToastService, useValue: mock<ToastService>() },
        { provide: I18nService, useValue: i18nService },
        { provide: ShareLinkService, useValue: shareLinkService },
        {
          provide: SendPolicyService,
          useValue: {
            deletionDatePolicyInfo$: of([]),
            allowedDomains$: of([]),
            deletionDatePolicyInfoFor$: () => of(null),
            allowedDomainsFor$: () => of(null),
          },
        },
        { provide: LogService, useValue: mock<LogService>() },
        { provide: CollectionService, useValue: collectionService },
        { provide: FolderService, useValue: folderService },
        {
          provide: PopupRouterCacheService,
          useValue: mock<PopupRouterCacheService>(),
        },
        {
          provide: OrganizationService,
          useValue: { organizations$: () => of([]) },
        },
      ],
    }).compileComponents();

    create();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("should load cipher from route query params", () => {
    expect(cipherService.cipherView$).toHaveBeenCalledWith(mockUserId, "cipher-123");
  });

  it("should set cipher signal after loading from route", () => {
    expect(component["cipher"]()).toEqual(mockCipher);
  });

  it("shares from the active account and shows no account hint without a `userId`", async () => {
    await fixture.whenStable();
    fixture.detectChanges();

    expect(hint()).toBeNull();
    expect(form().componentInstance.userId()).toBeUndefined();
    expect(autofillAccountsService.isAutofillUser$).not.toHaveBeenCalled();
  });

  describe("for an item of an account other than the active one", () => {
    beforeEach(() => {
      cipherService.cipherView$.mockClear();
      collectionService.decryptedCollections$.mockClear();
      shareLinkService.setCipher.mockClear();
      queryParams$.next({ cipherId: "cipher-123" as CipherId, userId: otherUserId });
    });

    it("loads the item from that account's vault, not the active account's", async () => {
      create();
      await fixture.whenStable();

      expect(cipherService.cipherView$).toHaveBeenCalledWith(otherUserId, "cipher-123");
      expect(cipherService.cipherView$).not.toHaveBeenCalledWith(mockUserId, "cipher-123");
    });

    it("hands the account to the form and says whose vault it is", async () => {
      create();
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(form().componentInstance.userId()).toBe(otherUserId);
      expect(hint().componentInstance.email()).toBe("other@email.com");
      expect(collectionService.decryptedCollections$).toHaveBeenCalledWith(otherUserId);
      expect(collectionService.decryptedCollections$).not.toHaveBeenCalledWith(mockUserId);
      expect(shareLinkService.setCipher).toHaveBeenCalledWith("cipher-123", otherUserId);
    });

    it("loads nothing when that account does not serve autofill", async () => {
      otherAccountServes.next(false);
      cipherService.cipherView$.mockClear();

      create();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(cipherService.cipherView$).not.toHaveBeenCalled();
      expect(form()).toBeNull();
    });
  });
});
