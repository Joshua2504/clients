import { mock } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom, of } from "rxjs";

import { AccountInfo, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { UserId } from "@bitwarden/common/types/guid";

import { lockedPasskeyUserIds$ } from "./locked-passkey-accounts";

describe("lockedPasskeyUserIds$", () => {
  const activeUserId = "active-user" as UserId;
  const otherUserId = "other-user" as UserId;
  const thirdUserId = "third-user" as UserId;

  let statuses: Map<UserId, BehaviorSubject<AuthenticationStatus>>;
  let enabled: Map<UserId, boolean>;
  let locked$: ReturnType<typeof lockedPasskeyUserIds$>;

  const locked = () => firstValueFrom(locked$);

  beforeEach(() => {
    statuses = new Map(
      [activeUserId, otherUserId, thirdUserId].map((userId) => [
        userId,
        new BehaviorSubject<AuthenticationStatus>(AuthenticationStatus.Locked),
      ]),
    );
    enabled = new Map([
      [activeUserId, false],
      [otherUserId, true],
      [thirdUserId, false],
    ]);

    const accountService = mock<AccountService>();
    accountService.accounts$ = of({
      [otherUserId]: {},
      [thirdUserId]: {},
      [activeUserId]: {},
    } as Record<UserId, AccountInfo>);
    accountService.activeAccount$ = of({ id: activeUserId } as any);
    const authService = mock<AuthService>();
    authService.authStatusFor$.mockImplementation((userId) => statuses.get(userId)!);

    locked$ = lockedPasskeyUserIds$(accountService, authService, {
      enabled$: (userId) => of(enabled.get(userId) ?? false),
    });
  });

  it("lists the locked active account first, then the locked accounts that opted in", async () => {
    expect(await locked()).toEqual([activeUserId, otherUserId]);
  });

  it("leaves out an account that is unlocked", async () => {
    statuses.get(activeUserId)!.next(AuthenticationStatus.Unlocked);

    expect(await locked()).toEqual([otherUserId]);
  });

  it("leaves out an account that is logged out", async () => {
    statuses.get(otherUserId)!.next(AuthenticationStatus.LoggedOut);

    expect(await locked()).toEqual([activeUserId]);
  });

  it("is empty when every account that would serve is unlocked", async () => {
    statuses.get(activeUserId)!.next(AuthenticationStatus.Unlocked);
    statuses.get(otherUserId)!.next(AuthenticationStatus.Unlocked);

    expect(await locked()).toEqual([]);
  });
});
