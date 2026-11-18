import { TestBed } from "@angular/core/testing";
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from "@angular/router";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { UserId } from "@bitwarden/common/types/guid";

import { BrowserRouterService } from "../../../platform/popup/services/browser-router.service";

import { fido2AuthGuard } from "./fido2-auth.guard";

describe("fido2AuthGuard", () => {
  const route = { queryParams: { sessionId: "session" } } as unknown as ActivatedRouteSnapshot;
  const state = { url: "/fido2?sessionId=session" } as RouterStateSnapshot;
  const lockUrlTree = {} as UrlTree;

  let authService: MockProxy<AuthService>;
  let routerService: MockProxy<BrowserRouterService>;
  let router: MockProxy<Router>;
  let autofillUserIds$: BehaviorSubject<UserId[]>;

  const runGuard = () => TestBed.runInInjectionContext(() => fido2AuthGuard(route, state));

  beforeEach(() => {
    authService = mock<AuthService>();
    routerService = mock<BrowserRouterService>();
    router = mock<Router>();
    router.createUrlTree.mockReturnValue(lockUrlTree);
    autofillUserIds$ = new BehaviorSubject<UserId[]>([]);

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: BrowserRouterService, useValue: routerService },
        { provide: Router, useValue: router },
        { provide: AutofillAccountsService, useValue: { autofillUserIds$ } },
      ],
    });
  });

  it("allows the route while the active account is unlocked", async () => {
    authService.getAuthStatus.mockResolvedValue(AuthenticationStatus.Unlocked);

    await expect(runGuard()).resolves.toBe(true);
  });

  it("redirects a locked active account to the lock screen when no account serves passkeys", async () => {
    authService.getAuthStatus.mockResolvedValue(AuthenticationStatus.Locked);

    await expect(runGuard()).resolves.toBe(lockUrlTree);
    expect(routerService.setPreviousUrl).toHaveBeenCalledWith(state.url);
    expect(router.createUrlTree).toHaveBeenCalledWith(["/lock"], {
      queryParams: route.queryParams,
    });
  });

  it("allows the route for a locked active account while another account serves passkeys", async () => {
    authService.getAuthStatus.mockResolvedValue(AuthenticationStatus.Locked);
    autofillUserIds$.next(["other-user" as UserId]);

    await expect(runGuard()).resolves.toBe(true);
    expect(routerService.setPreviousUrl).not.toHaveBeenCalled();
  });
});
