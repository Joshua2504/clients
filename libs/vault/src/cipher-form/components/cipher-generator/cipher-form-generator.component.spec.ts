import { Component, EventEmitter, Input, Output } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { BehaviorSubject } from "rxjs";

import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { UserId } from "@bitwarden/common/types/guid";
import { GeneratorModule } from "@bitwarden/generator-components";

import { CipherFormGeneratorComponent } from "../../..";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "tools-password-generator",
  template: `<ng-content></ng-content>`,
})
class MockPasswordGeneratorComponent {
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output() onGenerated = new EventEmitter();
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input() account: Account | null = null;
}

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "tools-username-generator",
  template: `<ng-content></ng-content>`,
})
class MockUsernameGeneratorComponent {
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output() onGenerated = new EventEmitter();
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input() account: Account | null = null;
}

describe("CipherFormGeneratorComponent", () => {
  let component: CipherFormGeneratorComponent;
  let fixture: ComponentFixture<CipherFormGeneratorComponent>;

  const otherUserId = "other-user" as UserId;
  const accounts$ = new BehaviorSubject<Record<string, { email: string }>>({});
  const accountService = {
    accounts$,
    get activeAccount$(): never {
      throw new Error("The form generator must not read the active account.");
    },
  };

  beforeEach(async () => {
    accounts$.next({ [otherUserId]: { email: "other@example.com" } });

    await TestBed.configureTestingModule({
      imports: [CipherFormGeneratorComponent],
      providers: [
        { provide: I18nService, useValue: { t: (key: string) => key } },
        { provide: AccountService, useValue: accountService },
      ],
      // FIXME(PM-18598): Replace unknownElements and unknownProperties with actual imports
      errorOnUnknownProperties: false,
    })
      .overrideComponent(CipherFormGeneratorComponent, {
        remove: { imports: [GeneratorModule] },
        add: { imports: [MockPasswordGeneratorComponent, MockUsernameGeneratorComponent] },
      })
      .compileComponents();

    fixture = TestBed.createComponent(CipherFormGeneratorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  describe("password generation", () => {
    let passwordGenerator: MockPasswordGeneratorComponent;

    beforeEach(() => {
      component.type = "password";
      fixture.detectChanges();

      passwordGenerator = fixture.debugElement.query(
        By.directive(MockPasswordGeneratorComponent),
      ).componentInstance;
    });

    it("only shows `PasswordGeneratorComponent`", () => {
      expect(passwordGenerator).toBeTruthy();
      expect(fixture.debugElement.query(By.directive(MockUsernameGeneratorComponent))).toBeNull();
    });

    it("invokes `valueGenerated` with the generated credential", () => {
      jest.spyOn(component.valueGenerated, "emit");

      passwordGenerator.onGenerated.emit({ credential: "new-cred-password!" });

      expect(component.valueGenerated.emit).toHaveBeenCalledTimes(1);
      expect(component.valueGenerated.emit).toHaveBeenCalledWith("new-cred-password!");
    });
  });

  describe("username generation", () => {
    let usernameGenerator: MockUsernameGeneratorComponent;

    beforeEach(() => {
      component.type = "username";
      fixture.detectChanges();

      usernameGenerator = fixture.debugElement.query(
        By.directive(MockUsernameGeneratorComponent),
      ).componentInstance;
    });

    it("only shows `UsernameGeneratorComponent`", () => {
      expect(usernameGenerator).toBeTruthy();
      expect(fixture.debugElement.query(By.directive(MockPasswordGeneratorComponent))).toBeNull();
    });

    it("invokes `valueGenerated` with the generated credential", () => {
      jest.spyOn(component.valueGenerated, "emit");

      usernameGenerator.onGenerated.emit({ credential: "new-cred-username!" });

      expect(component.valueGenerated.emit).toHaveBeenCalledTimes(1);
      expect(component.valueGenerated.emit).toHaveBeenCalledWith("new-cred-username!");
    });
  });

  describe("account", () => {
    const passwordGenerator = () =>
      fixture.debugElement.query(By.directive(MockPasswordGeneratorComponent));
    const usernameGenerator = () =>
      fixture.debugElement.query(By.directive(MockUsernameGeneratorComponent));

    it("leaves the generators on the active account when no account is named", () => {
      component.type = "password";
      fixture.detectChanges();

      expect(passwordGenerator().componentInstance.account).toBeNull();
    });

    it("binds the password generator to the named account", () => {
      component.type = "password";
      component.userId = otherUserId;
      fixture.detectChanges();

      expect(passwordGenerator().componentInstance.account).toEqual({
        id: otherUserId,
        email: "other@example.com",
      });
    });

    it("binds the username generator to the named account", () => {
      component.type = "username";
      component.userId = otherUserId;
      fixture.detectChanges();

      expect(usernameGenerator().componentInstance.account).toEqual({
        id: otherUserId,
        email: "other@example.com",
      });
    });

    it("renders no generator for a named account that is gone, instead of the active account's", () => {
      component.type = "password";
      component.userId = otherUserId;
      accounts$.next({});
      fixture.detectChanges();

      expect(passwordGenerator()).toBeNull();
      expect(usernameGenerator()).toBeNull();
    });
  });
});
