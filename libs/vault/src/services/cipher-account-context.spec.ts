import { Component, inject, input, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { FakeAccountService, mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";

import { CipherAccountContext } from "./cipher-account-context";

describe("CipherAccountContext", () => {
  const activeUserId = "active-user-id" as UserId;
  const otherUserId = "other-user-id" as UserId;

  let accountService: FakeAccountService;

  // eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
  @Component({ selector: "test-child", template: "" })
  class ChildComponent {
    readonly context = inject(CipherAccountContext);
  }

  // eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
  @Component({
    selector: "test-host",
    template: "<test-child />",
    imports: [ChildComponent],
    providers: [CipherAccountContext],
  })
  class HostComponent {
    readonly userId = input<UserId | undefined>(undefined);
    readonly context = inject(CipherAccountContext, { self: true }).bind(this.userId);
  }

  beforeEach(() => {
    accountService = mockAccountServiceWith(activeUserId);
    TestBed.configureTestingModule({
      providers: [{ provide: AccountService, useValue: accountService }],
    });
  });

  describe("unbound, as the root instance is", () => {
    it("names no account", () => {
      expect(TestBed.inject(CipherAccountContext).explicitUserId()).toBeUndefined();
    });

    it("resolves to the active account", async () => {
      const context = TestBed.inject(CipherAccountContext);

      await expect(firstValueFrom(context.userId$)).resolves.toBe(activeUserId);
      await expect(context.userId()).resolves.toBe(activeUserId);
    });

    it("resolves to null without an active account", async () => {
      accountService.activeAccountSubject.next(null);

      await expect(TestBed.inject(CipherAccountContext).userId()).resolves.toBeNull();
    });
  });

  describe("bound to the account of a host", () => {
    const createHost = (userId?: UserId) => {
      const fixture = TestBed.createComponent(HostComponent);
      fixture.componentRef.setInput("userId", userId);
      fixture.detectChanges();
      const child: ChildComponent = fixture.debugElement.children[0].componentInstance;
      return { fixture, child };
    };

    it("gives the host's account to what the host renders", async () => {
      const { child } = createHost(otherUserId);

      expect(child.context.explicitUserId()).toBe(otherUserId);
      await expect(child.context.userId()).resolves.toBe(otherUserId);
      await expect(firstValueFrom(child.context.userId$)).resolves.toBe(otherUserId);
    });

    it("does not change the root instance", () => {
      createHost(otherUserId);

      expect(TestBed.inject(CipherAccountContext).explicitUserId()).toBeUndefined();
    });

    it("resolves to the active account while the host names none", async () => {
      const { child } = createHost(undefined);

      expect(child.context.explicitUserId()).toBeUndefined();
      await expect(child.context.userId()).resolves.toBe(activeUserId);
    });

    it("follows the host's account", async () => {
      const { fixture, child } = createHost(undefined);
      const seen: (UserId | null)[] = [];
      const subscription = child.context.userId$.subscribe((userId) => seen.push(userId));

      fixture.componentRef.setInput("userId", otherUserId);
      fixture.detectChanges();
      await fixture.whenStable();
      subscription.unsubscribe();

      expect(seen).toEqual([activeUserId, otherUserId]);
    });

    it("does not follow the active account while the host names an account", async () => {
      const { fixture, child } = createHost(otherUserId);
      const seen: (UserId | null)[] = [];
      const subscription = child.context.userId$.subscribe((userId) => seen.push(userId));
      fixture.detectChanges();

      await accountService.switchAccount("third-user-id" as UserId);
      fixture.detectChanges();
      await fixture.whenStable();
      subscription.unsubscribe();

      expect(seen).toEqual([otherUserId]);
    });
  });

  it("binds to any signal", () => {
    const userId = signal<UserId | null>(otherUserId);
    const context = TestBed.runInInjectionContext(() => new CipherAccountContext().bind(userId));

    expect(context.explicitUserId()).toBe(otherUserId);
    userId.set(null);
    expect(context.explicitUserId()).toBeUndefined();
  });
});
