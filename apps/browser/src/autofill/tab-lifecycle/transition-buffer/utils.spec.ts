import { UserId } from "@bitwarden/common/types/guid";

import { TransitionValidity } from "./enums";
import type { BufferedTransitionReport } from "./types";
import {
  registerTransition,
  servedTransitionAccounts,
  transitionKey,
  validateTransition,
} from "./utils";

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

describe("registerTransition", () => {
  const options = { now: 1_000, maxAgeMs: 500 };

  const userIds = [userId];
  const otherUserId = "user-2" as UserId;

  it("rejects a report without accounts", () => {
    expect(
      registerTransition({ userIds: undefined, tabId: 1, frameId: 0, documentId: "d" }, options),
    ).toBe(undefined);
    expect(
      registerTransition({ userIds: [], tabId: 1, frameId: 0, documentId: "d" }, options),
    ).toBe(undefined);
  });

  it("attributes the report to every account it names, once each and in order", () => {
    expect(
      registerTransition(
        { userIds: [otherUserId, userId, otherUserId], tabId: 1, frameId: 0, documentId: "d" },
        options,
      ),
    ).toEqual(expect.objectContaining({ userIds: [otherUserId, userId] }));
  });

  it("rejects a report without a tabId", () => {
    expect(
      registerTransition({ userIds, tabId: undefined, frameId: 0, documentId: "d" }, options),
    ).toBe(undefined);
  });

  it("rejects a report without a documentId", () => {
    expect(
      registerTransition({ userIds, tabId: 1, frameId: 0, documentId: undefined }, options),
    ).toBe(undefined);
  });

  it("rejects a report with an empty documentId", () => {
    expect(registerTransition({ userIds, tabId: 1, frameId: 0, documentId: "" }, options)).toBe(
      undefined,
    );
  });

  it("stamps tab 0 and frame 0", () => {
    expect(registerTransition({ userIds, tabId: 0, frameId: 0, documentId: "d" }, options)).toEqual(
      expect.objectContaining({ tabId: 0, frameId: 0 }),
    );
  });

  it("stamps the admission time and an absolute deadline", () => {
    expect(registerTransition({ userIds, tabId: 1, frameId: 2, documentId: "d" }, options)).toEqual(
      {
        userIds: [userId],
        tabId: 1,
        frameId: 2,
        documentId: "d",
        stampedAt: 1_000,
        expiresAt: 1_500,
      },
    );
  });

  it("stamps a report from the top frame whose frameId is absent", () => {
    expect(
      registerTransition({ userIds, tabId: 1, frameId: undefined, documentId: "d" }, options),
    ).toEqual(expect.objectContaining({ tabId: 1, frameId: undefined }));
  });
});

describe("servedTransitionAccounts", () => {
  const A = "user-a" as UserId;
  const B = "user-b" as UserId;
  const C = "user-c" as UserId;
  const attributed = { userIds: [A, B] };

  it("keeps the accounts that still serve, in the report's order", () => {
    expect(servedTransitionAccounts(attributed, [B, A])).toEqual([A, B]);
  });

  it("drops an account that stopped serving and keeps the others", () => {
    expect(servedTransitionAccounts(attributed, [B])).toEqual([B]);
  });

  it("does not add an account that started serving after the report", () => {
    expect(servedTransitionAccounts(attributed, [A, C])).toEqual([A]);
  });

  it("is empty when none of the report's accounts serves", () => {
    expect(servedTransitionAccounts(attributed, [C])).toEqual([]);
  });
});

describe("validateTransition", () => {
  const resolved = report(1, 0, "doc-a", 1_000);

  it("is Valid for a live frame showing the reported document", () => {
    expect(validateTransition(resolved, { documentId: "doc-a" }, 999)).toBe(
      TransitionValidity.Valid,
    );
  });

  it("is Expired at the deadline", () => {
    expect(validateTransition(resolved, { documentId: "doc-a" }, 1_000)).toBe(
      TransitionValidity.Expired,
    );
  });

  it.each([
    ["no live frame", undefined],
    ["an unidentified live frame", { documentId: undefined }],
    ["a different document", { documentId: "doc-b" }],
  ])("is Expired before it is judged against %s", (_name, live) => {
    expect(validateTransition(resolved, live, 2_000)).toBe(TransitionValidity.Expired);
  });

  it("is FrameGone when there is no live frame", () => {
    expect(validateTransition(resolved, undefined, 0)).toBe(TransitionValidity.FrameGone);
  });

  it("is Unverifiable, not FrameGone, when the live frame has no documentId", () => {
    expect(validateTransition(resolved, { documentId: undefined }, 0)).toBe(
      TransitionValidity.Unverifiable,
    );
  });

  it("is DocumentChanged when the frame shows another document", () => {
    expect(validateTransition(resolved, { documentId: "doc-b" }, 0)).toBe(
      TransitionValidity.DocumentChanged,
    );
  });
});

describe("transitionKey", () => {
  it("begins with the tab's id", () => {
    expect(transitionKey({ tabId: 12, frameId: 3 }).startsWith("12:")).toBe(true);
  });

  it("tells the top frame from frame 0", () => {
    expect(transitionKey({ tabId: 1, frameId: undefined })).not.toEqual(
      transitionKey({ tabId: 1, frameId: 0 }),
    );
  });

  it("tells tab 1 from tab 10", () => {
    expect(transitionKey({ tabId: 10, frameId: 0 }).startsWith(`${1}:`)).toBe(false);
  });
});
