import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, NEVER, Subject } from "rxjs";
import { TestScheduler } from "rxjs/testing";

import { UserId } from "@bitwarden/common/types/guid";

import { AccountEvent, AccountEventKind } from "../../rx";
import { TabEdgeCause, TabState } from "../enums";
import type { TabEdge } from "../types";

import { TransitionBuffer } from "./abstractions";
import { bufferEnabled, feedTransitionBuffer } from "./rx";
import type { BufferedTransitionReport } from "./types";

function edge(from: TabState, to: TabState, cause: TabEdgeCause, focused = true): TabEdge {
  return { from, to, cause, focused };
}

const warm = edge(TabState.Hot, TabState.Warm, TabEdgeCause.Blur, false);

const userId = "user-1" as UserId;

function report(
  tabId: number,
  frameId: number | undefined,
  documentId: string,
  expiresAt = Number.MAX_SAFE_INTEGER,
  stampedAt = 0,
): BufferedTransitionReport {
  return { userIds: [userId], tabId, frameId, documentId, stampedAt, expiresAt };
}

describe("feedTransitionBuffer", () => {
  let report$: Subject<BufferedTransitionReport>;
  let tabLifecycleChanged$: Subject<readonly [number, TabEdge]>;
  let frameLost$: Subject<{ tabId: number; frameId: number | undefined }>;
  let tabRemoved$: Subject<number>;
  let enabled$: Subject<boolean>;
  let buffer: MockProxy<TransitionBuffer>;

  beforeEach(() => {
    report$ = new Subject();
    tabLifecycleChanged$ = new Subject();
    frameLost$ = new Subject();
    tabRemoved$ = new Subject();
    enabled$ = new Subject();
    buffer = mock<TransitionBuffer>();
    feedTransitionBuffer(buffer, {
      report$,
      tabLifecycleChanged$,
      frameLost$,
      tabRemoved$,
      enabled$,
    }).subscribe();
  });

  it("applies report$", () => {
    const a = report(1, 0, "a");

    report$.next(a);

    expect(buffer.report).toHaveBeenCalledWith(a);
  });

  it("applies tabLifecycleChanged$", () => {
    tabLifecycleChanged$.next([1, warm]);

    expect(buffer.lifecycleChanged).toHaveBeenCalledWith(1, warm);
  });

  it("applies frameLost$", () => {
    frameLost$.next({ tabId: 1, frameId: 0 });

    expect(buffer.frameLost).toHaveBeenCalledWith(1, 0);
  });

  it("applies tabRemoved$", () => {
    tabRemoved$.next(1);

    expect(buffer.tabRemoved).toHaveBeenCalledWith(1);
  });

  it("applies enabled$", () => {
    enabled$.next(false);

    expect(buffer.setEnabled).toHaveBeenCalledWith(false);
  });

  it("applies a value enabled$ has on subscription before any report", () => {
    const calls: string[] = [];
    const ordered = mock<TransitionBuffer>();
    ordered.setEnabled.mockImplementation(() => calls.push("setEnabled"));
    ordered.report.mockImplementation(() => calls.push("report"));

    feedTransitionBuffer(ordered, {
      report$: new BehaviorSubject(report(1, 0, "a")),
      tabLifecycleChanged$: NEVER,
      frameLost$: NEVER,
      tabRemoved$: NEVER,
      enabled$: new BehaviorSubject(true),
    }).subscribe();

    expect(calls).toEqual(["setEnabled", "report"]);
  });
});

describe("bufferEnabled", () => {
  const A = "user-a" as UserId;
  const B = "user-b" as UserId;

  let scheduler: TestScheduler;
  beforeEach(() => {
    scheduler = new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
  });

  // a legend for the account events
  const events: Record<string, AccountEvent> = {
    i: { kind: AccountEventKind.Login, userId: A },
    j: { kind: AccountEventKind.Login, userId: B },
    u: { kind: AccountEventKind.Unlock, userId: A },
    l: { kind: AccountEventKind.Lock, userId: A },
    m: { kind: AccountEventKind.Lock, userId: B },
    o: { kind: AccountEventKind.Logout, userId: A },
    q: { kind: AccountEventKind.Logout, userId: B },
    s: { kind: AccountEventKind.Switch, from: null, to: A },
    t: { kind: AccountEventKind.Switch, from: A, to: B },
    b: { kind: AccountEventKind.Bootstrapped },
    // the accounts autofill serves
    A: { kind: AccountEventKind.AutofillStart, userId: A },
    B: { kind: AccountEventKind.AutofillStart, userId: B },
    X: { kind: AccountEventKind.AutofillStop, userId: A },
    Y: { kind: AccountEventKind.AutofillStop, userId: B },
  };
  const signals = { t: true, f: false };

  it("starts at bootstrapped, enabled when the active account is signed in", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("isb", events).pipe(bufferEnabled())).toBe("--t", signals);
    });
  });

  it("starts at bootstrapped, disabled when nobody is signed in", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("b", events).pipe(bufferEnabled())).toBe("f", signals);
    });
  });

  it("starts disabled when the active account has not been switched to", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("ib", events).pipe(bufferEnabled())).toBe("-f", signals);
    });
  });

  it("sends no pulse for a lock or switch before bootstrapped", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("ijsltb", events).pipe(bufferEnabled())).toBe("-----t", signals);
    });
  });

  it("ignores a logout of an account that is not active", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("ijsb-q", events).pipe(bufferEnabled())).toBe("---t", signals);
    });
  });

  it("emits nothing before bootstrapped", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("is-o", events).pipe(bufferEnabled())).toBe("", signals);
    });
  });

  it("pulses false then true when the active account locks", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("isb-l", events).pipe(bufferEnabled())).toBe("--t-(ft)", signals);
    });
  });

  it("stays enabled, without a pulse, when the active account unlocks", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("isb-u", events).pipe(bufferEnabled())).toBe("--t", signals);
    });
  });

  it("ignores a lock of an account that is not active", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("ijsb-m", events).pipe(bufferEnabled())).toBe("---t", signals);
    });
  });

  it("pulses false then true on a switch between signed-in accounts", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("ijsb-t", events).pipe(bufferEnabled())).toBe("---t-(ft)", signals);
    });
  });

  it("disables when the active account logs out, and enables when it logs back in", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("isb-o-i", events).pipe(bufferEnabled())).toBe("--t-f-t", signals);
    });
  });

  it("enables on a switch while disabled, without a pulse", () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold("ib-s", events).pipe(bufferEnabled())).toBe("-f-t", signals);
    });
  });

  it.each([
    ["logout then switch", "ijsb-o-t", "---t-f-t"],
    ["switch then logout", "ijsb-t-o", "---t-(ft)"],
  ])("ends true, passing through false, for %s", (_name, input, expected) => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(cold(input, events).pipe(bufferEnabled())).toBe(expected, signals);
    });
  });

  describe("with accounts serving autofill", () => {
    it("pulses once for a lock of the active account, whichever of lock and stop comes first", () => {
      scheduler.run(({ cold, expectObservable }) => {
        expectObservable(cold("isAb-lX", events).pipe(bufferEnabled())).toBe("---t-(ft)", signals);
        expectObservable(cold("isAb-Xl", events).pipe(bufferEnabled())).toBe("---t--(ft)", signals);
      });
    });

    it("pulses once when another serving account locks, whichever of lock and stop comes first", () => {
      scheduler.run(({ cold, expectObservable }) => {
        expectObservable(cold("ijsABb-mY", events).pipe(bufferEnabled())).toBe(
          "-----t-(ft)",
          signals,
        );
        expectObservable(cold("ijsABb-Ym", events).pipe(bufferEnabled())).toBe(
          "-----t-(ft)",
          signals,
        );
      });
    });

    it("does not pulse on a switch that leaves the account behind serving", () => {
      scheduler.run(({ cold, expectObservable }) => {
        expectObservable(cold("ijsABb-t", events).pipe(bufferEnabled())).toBe("-----t", signals);
      });
    });

    it("pulses once on a switch away from an account that stops serving, in either order", () => {
      scheduler.run(({ cold, expectObservable }) => {
        expectObservable(cold("ijsAb-tBX", events).pipe(bufferEnabled())).toBe(
          "----t---(ft)",
          signals,
        );
        expectObservable(cold("ijsAb-XBt", events).pipe(bufferEnabled())).toBe(
          "----t---(ft)",
          signals,
        );
      });
    });

    it("pulses when a serving account that is not active opts out", () => {
      scheduler.run(({ cold, expectObservable }) => {
        expectObservable(cold("ijsABb-Y", events).pipe(bufferEnabled())).toBe(
          "-----t-(ft)",
          signals,
        );
      });
    });

    it("pulses when a serving account that is not active logs out", () => {
      scheduler.run(({ cold, expectObservable }) => {
        expectObservable(cold("ijsABb-qY", events).pipe(bufferEnabled())).toBe(
          "-----t-(ft)",
          signals,
        );
      });
    });

    it("does not pulse when an account starts serving", () => {
      scheduler.run(({ cold, expectObservable }) => {
        expectObservable(cold("ijsAb-B", events).pipe(bufferEnabled())).toBe("----t", signals);
      });
    });

    it("stays enabled, with a pulse, when the active account logs out while another serves", () => {
      scheduler.run(({ cold, expectObservable }) => {
        expectObservable(cold("ijsABb-o", events).pipe(bufferEnabled())).toBe(
          "-----t-(ft)",
          signals,
        );
      });
    });

    it("disables once the last serving account stops after the active account logged out", () => {
      scheduler.run(({ cold, expectObservable }) => {
        expectObservable(cold("ijsABb-o---XY", events).pipe(bufferEnabled())).toBe(
          "-----t-(ft)-f",
          signals,
        );
      });
    });
  });
});
