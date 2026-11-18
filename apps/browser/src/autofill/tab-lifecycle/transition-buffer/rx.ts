import {
  concatMap,
  defer,
  from,
  ignoreElements,
  merge,
  Observable,
  OperatorFunction,
  tap,
} from "rxjs";

import { UserId } from "@bitwarden/common/types/guid";

import { AccountEvent, AccountEventKind } from "../../rx";
import type { TabEdge } from "../types";

import { TransitionBuffer } from "./abstractions";
import type { BufferedTransitionReport } from "./types";

/** What {@link feedTransitionBuffer} reads. */
export type BufferSources = {
  /** Stamped reports, as from `registerTransition`. */
  report$: Observable<BufferedTransitionReport>;
  /** Each state change the lifecycle machine reports, with its browser tab's id. */
  tabLifecycleChanged$: Observable<readonly [tabId: number, edge: TabEdge]>;
  /** Each frame that no longer exists. Not tied to the lifecycle machine. */
  frameLost$: Observable<Readonly<{ tabId: number; frameId: number | undefined }>>;
  /**
   * The id of each browser tab that is removed. The same source must end the tab's lifecycle
   * machine, or a change arriving after the removal brings the tab's lifecycle state back.
   */
  tabRemoved$: Observable<number>;
  /** Whether the buffer gathers. `false` clears it; it is disabled until this first emits. */
  enabled$: Observable<boolean>;
};

/**
 * Feeds a buffer from its sources. Subscribe to run; it emits nothing.
 *
 * `enabled$` is subscribed first, so a value it has on subscription is applied before any report.
 */
export function feedTransitionBuffer(
  buffer: TransitionBuffer,
  sources: BufferSources,
): Observable<never> {
  return merge(
    sources.enabled$.pipe(tap((enabled) => buffer.setEnabled(enabled))),
    sources.report$.pipe(tap((report) => buffer.report(report))),
    sources.tabLifecycleChanged$.pipe(tap(([tabId, edge]) => buffer.lifecycleChanged(tabId, edge))),
    sources.frameLost$.pipe(tap(({ tabId, frameId }) => buffer.frameLost(tabId, frameId))),
    sources.tabRemoved$.pipe(tap((tabId) => buffer.tabRemoved(tabId))),
  ).pipe(ignoreElements());
}

/**
 * The `enabled$` signal for a `TransitionBuffer`, from `accountEvents$`: `true` while the active
 * account is signed in, whether locked or unlocked, or autofill serves an account; `false`
 * otherwise.
 *
 * Its first value comes at `bootstrapped` and is the starting state, `false` included, so the
 * buffer can tell a start with nobody signed in from a later sign-in. After that it emits only
 * when the value flips, or when an account that could have served what the buffer holds can no
 * longer do so while it stays enabled. That emits `false` then `true` synchronously: the buffer
 * discards what it gathered before and keeps gathering after. Nothing between this operator and
 * the buffer may collapse the pair with `distinctUntilChanged`. The pair is emitted for:
 *
 * - a lock of the active account, or of another account autofill serves;
 * - a logout of an account autofill serves, or of the active account while another serves;
 * - a switch, unless the account it leaves keeps serving autofill;
 * - an account that stops serving autofill for any other reason, such as opting out.
 *
 * A change the sources report separately, such as a lock and the `autofillStop` it causes,
 * emits one pair, whichever arrives first. Without `autofillStart` and `autofillStop` events
 * this follows the active account alone.
 */
export function bufferEnabled(): OperatorFunction<AccountEvent, boolean> {
  return (event$) =>
    defer(() => {
      let active: UserId | null = null;
      const signedIn = new Set<UserId>();
      // the accounts autofill serves, less those a lock or logout has already been handled for
      const serving = new Set<UserId>();
      let bootstrapped = false;
      let enabled = false;

      const signals = (event: AccountEvent): boolean[] => {
        if (event.kind === AccountEventKind.Bootstrapped) {
          bootstrapped = true;
          return [enabled];
        }

        const wasEnabled = enabled;
        // whether an account that could have served what the buffer holds no longer can
        let cleared = false;
        if (event.kind === AccountEventKind.Login) {
          signedIn.add(event.userId);
        } else if (event.kind === AccountEventKind.Logout) {
          signedIn.delete(event.userId);
          cleared = serving.delete(event.userId) || event.userId === active;
        } else if (event.kind === AccountEventKind.Lock) {
          cleared = serving.delete(event.userId) || event.userId === active;
        } else if (event.kind === AccountEventKind.Switch) {
          // the account left behind keeps what it gathered while it keeps serving
          cleared = event.from === null || !serving.has(event.from);
          active = event.to;
        } else if (event.kind === AccountEventKind.AutofillStart) {
          serving.add(event.userId);
        } else if (event.kind === AccountEventKind.AutofillStop) {
          // the active account stops serving by a lock or a logout, which report it themselves
          cleared = serving.delete(event.userId) && event.userId !== active;
        }
        enabled = (active !== null && signedIn.has(active)) || serving.size > 0;

        if (!bootstrapped) {
          return [];
        }
        if (cleared && wasEnabled && enabled) {
          return [false, true];
        }
        return enabled === wasEnabled ? [] : [enabled];
      };

      return event$.pipe(concatMap((event) => from(signals(event))));
    });
}
