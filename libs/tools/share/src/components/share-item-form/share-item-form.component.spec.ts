import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ReactiveFormsModule } from "@angular/forms";
import { By } from "@angular/platform-browser";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, of } from "rxjs";

import { CollectionService } from "@bitwarden/admin-console/common";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { CollectionView } from "@bitwarden/common/admin-console/models/collections";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { mockAccountInfoWith } from "@bitwarden/common/spec";
import { SendDeletionDatePreset } from "@bitwarden/common/tools/models/send-deletion-date-preset";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { FolderService } from "@bitwarden/common/vault/abstractions/folder/folder.service.abstraction";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FolderView } from "@bitwarden/common/vault/models/view/folder.view";
import { ToastService } from "@bitwarden/components";
import { newGuid } from "@bitwarden/guid";
import { LogService } from "@bitwarden/logging";
import { OrganizationId } from "@bitwarden/sdk-internal";
import { SendPolicyService } from "@bitwarden/send-ui";

import { ShareLink, ShareLinkService } from "../../services/share-link.service";

import { ShareItemFormComponent } from "./share-item-form.component";

const mockUserId = "user-123" as UserId;

const mockCipher = Object.assign(new CipherView(), {
  id: "cipher-123",
  name: "Test Login",
  type: CipherType.Login,
  login: { username: "user@example.com", uris: [] },
});

describe("ShareItemFormComponent", () => {
  let hostFixture: ComponentFixture<ShareItemFormComponent>;
  let component: ShareItemFormComponent;
  let platformUtilsService: MockProxy<PlatformUtilsService>;
  let toastService: MockProxy<ToastService>;
  let shareLinkService: MockProxy<ShareLinkService>;
  let i18nService: MockProxy<I18nService>;
  let collections$: BehaviorSubject<CollectionView[]>;
  let folderViews$: BehaviorSubject<FolderView[]>;
  let collectionService: MockProxy<CollectionService>;
  let folderService: MockProxy<FolderService>;
  let organizationService: { organizations$: jest.Mock };
  let sendPolicyService: {
    deletionDatePolicyInfo$: BehaviorSubject<unknown>;
    allowedDomains$: BehaviorSubject<string[]>;
    deletionDatePolicyInfoFor$: jest.Mock;
    allowedDomainsFor$: jest.Mock;
  };
  // Mock SendPolicyService observables
  let deletionDatePolicyInfo$: BehaviorSubject<{
    deletionHours: SendDeletionDatePreset | null;
    orgId: OrganizationId | null;
  } | null>;
  let allowedDomains$: BehaviorSubject<string[]>;
  let organizations$: BehaviorSubject<
    {
      id: OrganizationId;
      name: string;
    }[]
  >;

  beforeEach(async () => {
    platformUtilsService = mock<PlatformUtilsService>();
    toastService = mock<ToastService>();
    i18nService = mock<I18nService>();
    shareLinkService = mock<ShareLinkService>();

    i18nService.t.mockImplementation((key: string) => key);
    shareLinkService["links$"] = new BehaviorSubject<ShareLink[]>([]);

    collections$ = new BehaviorSubject<CollectionView[]>([]);
    collectionService = mock<CollectionService>();
    collectionService.decryptedCollections$.mockReturnValue(collections$);

    folderViews$ = new BehaviorSubject<FolderView[]>([]);
    folderService = mock<FolderService>();
    folderService.folderViews$.mockReturnValue(folderViews$);

    deletionDatePolicyInfo$ = new BehaviorSubject<{
      deletionHours: SendDeletionDatePreset | null;
      orgId: OrganizationId | null;
    } | null>(null);
    allowedDomains$ = new BehaviorSubject<string[]>([]);
    organizations$ = new BehaviorSubject<
      {
        id: OrganizationId;
        name: string;
      }[]
    >([]);

    organizationService = { organizations$: jest.fn(() => organizations$) };
    sendPolicyService = {
      deletionDatePolicyInfo$,
      allowedDomains$,
      deletionDatePolicyInfoFor$: jest.fn(() => of({ deletionHours: null, orgId: null })),
      allowedDomainsFor$: jest.fn(() => of(null)),
    };

    await TestBed.configureTestingModule({
      imports: [ReactiveFormsModule, ShareItemFormComponent],
      providers: [
        {
          provide: AccountService,
          useValue: {
            activeAccount$: of({
              id: mockUserId,
              ...mockAccountInfoWith({
                email: "test@email.com",
                name: "Test User",
              }),
            }),
          },
        },
        { provide: PlatformUtilsService, useValue: platformUtilsService },
        { provide: ToastService, useValue: toastService },
        { provide: I18nService, useValue: i18nService },
        { provide: ShareLinkService, useValue: shareLinkService },
        { provide: CollectionService, useValue: collectionService },
        { provide: FolderService, useValue: folderService },
        { provide: SendPolicyService, useValue: sendPolicyService },
        { provide: LogService, useValue: mock<LogService>() },
        { provide: OrganizationService, useValue: organizationService },
      ],
    }).compileComponents();

    hostFixture = TestBed.createComponent(ShareItemFormComponent);
    component = hostFixture.componentInstance;
    hostFixture.componentRef.setInput("cipher", mockCipher);
    hostFixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  describe("item details", () => {
    const accordion = () => hostFixture.debugElement.query(By.css("bit-accordion"));
    const summary = () => hostFixture.debugElement.query(By.css("#share-item-form_item-summary"));

    it("shows the item without an accordion when it has no folder or collections", () => {
      expect(accordion()).toBeNull();
      expect(summary()).not.toBeNull();
      expect(summary().nativeElement.textContent).toContain("Test Login");
    });

    it("shows the accordion when the item is in a folder", () => {
      folderViews$.next([Object.assign(new FolderView(), { id: "folder-1", name: "Work" })]);
      hostFixture.componentRef.setInput(
        "cipher",
        Object.assign(new CipherView(), { ...mockCipher, folderId: "folder-1" }),
      );
      hostFixture.detectChanges();

      expect(summary()).toBeNull();
      expect(accordion()).not.toBeNull();
      expect(accordion().nativeElement.textContent).toContain("Work");
    });

    it("shows the accordion when the item is in a collection", () => {
      collections$.next([
        Object.assign(Object.create(CollectionView.prototype), { id: "col-1", name: "Team" }),
      ]);
      hostFixture.componentRef.setInput(
        "cipher",
        Object.assign(new CipherView(), { ...mockCipher, collectionIds: ["col-1"] }),
      );
      hostFixture.detectChanges();

      expect(summary()).toBeNull();
      expect(accordion()).not.toBeNull();
      expect(accordion().nativeElement.textContent).toContain("Team");
    });

    it("keeps the accordion hidden when the item's folder no longer exists", () => {
      hostFixture.componentRef.setInput(
        "cipher",
        Object.assign(new CipherView(), { ...mockCipher, folderId: "deleted-folder" }),
      );
      hostFixture.detectChanges();

      expect(accordion()).toBeNull();
      expect(summary()).not.toBeNull();
    });
  });

  it("reads the active account when no account is given", async () => {
    await hostFixture.whenStable();

    expect(collectionService.decryptedCollections$).toHaveBeenCalledWith(mockUserId);
    expect(folderService.folderViews$).toHaveBeenCalledWith(mockUserId);
    expect(organizationService.organizations$).toHaveBeenCalledWith(mockUserId);
    expect(shareLinkService.setCipher).toHaveBeenCalledWith("cipher-123");
    expect(sendPolicyService.deletionDatePolicyInfoFor$).not.toHaveBeenCalled();
    expect(sendPolicyService.allowedDomainsFor$).not.toHaveBeenCalled();
  });

  describe("for an item of an account other than the active one", () => {
    const otherUserId = "other-user" as UserId;

    beforeEach(async () => {
      // A fresh form, so nothing was read for the active account before the account was given.
      jest.clearAllMocks();
      hostFixture = TestBed.createComponent(ShareItemFormComponent);
      component = hostFixture.componentInstance;
      hostFixture.componentRef.setInput("cipher", mockCipher);
      hostFixture.componentRef.setInput("userId", otherUserId);
      hostFixture.detectChanges();
      await hostFixture.whenStable();
    });

    it("lists the folders, collections and organizations of that account only", () => {
      expect(collectionService.decryptedCollections$).toHaveBeenCalledWith(otherUserId);
      expect(folderService.folderViews$).toHaveBeenCalledWith(otherUserId);
      expect(organizationService.organizations$).toHaveBeenCalledWith(otherUserId);

      expect(collectionService.decryptedCollections$).not.toHaveBeenCalledWith(mockUserId);
      expect(folderService.folderViews$).not.toHaveBeenCalledWith(mockUserId);
      expect(organizationService.organizations$).not.toHaveBeenCalledWith(mockUserId);
    });

    it("applies the Send policies of that account", () => {
      expect(sendPolicyService.deletionDatePolicyInfoFor$).toHaveBeenCalledWith(otherUserId);
      expect(sendPolicyService.allowedDomainsFor$).toHaveBeenCalledWith(otherUserId);
    });

    it("enforces the deletion date that account's policy mandates, not the active account's", () => {
      // The active account's policy mandates 72 hours; the item's account has none.
      deletionDatePolicyInfo$.next({ deletionHours: 72, orgId: null });
      hostFixture.detectChanges();

      expect(component.form.controls.expiryHours.value).toEqual(168);
      expect(component.form.controls.expiryHours.disabled).toEqual(false);
      deletionDatePolicyInfo$.next(null);
    });

    it("lists the links of that account", () => {
      expect(shareLinkService.setCipher).toHaveBeenCalledWith("cipher-123", otherUserId);
      expect(shareLinkService.setCipher).not.toHaveBeenCalledWith("cipher-123");
    });

    it("creates the link in that account", async () => {
      component.form.controls.emails.setValue("a@test.com");
      shareLinkService.createShareLink.mockResolvedValue("https://send.example/access-id/key");

      await component.createAndCopyLink();

      expect(shareLinkService.createShareLink).toHaveBeenCalledWith(
        mockCipher,
        ["a@test.com"],
        168,
        false,
        otherUserId,
      );
    });
  });

  it("should not create link when form is invalid", async () => {
    component.form.controls.emails.setValue("");
    await component.createAndCopyLink();
    expect(platformUtilsService.copyToClipboard).not.toHaveBeenCalled();
  });

  it("should create and copy link when form is valid", async () => {
    component.form.controls.emails.setValue("recipient@example.com");
    shareLinkService.createShareLink.mockResolvedValue("https://send.bitwarden.com/access-id/key");

    await component.createAndCopyLink();

    expect(platformUtilsService.copyToClipboard).toHaveBeenCalled();
    expect(toastService.showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "success",
        message: "linkSavedAndCopied",
      }),
    );
  });

  it("should parse comma-delimited emails correctly", async () => {
    component.form.controls.emails.setValue("a@test.com, b@test.com, c@test.com");
    shareLinkService.createShareLink.mockResolvedValue("https://send.bitwarden.com/access-id/key");

    await component.createAndCopyLink();

    expect(shareLinkService.createShareLink).toHaveBeenCalledWith(
      mockCipher,
      ["a@test.com", "b@test.com", "c@test.com"],
      168,
      false,
    );
  });

  it("should copy link to clipboard", async () => {
    const mockLink = {
      cipherId: "cipher-123" as CipherId,
      sendId: "send-1",
      emails: ["test@test.com"],
      expiresAt: new Date(),
      oneTimeShare: false,
      url: "https://vault.bitwarden.com/share/abc",
    };

    await component["copyLink"](mockLink);

    expect(platformUtilsService.copyToClipboard).toHaveBeenCalledWith(
      "https://vault.bitwarden.com/share/abc",
    );
    expect(toastService.showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "success",
        message: "linkCopiedToClipboard",
      }),
    );
  });

  it("should delete a link and show toast", async () => {
    const mockLink = {
      cipherId: "cipher-123" as CipherId,
      sendId: "send-1",
      emails: ["test@test.com"],
      expiresAt: new Date(),
      oneTimeShare: false,
      url: "https://vault.bitwarden.com/share/abc",
    };

    await component["deleteLink"](mockLink);

    expect(shareLinkService.deleteLink).toHaveBeenCalledWith("send-1");
    expect(toastService.showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "success",
        message: "shareLinkDeleted",
      }),
    );
  });

  it("should set the deletion date field to comply with any Send Controls policies", async () => {
    const orgId = newGuid() as unknown as OrganizationId;
    organizations$.next([{ name: "Test Org", id: orgId }]);
    deletionDatePolicyInfo$.next({ deletionHours: 72, orgId });
    hostFixture.detectChanges();
    const expiryHoursFormControl = component.form.get("expiryHours");
    expect(expiryHoursFormControl?.value).toEqual(72);
    expect(expiryHoursFormControl?.disabled).toEqual(true);
    deletionDatePolicyInfo$.next(null);
  });
});
