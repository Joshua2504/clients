import { UserId } from "@bitwarden/common/types/guid";

import { SaveCandidate } from "../services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../services/abstractions/multi-account-fill-cipher-policy";

/**
 * The account a new login is saved to unless the user picks another. See
 * `multi-account.design.md`, "When accounts disagree".
 *
 * - No account serves autofill: the active account, which is asked to unlock before the save.
 * - The active account alone serves autofill: the active account. Its policy is asked where the
 *   save is offered and where it is made, as it is without multi-account autofill.
 * - Otherwise the first of the autofill accounts, in their order of precedence, whose policy
 *   takes the login. That is the active account whenever it serves and may save.
 *
 * @param candidate The login that would be saved.
 * @param autofillUserIds The accounts that serve autofill, in order of precedence.
 * @param activeUserId The active account, if there is one.
 * @returns null when no account may save the login.
 */
export async function defaultSaveAccount(
  candidate: SaveCandidate,
  autofillUserIds: UserId[],
  activeUserId: UserId | null,
  policy: Pick<MultiAccountFillCipherPolicy, "canOfferSave">,
): Promise<UserId | null> {
  if (autofillUserIds.length === 0) {
    return activeUserId;
  }
  if (autofillUserIds.length === 1 && autofillUserIds[0] === activeUserId) {
    return activeUserId;
  }

  for (const userId of autofillUserIds) {
    if (await policy.canOfferSave(candidate, userId)) {
      return userId;
    }
  }
  return null;
}

/**
 * Whether injected UI names the account of what it shows: when more than one account serves
 * autofill, and when the only account that serves is not the active one, since the user would
 * otherwise take it for the account the popup shows.
 */
export function showsAccountLabels(
  autofillUserIds: UserId[],
  activeUserId: UserId | null,
): boolean {
  return (
    autofillUserIds.length > 1 ||
    (autofillUserIds.length === 1 && autofillUserIds[0] !== activeUserId)
  );
}
