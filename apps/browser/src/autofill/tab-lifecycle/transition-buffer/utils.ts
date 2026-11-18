import type { UserId } from "@bitwarden/common/types/guid";

import type { TransitionReport } from "../types";

import { TransitionValidity } from "./enums";
import type { BufferedTransitionReport, LiveFrame } from "./types";

/**
 * Stamps a reported transition with the time it was reported and the deadline it expires at.
 *
 * Stamping fails closed: a report that belongs to no account (no `userIds`), cannot be targeted
 * (no `tabId`), or cannot be validated later (no `documentId`, or an empty one) is rejected.
 *
 * @param report The facts of the transition.
 * @param options.now Epoch ms of stamping.
 * @param options.maxAgeMs How long the report stays actionable.
 * @returns The stamped report, or `undefined` if it cannot be stamped.
 */
export function registerTransition(
  report: TransitionReport,
  options: { now: number; maxAgeMs: number },
): BufferedTransitionReport | undefined {
  const { tabId, frameId, documentId } = report;
  const userIds = [...new Set((report.userIds ?? []).filter((userId) => !!userId))];
  if (userIds.length === 0 || tabId === undefined || !documentId) {
    return undefined;
  }

  return {
    userIds,
    tabId,
    frameId,
    documentId,
    stampedAt: options.now,
    expiresAt: options.now + options.maxAgeMs,
  };
}

/**
 * Decides whether a resolved transition may still be acted on.
 *
 * @param report The resolved transition.
 * @param live The frame as the browser reports it now, or `undefined` if the frame is gone.
 * @param now Epoch ms.
 */
export function validateTransition(
  report: BufferedTransitionReport,
  live: LiveFrame | undefined,
  now: number,
): TransitionValidity {
  // expiry first, so an expired report is never validated against a live frame
  if (now >= report.expiresAt) {
    return TransitionValidity.Expired;
  }
  if (live === undefined) {
    return TransitionValidity.FrameGone;
  }
  if (live.documentId === undefined) {
    return TransitionValidity.Unverifiable;
  }
  if (live.documentId !== report.documentId) {
    return TransitionValidity.DocumentChanged;
  }
  return TransitionValidity.Valid;
}

/**
 * The accounts a resolved transition may still be acted on for: those it was attributed to that
 * are the active account or serve autofill now, in the report's order. Empty when none is left,
 * and the transition must then not be acted on. An account that started serving after the
 * transition was reported is not among them.
 *
 * @param report The resolved transition.
 * @param currentUserIds The active account and the accounts autofill serves now.
 */
export function servedTransitionAccounts(
  report: Pick<BufferedTransitionReport, "userIds">,
  currentUserIds: Iterable<UserId>,
): UserId[] {
  const current = new Set(currentUserIds);
  return report.userIds.filter((userId) => current.has(userId));
}

/**
 * Identifies a frame across reports.
 */
export function transitionKey(report: Pick<BufferedTransitionReport, "tabId" | "frameId">): string {
  return `${report.tabId}:${report.frameId ?? -1}`;
}
