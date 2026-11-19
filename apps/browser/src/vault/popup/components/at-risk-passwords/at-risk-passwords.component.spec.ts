import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { ActivatedRoute, Params, Router } from "@angular/router";
import { mock } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom, of } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { IconComponent } from "@bitwarden/angular/vault/components/icon.component";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { Organization } from "@bitwarden/common/admin-console/models/domain/organization";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillOverlayVisibility } from "@bitwarden/common/autofill/constants";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { AutofillSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/autofill-settings.service";
import { InlineMenuVisibilitySetting } from "@bitwarden/common/autofill/types";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { StateProvider } from "@bitwarden/common/platform/state";
import { FakeAccountService, FakeStateProvider } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { ChangeLoginPasswordService } from "@bitwarden/common/vault/abstractions/change-login-password.service";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { EndUserNotificationService } from "@bitwarden/common/vault/notifications";
import { NotificationView } from "@bitwarden/common/vault/notifications/models";
import { SecurityTask, SecurityTaskType, TaskService } from "@bitwarden/common/vault/tasks";
import { DialogService, ToastService } from "@bitwarden/components";
import { PasswordRepromptService, AtRiskPasswordCalloutService } from "@bitwarden/vault";

import { PopupHeaderComponent } from "../../../../platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "../../../../platform/popup/layout/popup-page.component";
import { PopupRouterCacheService } from "../../../../platform/popup/view-cache/popup-router-cache.service";
import { PopupCloseWarningService } from "../../../../popup/services/popup-close-warning.service";
import { AtRiskCarouselDialogResult } from "../at-risk-carousel-dialog/at-risk-carousel-dialog.component";
import { ItemAccountHintComponent } from "../item-account-hint/item-account-hint.component";

import { AtRiskPasswordPageService } from "./at-risk-password-page.service";
import { AtRiskPasswordsComponent } from "./at-risk-passwords.component";

@Component({
  selector: "popup-header",
  template: `<ng-content></ng-content>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class MockPopupHeaderComponent {
  readonly pageTitle = input<string | undefined>(undefined);
  readonly backAction = input<(() => void) | undefined>(undefined);
}

@Component({
  selector: "popup-page",
  template: `<ng-content></ng-content>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class MockPopupPageComponent {
  readonly loading = input<boolean | undefined>(undefined);
}

@Component({
  selector: "app-vault-icon",
  template: `<ng-content></ng-content>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
// FIXME(https://bitwarden.atlassian.net/browse/PM-28231): Use Component suffix
// eslint-disable-next-line @angular-eslint/component-class-suffix
class MockAppIcon {
  readonly cipher = input<CipherView | undefined>(undefined);
  readonly userId = input<UserId | undefined>(undefined);
}

describe("AtRiskPasswordsComponent", () => {
  let component: AtRiskPasswordsComponent;
  let fixture: ComponentFixture<AtRiskPasswordsComponent>;

  let mockTasks$: BehaviorSubject<SecurityTask[]>;
  let mockCiphers$: BehaviorSubject<CipherView[]>;
  let mockOrgs$: BehaviorSubject<Organization[]>;
  let mockNotifications$: BehaviorSubject<NotificationView[]>;
  let mockInlineMenuVisibility$: BehaviorSubject<InlineMenuVisibilitySetting>;
  let calloutDismissed$: BehaviorSubject<boolean>;
  let mockAtRiskPasswordCalloutService: any;
  let stateProvider: FakeStateProvider;
  let mockAccountService: FakeAccountService;
  const setInlineMenuVisibility = jest.fn();
  const mockToastService = mock<ToastService>();
  const mockAtRiskPasswordPageService = mock<AtRiskPasswordPageService>();
  const mockChangeLoginPasswordService = mock<ChangeLoginPasswordService>();
  const mockDialogService = mock<DialogService>();
  const otherUserId = "other-user" as UserId;
  /** The route's query params. `userId` names the account whose at-risk passwords are shown. */
  let queryParams$: BehaviorSubject<Params>;
  /** Whether the other account serves autofill, which is what lets the page show it. */
  let otherAccountServes$: BehaviorSubject<boolean>;
  const pendingTasks$ = jest.fn();
  const cipherViews$ = jest.fn();
  const organizations$ = jest.fn();
  const unreadNotifications$ = jest.fn();
  const mockPasswordRepromptService = mock<PasswordRepromptService>();
  const navigate = jest.fn().mockResolvedValue(true);
  const setHistory = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    mockTasks$ = new BehaviorSubject<SecurityTask[]>([
      {
        id: "task",
        organizationId: "org",
        cipherId: "cipher",
        type: SecurityTaskType.UpdateAtRiskCredential,
      } as SecurityTask,
    ]);
    mockCiphers$ = new BehaviorSubject<CipherView[]>([
      {
        id: "cipher",
        organizationId: "org",
        name: "Item 1",
        edit: true,
        viewPassword: true,
      } as CipherView,
      {
        id: "cipher2",
        organizationId: "org",
        name: "Item 2",
        edit: true,
        viewPassword: true,
      } as CipherView,
    ]);
    mockOrgs$ = new BehaviorSubject<Organization[]>([
      {
        id: "org",
        name: "Org 1",
      } as Organization,
    ]);
    mockNotifications$ = new BehaviorSubject<NotificationView[]>([]);

    mockInlineMenuVisibility$ = new BehaviorSubject<InlineMenuVisibilitySetting>(
      AutofillOverlayVisibility.Off,
    );

    calloutDismissed$ = new BehaviorSubject<boolean>(false);
    setInlineMenuVisibility.mockClear();
    mockToastService.showToast.mockClear();
    mockDialogService.open.mockClear();
    mockAtRiskPasswordPageService.isCalloutDismissed.mockReturnValue(calloutDismissed$);
    mockAccountService = {
      activeAccount$: of({ id: "user" as UserId }),
      activeUserId: "user" as UserId,
      accounts$: of({
        user: { email: "user@example.com" },
        [otherUserId]: { email: "other@example.com" },
      }),
    } as unknown as FakeAccountService;
    queryParams$ = new BehaviorSubject<Params>({});
    otherAccountServes$ = new BehaviorSubject<boolean>(true);
    jest.clearAllMocks();
    mockAtRiskPasswordPageService.isCalloutDismissed.mockReturnValue(calloutDismissed$);
    mockAtRiskPasswordCalloutService = { updateAtRiskPasswordState: jest.fn() };
    mockAtRiskPasswordPageService.isGettingStartedDismissed.mockReturnValue(of(true));
    navigate.mockResolvedValue(true);
    setHistory.mockResolvedValue(undefined);
    stateProvider = new FakeStateProvider(mockAccountService);

    await TestBed.configureTestingModule({
      imports: [AtRiskPasswordsComponent],
      providers: [
        {
          provide: TaskService,
          useValue: {
            pendingTasks$: pendingTasks$.mockImplementation(() => mockTasks$),
          },
        },
        {
          provide: OrganizationService,
          useValue: {
            organizations$: organizations$.mockImplementation(() => mockOrgs$),
          },
        },
        {
          provide: CipherService,
          useValue: {
            cipherViews$: cipherViews$.mockImplementation(() => mockCiphers$),
          },
        },
        {
          provide: EndUserNotificationService,
          useValue: {
            unreadNotifications$: unreadNotifications$.mockImplementation(() => mockNotifications$),
          },
        },
        { provide: I18nService, useValue: { t: (key: string) => key } },
        { provide: AccountService, useValue: mockAccountService },
        { provide: PlatformUtilsService, useValue: mock<PlatformUtilsService>() },
        { provide: PasswordRepromptService, useValue: mockPasswordRepromptService },
        { provide: ActivatedRoute, useValue: { queryParams: queryParams$ } },
        { provide: Router, useValue: { navigate } },
        {
          provide: AutofillAccountsService,
          useValue: { isAutofillUser$: () => otherAccountServes$ },
        },
        { provide: PopupRouterCacheService, useValue: { setHistory } },
        { provide: PopupCloseWarningService, useValue: { disable: jest.fn() } },
        {
          provide: AutofillSettingsServiceAbstraction,
          useValue: {
            inlineMenuVisibility$: mockInlineMenuVisibility$,
            setInlineMenuVisibility: setInlineMenuVisibility,
          },
        },
        { provide: ToastService, useValue: mockToastService },
        { provide: StateProvider, useValue: stateProvider },
        { provide: AtRiskPasswordCalloutService, useValue: mockAtRiskPasswordCalloutService },
      ],
    })
      .overrideModule(JslibModule, {
        remove: {
          imports: [IconComponent],
          exports: [IconComponent],
        },
        add: {
          imports: [MockAppIcon],
          exports: [MockAppIcon],
        },
      })
      .overrideComponent(AtRiskPasswordsComponent, {
        remove: {
          imports: [PopupHeaderComponent, PopupPageComponent],
          providers: [AtRiskPasswordPageService, DialogService],
        },
        add: {
          imports: [MockPopupHeaderComponent, MockPopupPageComponent],
          providers: [
            { provide: AtRiskPasswordPageService, useValue: mockAtRiskPasswordPageService },
            { provide: ChangeLoginPasswordService, useValue: mockChangeLoginPasswordService },
            { provide: DialogService, useValue: mockDialogService },
          ],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(AtRiskPasswordsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  describe("pending atRiskItems$", () => {
    it("should list pending at risk item tasks", async () => {
      const items = await firstValueFrom(component["atRiskItems$"]);
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe("Item 1");
    });

    it("should not show tasks associated with deleted ciphers", async () => {
      mockCiphers$.next([
        {
          id: "cipher",
          organizationId: "org",
          name: "Item 1",
          isDeleted: true,
          edit: true,
          viewPassword: true,
        } as CipherView,
      ]);

      const items = await firstValueFrom(component["atRiskItems$"]);
      expect(items).toHaveLength(0);
    });

    it("should not show tasks when cipher does not have edit permission", async () => {
      mockCiphers$.next([
        {
          id: "cipher",
          organizationId: "org",
          name: "Item 1",
          edit: false,
          viewPassword: true,
        } as CipherView,
      ]);

      const items = await firstValueFrom(component["atRiskItems$"]);
      expect(items).toHaveLength(0);
    });

    it("should not show tasks when cipher does not have viewPassword permission", async () => {
      mockCiphers$.next([
        {
          id: "cipher",
          organizationId: "org",
          name: "Item 1",
          edit: true,
          viewPassword: false,
        } as CipherView,
      ]);

      const items = await firstValueFrom(component["atRiskItems$"]);
      expect(items).toHaveLength(0);
    });
  });

  describe("pageDescription$", () => {
    it("should use single org description when tasks belong to one org", async () => {
      // Single task
      let description = await firstValueFrom(component["pageDescription$"]);
      expect(description).toBe("atRiskPasswordDescSingleOrg");

      // Multiple tasks
      mockTasks$.next([
        {
          id: "task",
          organizationId: "org",
          cipherId: "cipher",
          type: SecurityTaskType.UpdateAtRiskCredential,
        } as SecurityTask,
        {
          id: "task2",
          organizationId: "org",
          cipherId: "cipher2",
          type: SecurityTaskType.UpdateAtRiskCredential,
        } as SecurityTask,
      ]);
      description = await firstValueFrom(component["pageDescription$"]);
      expect(description).toBe("atRiskPasswordsDescSingleOrgPlural");
    });

    it("should use multiple org description when tasks belong to multiple orgs", async () => {
      mockTasks$.next([
        {
          id: "task",
          organizationId: "org",
          cipherId: "cipher",
          type: SecurityTaskType.UpdateAtRiskCredential,
        } as SecurityTask,
        {
          id: "task2",
          organizationId: "org2",
          cipherId: "cipher2",
          type: SecurityTaskType.UpdateAtRiskCredential,
        } as SecurityTask,
      ]);
      mockCiphers$.next([
        {
          id: "cipher",
          organizationId: "org",
          name: "Item 1",
          edit: true,
          viewPassword: true,
        } as CipherView,
        {
          id: "cipher2",
          organizationId: "org2",
          name: "Item 2",
          edit: true,
          viewPassword: true,
        } as CipherView,
      ]);

      const description = await firstValueFrom(component["pageDescription$"]);
      expect(description).toBe("atRiskPasswordsDescMultiOrgPlural");
    });
  });

  describe("autofill callout", () => {
    it("should show the callout if inline autofill is disabled", async () => {
      mockInlineMenuVisibility$.next(AutofillOverlayVisibility.Off);
      calloutDismissed$.next(false);
      fixture.detectChanges();
      const callout = fixture.debugElement.query(By.css('[data-testid="autofill-callout"]'));

      expect(callout).toBeTruthy();
    });

    it("should hide the callout if inline autofill is enabled", async () => {
      mockInlineMenuVisibility$.next(AutofillOverlayVisibility.OnButtonClick);
      calloutDismissed$.next(false);
      fixture.detectChanges();
      const callout = fixture.debugElement.query(By.css('[data-testid="autofill-callout"]'));

      expect(callout).toBeFalsy();
    });

    it("should hide the callout if the user has previously dismissed it", async () => {
      mockInlineMenuVisibility$.next(AutofillOverlayVisibility.Off);
      calloutDismissed$.next(true);
      fixture.detectChanges();
      const callout = fixture.debugElement.query(By.css('[data-testid="autofill-callout"]'));

      expect(callout).toBeFalsy();
    });

    it("should call dismissCallout when the dismiss callout button is clicked", async () => {
      mockInlineMenuVisibility$.next(AutofillOverlayVisibility.Off);
      fixture.detectChanges();
      const dismissButton = fixture.debugElement.query(
        By.css('[data-testid="dismiss-callout-button"]'),
      );
      dismissButton.nativeElement.click();
      expect(mockAtRiskPasswordPageService.dismissCallout).toHaveBeenCalled();
    });

    describe("turn on autofill button", () => {
      it("should call the service to turn on inline autofill and show a toast", () => {
        const button = fixture.debugElement.query(
          By.css('[data-testid="turn-on-autofill-button"]'),
        );
        button.nativeElement.click();

        expect(setInlineMenuVisibility).toHaveBeenCalledWith(
          AutofillOverlayVisibility.OnButtonClick,
        );
        expect(mockToastService.showToast).toHaveBeenCalled();
      });
    });
  });

  describe("getting started carousel", () => {
    it("should open the carousel automatically if the user has not dismissed it", async () => {
      mockAtRiskPasswordPageService.isGettingStartedDismissed.mockReturnValue(of(false));
      mockDialogService.open.mockReturnValue({ closed: of(undefined) } as any);
      await component.ngOnInit();
      expect(mockDialogService.open).toHaveBeenCalled();
    });

    it("should not open the carousel automatically if the user has already dismissed it", async () => {
      mockDialogService.open.mockClear(); // Need to clear the mock since the component is already initialized once
      mockAtRiskPasswordPageService.isGettingStartedDismissed.mockReturnValue(of(true));
      mockDialogService.open.mockReturnValue({ closed: of(undefined) } as any);
      await component.ngOnInit();
      expect(mockDialogService.open).not.toHaveBeenCalled();
    });

    it("should mark the carousel as dismissed when the user dismisses it", async () => {
      mockAtRiskPasswordPageService.isGettingStartedDismissed.mockReturnValue(of(false));
      mockDialogService.open.mockReturnValue({
        closed: of(AtRiskCarouselDialogResult.Dismissed),
      } as any);
      await component.ngOnInit();
      expect(mockDialogService.open).toHaveBeenCalled();
      expect(mockAtRiskPasswordPageService.dismissGettingStarted).toHaveBeenCalled();
    });
  });

  describe("for the account named by `userId`", () => {
    const open = async () => {
      jest.clearAllMocks();
      queryParams$.next({ userId: otherUserId });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };

    it("reads the tasks, ciphers and organizations of that account alone", async () => {
      await open();

      const items = await firstValueFrom(component["atRiskItems$"]);
      await firstValueFrom(component["pageDescription$"]);

      expect(items.map((item) => item.name)).toEqual(["Item 1"]);
      expect(pendingTasks$).toHaveBeenCalledWith(otherUserId);
      expect(cipherViews$).toHaveBeenCalledWith(otherUserId);
      expect(organizations$).toHaveBeenCalledWith(otherUserId);
      for (const read of [pendingTasks$, cipherViews$, organizations$]) {
        expect(read).not.toHaveBeenCalledWith("user");
      }
    });

    it("says whose vault the passwords are in and fetches the icons from that account", async () => {
      await open();

      const hint = fixture.debugElement.query(By.directive(ItemAccountHintComponent));
      expect(hint.componentInstance.email()).toBe("other@example.com");
      const icon = fixture.debugElement.query(By.directive(MockAppIcon));
      expect(icon.componentInstance.userId()).toBe(otherUserId);
    });

    it("keeps the dismissed state and the task notifications of that account", async () => {
      mockAtRiskPasswordPageService.isGettingStartedDismissed.mockReturnValue(of(true));
      await open();
      const updateAtRiskPasswordState = jest
        .spyOn(component["atRiskPasswordCalloutService"], "updateAtRiskPasswordState")
        .mockImplementation(() => undefined);

      await component.ngOnInit();
      await component.dismissCallout();
      await firstValueFrom(component["showAutofillCallout$"]);

      expect(mockAtRiskPasswordPageService.isGettingStartedDismissed).toHaveBeenCalledWith(
        otherUserId,
      );
      expect(mockAtRiskPasswordPageService.isCalloutDismissed).toHaveBeenCalledWith(otherUserId);
      expect(mockAtRiskPasswordPageService.dismissCallout).toHaveBeenCalledWith(otherUserId);
      expect(unreadNotifications$).toHaveBeenCalledWith(otherUserId);
      expect(updateAtRiskPasswordState).toHaveBeenCalledWith(otherUserId, {
        hasInteractedWithTasks: true,
        tasksBannerDismissed: false,
      });
    });

    it("opens an item for that account after that account's re-prompt", async () => {
      mockPasswordRepromptService.passwordRepromptCheck.mockResolvedValue(true);
      await open();
      const cipher = { id: "cipher", type: 1 } as CipherView;

      await component.viewCipher(cipher);

      expect(mockPasswordRepromptService.passwordRepromptCheck).toHaveBeenCalledWith(
        cipher,
        otherUserId,
      );
      expect(navigate).toHaveBeenCalledWith(["/view-cipher"], {
        queryParams: { cipherId: "cipher", type: 1, userId: otherUserId },
      });
    });

    it("leaves when that account stops serving autofill and never shows the active account", async () => {
      await open();

      otherAccountServes$.next(false);
      await fixture.whenStable();

      expect(setHistory).toHaveBeenCalledWith([]);
      expect(navigate).toHaveBeenCalledWith(["/tabs/vault"]);
      expect(pendingTasks$).not.toHaveBeenCalledWith("user");
      expect(cipherViews$).not.toHaveBeenCalledWith("user");
    });

    it("names no account and shows no hint without `userId`", async () => {
      const cipher = { id: "cipher", type: 1 } as CipherView;
      mockPasswordRepromptService.passwordRepromptCheck.mockResolvedValue(true);

      await component.viewCipher(cipher);

      expect(fixture.debugElement.query(By.css('[data-testid="item-account-hint"]'))).toBeNull();
      expect(pendingTasks$).toHaveBeenCalledWith("user");
      expect(mockPasswordRepromptService.passwordRepromptCheck).toHaveBeenCalledWith(
        cipher,
        undefined,
      );
      expect(navigate).toHaveBeenCalledWith(["/view-cipher"], {
        queryParams: { cipherId: "cipher", type: 1 },
      });
    });
  });
});
