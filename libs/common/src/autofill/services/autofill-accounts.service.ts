import {
  combineLatest,
  distinctUntilChanged,
  map,
  Observable,
  of,
  shareReplay,
  switchMap,
} from "rxjs";

import { AccountService } from "../../auth/abstractions/account.service";
import { AuthService } from "../../auth/abstractions/auth.service";
import { AuthenticationStatus } from "../../auth/enums/authentication-status";
import { AUTOFILL_SETTINGS_DISK, StateProvider, UserKeyDefinition } from "../../platform/state";
import { UserId } from "../../types/guid";

/**
 * Whether an account serves autofill while another account is the active one. Stored per account
 * and removed with it.
 */
export const MULTI_ACCOUNT_AUTOFILL_ENABLED = new UserKeyDefinition<boolean>(
  AUTOFILL_SETTINGS_DISK,
  "multiAccountAutofillEnabled",
  {
    deserializer: (value: boolean) => value ?? false,
    clearOn: ["logout"],
  },
);

/** The accounts autofill serves. */
export abstract class AutofillAccountsService {
  /**
   * The accounts whose vaults autofill may read, in order of precedence.
   *
   * The active account comes first when it is unlocked. Every other unlocked account that has
   * opted in ({@link enabled$}) follows, in the order the accounts were added to the client. A
   * locked or logged-out account is never listed. With no account opted in, this is the unlocked
   * active account alone, or empty.
   *
   * Emits the current list on subscription, then only when the list changes.
   */
  abstract readonly autofillUserIds$: Observable<UserId[]>;
  /** Whether `userId` is in {@link autofillUserIds$}. Emits only when the answer changes. */
  abstract isAutofillUser$(userId: UserId): Observable<boolean>;
  /**
   * Whether `userId` has opted in to serving autofill while it is not the active account.
   * Defaults to `false`. The active account serves autofill regardless of this setting.
   */
  abstract enabled$(userId: UserId): Observable<boolean>;
  /** Sets the opt-in read by {@link enabled$}. */
  abstract setEnabled(userId: UserId, enabled: boolean): Promise<void>;
}

type AccountState = { userId: UserId; unlocked: boolean; enabled: boolean };

export class DefaultAutofillAccountsService implements AutofillAccountsService {
  readonly autofillUserIds$: Observable<UserId[]>;

  constructor(
    private readonly stateProvider: StateProvider,
    private readonly accountService: AccountService,
    private readonly authService: AuthService,
  ) {
    const accountStates$ = this.accountService.accounts$.pipe(
      map((accounts) => Object.keys(accounts) as UserId[]),
      distinctUntilChanged(sameUserIds),
      switchMap((userIds) =>
        userIds.length === 0
          ? of([] as AccountState[])
          : combineLatest(userIds.map((userId) => this.accountState$(userId))),
      ),
    );
    const activeUserId$ = this.accountService.activeAccount$.pipe(
      map((account) => account?.id),
      distinctUntilChanged(),
    );

    this.autofillUserIds$ = combineLatest([activeUserId$, accountStates$]).pipe(
      map(([activeUserId, accountStates]) => {
        const unlocked = accountStates.filter((account) => account.unlocked);
        return [
          ...unlocked.filter((account) => account.userId === activeUserId),
          ...unlocked.filter((account) => account.userId !== activeUserId && account.enabled),
        ].map((account) => account.userId);
      }),
      distinctUntilChanged(sameUserIds),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }

  isAutofillUser$(userId: UserId): Observable<boolean> {
    return this.autofillUserIds$.pipe(
      map((userIds) => userIds.includes(userId)),
      distinctUntilChanged(),
    );
  }

  enabled$(userId: UserId): Observable<boolean> {
    return this.stateProvider
      .getUser(userId, MULTI_ACCOUNT_AUTOFILL_ENABLED)
      .state$.pipe(map((enabled) => enabled ?? false));
  }

  async setEnabled(userId: UserId, enabled: boolean): Promise<void> {
    await this.stateProvider.getUser(userId, MULTI_ACCOUNT_AUTOFILL_ENABLED).update(() => enabled);
  }

  private accountState$(userId: UserId): Observable<AccountState> {
    return combineLatest([this.authService.authStatusFor$(userId), this.enabled$(userId)]).pipe(
      map(([status, enabled]) => ({
        userId,
        unlocked: status === AuthenticationStatus.Unlocked,
        enabled,
      })),
    );
  }
}

function sameUserIds(a: UserId[], b: UserId[]): boolean {
  return a.length === b.length && a.every((userId, index) => userId === b[index]);
}
