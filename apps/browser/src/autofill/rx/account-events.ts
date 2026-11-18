import { combineLatest, concatMap, from, Observable, of, scan } from "rxjs";

import { Account } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { getOptionalUserId } from "@bitwarden/common/auth/services/account.service";
import { UserId } from "@bitwarden/common/types/guid";

/** What an {@link AccountEvent} reports. */
export const AccountEventKind = Object.freeze({
  /**
   * The account signed in, whether locked or unlocked. Each account already signed in at the first
   * observation is reported immediately.
   */
  Login: "login",
  /** A signed-in account changed from locked to unlocked. */
  Unlock: "unlock",
  /** A signed-in account changed from unlocked to locked. */
  Lock: "lock",
  /** The account signed out. */
  Logout: "logout",
  /**
   * The active account changed to `to`, which is signed in. `from` is the account the last switch
   * went to, or `null` before the first. A switch to a signed-out account comes right after its
   * login. The active account becoming none emits nothing, so its return to the same account emits
   * nothing either.
   */
  Switch: "switch",
  /**
   * The account became one autofill serves: it is unlocked, and it is the active account or has
   * opted in to serve autofill beside it. Each account autofill already serves at the first
   * observation is reported immediately. See `multi-account.design.md`, "Autofill accounts".
   */
  AutofillStart: "autofillStart",
  /** The account stopped being one autofill serves: it locked, logged out, or lost its place. */
  AutofillStop: "autofillStop",
  /** The first observation has been reported: every event before it describes the accounts then. */
  Bootstrapped: "bootstrapped",
} as const);
export type AccountEventKind = (typeof AccountEventKind)[keyof typeof AccountEventKind];

/** Something that happened to an account; see {@link AccountEventKind}. */
export type AccountEvent =
  | Readonly<{ kind: typeof AccountEventKind.Login; userId: UserId }>
  | Readonly<{ kind: typeof AccountEventKind.Unlock; userId: UserId }>
  | Readonly<{ kind: typeof AccountEventKind.Lock; userId: UserId }>
  | Readonly<{ kind: typeof AccountEventKind.Logout; userId: UserId }>
  | Readonly<{ kind: typeof AccountEventKind.Switch; from: UserId | null; to: UserId }>
  | Readonly<{ kind: typeof AccountEventKind.AutofillStart; userId: UserId }>
  | Readonly<{ kind: typeof AccountEventKind.AutofillStop; userId: UserId }>
  | Readonly<{ kind: typeof AccountEventKind.Bootstrapped }>;

type Statuses = Record<UserId, AuthenticationStatus>;
type Reduction = Readonly<{
  statuses: Statuses;
  active: UserId | null;
  autofill: readonly UserId[];
  events: AccountEvent[];
}>;

const { LoggedOut, Locked } = AuthenticationStatus;

/** The events between one observation of the accounts and the next. */
function reduce(
  previous: Reduction | undefined,
  activeUserId: UserId | null,
  statuses: Statuses,
  autofill: readonly UserId[],
): Reduction {
  const before: Statuses = previous?.statuses ?? {};
  const userIds = new Set([...Object.keys(before), ...Object.keys(statuses)] as UserId[]);

  const logins: AccountEvent[] = [];
  const changes: AccountEvent[] = [];
  for (const userId of userIds) {
    const was = before[userId] ?? LoggedOut;
    const is = statuses[userId] ?? LoggedOut;
    if (was === is) {
      continue;
    }
    if (was === LoggedOut) {
      logins.push({ kind: AccountEventKind.Login, userId });
    } else if (is === LoggedOut) {
      changes.push({ kind: AccountEventKind.Logout, userId });
    } else {
      changes.push({
        kind: is === Locked ? AccountEventKind.Lock : AccountEventKind.Unlock,
        userId,
      });
    }
  }

  // a switch implies the account it goes to is signed in, so one to a signed-out account waits
  // for that account's login
  let active = previous?.active ?? null;
  const switches: AccountEvent[] = [];
  if (
    activeUserId !== null &&
    activeUserId !== active &&
    (statuses[activeUserId] ?? LoggedOut) !== LoggedOut
  ) {
    switches.push({ kind: AccountEventKind.Switch, from: active, to: activeUserId });
    active = activeUserId;
  }

  const served = previous?.autofill ?? [];
  const autofillChanges: AccountEvent[] = [
    ...autofill
      .filter((userId) => !served.includes(userId))
      .map((userId) => ({ kind: AccountEventKind.AutofillStart, userId })),
    ...served
      .filter((userId) => !autofill.includes(userId))
      .map((userId) => ({ kind: AccountEventKind.AutofillStop, userId })),
  ];

  const events = [...logins, ...switches, ...changes, ...autofillChanges];
  if (previous === undefined) {
    events.push({ kind: AccountEventKind.Bootstrapped });
  }
  return { statuses, active, autofill, events };
}

/**
 * The accounts' history as events. The first observation is described as changes from no accounts:
 * a `login` for each signed-in account, a `switch` to the active one if it is signed in, an
 * `autofillStart` for each account autofill serves, then `bootstrapped`.
 *
 * Within one observation, logins come first, then the switch, then the other changes, then the
 * accounts autofill starts and stops serving. The sources update separately, so changes that
 * happen together can arrive in either order: an active account that signs out as another becomes
 * active emits `logout` then `switch`, or `switch` then `logout`; an account that locks emits
 * `lock` then `autofillStop`, or `autofillStop` then `lock`.
 *
 * @param activeAccount$ The active account, as from `AccountService.activeAccount$`.
 * @param authStatuses$ Each account's status, as from `AuthService.authStatuses$`.
 * @param autofillUserIds$ The accounts autofill serves, as from
 *   `AutofillAccountsService.autofillUserIds$`. Without it, no `autofillStart` or `autofillStop`
 *   is reported.
 */
export function accountEvents$(
  activeAccount$: Observable<Account | null>,
  authStatuses$: Observable<Statuses>,
  autofillUserIds$: Observable<readonly UserId[]> = of([]),
): Observable<AccountEvent> {
  return combineLatest([
    activeAccount$.pipe(getOptionalUserId),
    authStatuses$,
    autofillUserIds$,
  ]).pipe(
    scan(
      (previous: Reduction | undefined, [activeUserId, statuses, autofill]) =>
        reduce(previous, activeUserId, statuses, autofill),
      undefined,
    ),
    concatMap((reduction) => from(reduction!.events)),
  );
}
