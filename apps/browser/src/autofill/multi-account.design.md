> **Scope:** This document describes the desired state for web browser autofill that serves several
> accounts at once.
>
> **Audience:** Engineers should align their decisions and code generators should align their implementation with the design described within this document.

# Multi-account autofill

> [!NOTE]
> Companion to [autofill.design.md](./autofill.design.md),
> [orchestrator.design.md](./orchestrator.design.md) and [lifecycle.design.md](./lifecycle.design.md).
> Those documents say "the active account". Once a surface is converted (see
> [Conversion checklist](#conversion-checklist)), read that as "the account that owns the cipher",
> under the rules below.

> [!WARNING]
> Only the foundation exists: the services and types under [API contract](#api-contract) are
> implemented and registered, and nothing calls them yet. Every surface still serves the active
> account only.

The browser extension holds several accounts, and switching between them does not lock the one
left behind. Autofill nevertheless serves only the active account. Multi-account autofill lets
every unlocked account that has opted in serve the experiences that act on web pages. The active
account remains what the popup shows and edits.

## Autofill accounts

The **autofill accounts** are the accounts whose vaults autofill may read, in order of precedence:

1. the active account, when it is unlocked;
2. every other unlocked account that has opted in, in the order the accounts were added to the
   extension.

- **The opt-in is per account and off by default.** It is the account's own state, stored on disk
  and cleared when the account logs out. It means "this account serves autofill while another
  account is active". The active account serves autofill whether or not it has opted in.
- **A locked or logged-out account is never an autofill account.** Autofill raises an unlock prompt
  for the active account only.
- **With no account opted in, the autofill accounts are the unlocked active account alone, or
  none.** Autofill then behaves exactly as it did before this feature. This holds per call: the
  multi-account policy forwards every lookup of a single account to the wrapped policy unchanged.
- **The opt-in is a risk decision the user makes** (see
  [principles.md](./principles.md#surface-risk-do-not-decide-it-for-the-user)). It mixes vaults,
  such as a work and a personal one, on the same page. The control that sets it must say so, must
  be offered only for an account that is unlocked, and injected UI must show which account each
  cipher belongs to.

## API contract

### `AutofillAccountsService`

`@bitwarden/common/autofill/services/autofill-accounts.service`
(`libs/common/src/autofill/services/autofill-accounts.service.ts`). Background:
`MainBackground.autofillAccountsService`. Popup: inject `AutofillAccountsService`.

```ts
export const MULTI_ACCOUNT_AUTOFILL_ENABLED: UserKeyDefinition<boolean>; // AUTOFILL_SETTINGS_DISK, "multiAccountAutofillEnabled", clearOn: ["logout"]

export abstract class AutofillAccountsService {
  abstract readonly autofillUserIds$: Observable<UserId[]>;
  abstract isAutofillUser$(userId: UserId): Observable<boolean>;
  abstract enabled$(userId: UserId): Observable<boolean>;
  abstract setEnabled(userId: UserId, enabled: boolean): Promise<void>;
}

export class DefaultAutofillAccountsService implements AutofillAccountsService {
  constructor(
    stateProvider: StateProvider,
    accountService: AccountService,
    authService: AuthService,
  );
}
```

- `autofillUserIds$` emits the autofill accounts in the order above. It emits the current list on
  subscription and afterwards only when the list changes, so it follows unlock, lock, logout,
  login, switch and opt-in changes of every account. It may be empty.
- `isAutofillUser$(userId)` is membership of that list.
- `enabled$(userId)` is the stored opt-in, `false` when never set. It does not say whether the
  account currently serves autofill; `isAutofillUser$` does.

### `AccountCipher`

`@bitwarden/common/autofill/types/account-cipher`
(`libs/common/src/autofill/types/account-cipher.ts`).

```ts
export type AccountCipher<C = CipherView> = { readonly userId: UserId; readonly cipher: C };
export type AccountCipherRef = { readonly userId: UserId; readonly cipherId: string };
export function accountCipherRef(accountCipher: AccountCipher<{ id: string }>): AccountCipherRef;
export function accountCipherKey(ref: AccountCipherRef): string; // `${userId}:${cipherId}`
```

### `MultiAccountFillCipherPolicy`

`apps/browser/src/autofill/services/abstractions/multi-account-fill-cipher-policy.ts`, implemented
by `DefaultMultiAccountFillCipherPolicy` in
`apps/browser/src/autofill/services/default-multi-account-fill-cipher-policy.ts`. Background:
`MainBackground.multiAccountFillCipherPolicy`. Popup: inject `MultiAccountFillCipherPolicy`.

```ts
export abstract class MultiAccountFillCipherPolicy {
  abstract readonly changed$: Observable<void>;
  abstract ciphers(use: CipherUse): Promise<AccountCipher[]>;
  abstract ciphersForRefs(refs: AccountCipherRef[], use: CipherUse): Promise<AccountCipher[]>;
  abstract ciphersForUrl(
    url: string,
    use: CipherUse,
    options?: { includeOtherTypes?: CipherType[]; defaultMatch?: UriMatchStrategySetting },
  ): Promise<AccountCipher[]>;
  abstract lastLaunchedForUrl(
    url: string,
    autofillOnPageLoad: boolean,
  ): Promise<AccountCipher | undefined>;
  abstract lastUsedForUrl(
    url: string,
    autofillOnPageLoad: boolean,
  ): Promise<AccountCipher | undefined>;
  abstract nextCipherForUrl(url: string): Promise<AccountCipher | undefined>;
  abstract nextCardCipher(): Promise<AccountCipher | undefined>;
  abstract nextIdentityCipher(): Promise<AccountCipher | undefined>;
  abstract advanceRotation(key: string): void;
  abstract canOfferSave(form: SaveCandidate, userId: UserId): Promise<boolean>;
}

export class DefaultMultiAccountFillCipherPolicy implements MultiAccountFillCipherPolicy {
  constructor(
    fillCipherPolicy: FillCipherPolicy,
    autofillAccountsService: AutofillAccountsService,
    autofillSettingsService: Pick<
      AutofillSettingsServiceAbstraction,
      "autofillOnPageLoadDefaultFor$"
    >,
    now?: () => number,
  );
}
```

It mirrors [`FillCipherPolicy`](./services/abstractions/fill-cipher-policy.ts) without the
`userId` parameter and with `AccountCipher` results. It wraps the registered `FillCipherPolicy` and
asks it once per autofill account, so a build that replaces `FillCipherPolicy` keeps its rules for
every account. `FillCipherPolicy` and `DefaultFillCipherPolicy` are unchanged.

- **The accounts are read when a lookup runs.** No lookup takes a list of accounts, and none
  returns a cipher of an account that is not an autofill account at that moment.
- **Lists are grouped by account**, in `autofillUserIds$` order, and keep the wrapped policy's
  order within an account. A caller that sorts today keeps its comparator and applies it to
  `.cipher`: `list.sort((a, b) => compare(a.cipher, b.cipher))`. The sort is stable, so ciphers
  that tie stay in account order.
- **`ciphersForRefs`** returns the ciphers in the order of `refs`. It leaves out a cipher that no
  longer exists and a cipher whose account is not an autofill account. It replaces
  `FillCipherPolicy.ciphersForIds` and is how a reference becomes a cipher again.
- **`nextCipherForUrl`, `nextCardCipher`, `nextIdentityCipher`** walk one rotation for all
  accounts, ordered most recently used first; ciphers never used come last, the active account's
  first. `advanceRotation(key)` takes the same keys as today: the URL, `"cardCiphers"`,
  `"identityCiphers"`. A rotation keeps its order for 3 seconds after it was last read, as today.
  It starts over when the autofill accounts change. It holds references, not ciphers: each read
  returns the cipher as its account holds it at that moment.
- **`lastUsedForUrl` and `lastLaunchedForUrl`** choose across all accounts. With
  `autofillOnPageLoad`, a login qualifies by its own page-load setting, or by the default of _its
  own_ account (`AutofillSettingsServiceAbstraction.autofillOnPageLoadDefaultFor$(userId)`) when
  it has none.
- **`canOfferSave`** takes the account a save would go to and forwards to the wrapped policy.
- **`changed$`** emits on subscription, when the autofill accounts change, and when the wrapped
  policy's `changed$` emits for any of them.

With several accounts the multi-account policy does not call the wrapped policy's
`nextCipherForUrl`, `nextCardCipher`, `nextIdentityCipher`, `lastUsedForUrl` or
`lastLaunchedForUrl`. `CipherService` keeps those rotations per URL, not per account, so asking it
for two accounts in turn would return one account's ciphers for the other.

## Attributing a cipher to its account

A cipher that autofill holds, passes or names is always paired with the account whose vault it
came from: `AccountCipher` while the cipher is in hand, `AccountCipherRef` wherever it is named by
id.

A cipher id does not identify an account. An item shared through an organization has the same id
in the vault of every member, and two members can be signed in to the same extension. What differs
between them is everything that matters at fill time: each member's permissions on the item,
premium entitlement, policies, reprompt setting and last-used history. Therefore:

- **No lookup by cipher id alone.** Maps keyed by cipher id are keyed by `accountCipherKey(ref)`.
- **Every effect of a cipher runs for `accountCipher.userId`**: the premium check for TOTP, the
  last-used update, event collection, password reprompt, policy checks, the recorded account
  activity, and a password update. None of them reads the active account.
- **A message that names a cipher carries `{ userId, cipherId }`.** The background resolves it with
  `ciphersForRefs` and treats no result as a refusal. A reference from a content script or injected
  frame is untrusted input: `ciphersForRefs` only ever resolves it within the current autofill
  accounts. `userId` is an opaque token to injected code; do not send email addresses or names
  into the page beyond what an experience renders.
- **Held ciphers are re-validated at the commit.** The account must still be an autofill account
  when the credential is placed (`isAutofillUser$`); otherwise the fill is **denied**. This extends
  the existing rule that a lock or switch [retires](./lifecycle.design.md#retiring-an-opportunity)
  an opportunity: a lock of the cipher's account retires it, and a switch retires it only when the
  cipher's account stops being an autofill account.

The alternative considered was to leave `CipherView` bare and recover the account from a side
table keyed by object identity or by id. Identity does not survive the paths autofill uses:
ciphers are re-decrypted, cloned, serialized between popup and background, and referenced by id
from the inline menu, the notification bar and passkey prompts. A lookup by id is ambiguous for
shared items. A missing entry would fall back to the active account, which is exactly the
wrong-account effect to exclude, and the compiler would not flag it. With an explicit pair, a call
site that has not been converted does not compile. The larger diff is the price of that guarantee.

## When accounts disagree

Settings and policies are per account, and the accounts being served can differ.

- **A cipher is governed by its own account.** Apply the account's settings and policies to that
  account's ciphers: page-load default, URI match default, equivalent domains, cards and identities
  in the inline menu, TOTP auto-copy and premium, password reprompt, restricted item types, the
  basic-auth setting, and organization policies such as page-load activation.
- **Where one behaviour must cover the whole experience, the stricter wins.** If any autofill
  account disables or forbids it, it is off; a delay or timeout takes the shortest value. Examples:
  whether the autofiller is injected for page-load fill, whether a blocked domain suppresses
  injected UI, whether the notification bar offers to save, clipboard clearing.
- **A save has one target account.** It defaults to the active account and is subject to that
  account's policies (for example, a policy that removes the personal vault). An update goes to the
  account that owns the cipher being updated. Nothing is copied between accounts.
- **Do not withhold silently.** When an account's setting or policy keeps its ciphers out, the
  experience still works for the other accounts, and where the user would expect the cipher it
  says why it is missing.

## Conversion checklist

Each item converts one surface from the active account to the autofill accounts. Common to all:
replace `FillCipherPolicy` with `MultiAccountFillCipherPolicy`, drop the `userId` argument, carry
`AccountCipher` or `AccountCipherRef` instead of `CipherView` or a cipher id, and take every
per-account input from `accountCipher.userId`. Each conversion must leave behaviour unchanged
while no account has opted in, and adds the cases "two unlocked accounts, same URL in both", "one
of them locks while the surface is open" and "the same shared item in both accounts" to the
surface's spec.

Prerequisites in shared code, each needed before the first surface that depends on it ships:

- [ ] `CipherService.filterCiphersForUrl` reads equivalent domains and the default URI match of
      the active account (`DomainSettingsService`). Make both per account, so
      `getAllDecryptedForUrl(url, userId)` matches with `userId`'s settings.
- [ ] `EventCollectionService.collect` records for the active account. Give it the account.
- [ ] `UserVerificationService.hasMasterPassword()` in `AutofillService.isPasswordRepromptRequired`
      reads the active account. Pass the cipher's account, and verify the reprompt popout against
      that account.
- [ ] Sync: `fullSync` and the sync notifications in `default-server-notifications.service.ts`
      serve the active account only. Sync every unlocked account, so a non-active autofill
      account's vault is current.
- [ ] `AutofillSettingsService` and `DomainSettingsService` expose most settings for the active
      account only. Add per-account readers as surfaces need them, following
      `autofillOnPageLoadDefaultFor$`.

Surfaces:

- [ ] **`background/autofill-orchestrator.ts`** — `selectFill`, `selectLogin`,
      `selectCipherTypeCipher`, `autoSubmitLoginOnTab` select through the multi-account policy;
      `PlannedFill` and `AutoFillOptions` carry the cipher's `userId`. `commit` denies when the
      account is no longer an autofill account. `recordActiveAccountActivity` records activity for
      the cipher's account. A request with no autofill account is abandoned as it is today with no
      active account.
- [ ] **`services/autofill.service.ts`** — `doAutoFill` takes the account from its options: premium
      (`hasPremiumFromAnySource$`), `updateLastUsedDate`, event collection, TOTP, reprompt. Script
      injection (`injectAutofillScripts`) is on when any autofill account is unlocked, with
      page-load injection under the stricter-wins rule.
- [ ] **`background/overlay.background.ts`** — `inlineMenuCiphers` holds `AccountCipher`; the list
      sent to the inline menu carries an account label for display, and fill, view and
      passkey messages name the cipher by `AccountCipherRef`. Cards, identities and the
      show-cards/identities settings apply per account. Add-login data goes through
      `canOfferSave` for the target account. A lock of any autofill account rebuilds the list.
- [ ] **`services/autofill-badge-updater.service.ts`** — count `ciphersForUrl(url, Badge)` across
      accounts; recompute on `MultiAccountFillCipherPolicy.changed$` instead of the active
      account's `changed$`. The badge setting follows the stricter-wins rule.
- [ ] **`browser/cipher-context-menu-handler.ts`, `browser/context-menu-clicked-handler.ts`,
      `browser/main-context-menu-handler.ts`** — menu item ids encode `accountCipherKey`; titles
      show the account when more than one serves; a click resolves through `ciphersForRefs`. The
      "unlock" and "no match" entries depend on the autofill accounts, not the active account.
- [ ] **`background/web-request.background.ts`** (HTTP basic auth) — an automatic fill: candidates
      from all accounts, each under its own `enableBasicAuthResponse` setting and feature
      availability; with candidates from more than one account, do not answer.
- [ ] **`background/auto-submit-login.background.ts`** — the approved-host policy is read per
      account; a host approved by one account's organization submits only that account's ciphers.
- [ ] **`background/commands.background.ts`, `background/runtime.background.ts`,
      `background/tabs.background.ts`** — shortcuts act when any autofill account is unlocked;
      by-id fills (`ciphersForRefs`) take a reference; tab refreshes subscribe to
      `MultiAccountFillCipherPolicy.changed$`.
- [ ] **`rx/account-events.ts` and the lifecycle** — monitoring starts and stops on the autofill
      accounts becoming non-empty or empty, not on the active account alone; an opportunity is
      attributed to the autofill accounts at the time it is received and retired per the rule
      under [Attributing a cipher to its account](#attributing-a-cipher-to-its-account). Update
      [autofill.design.md](./autofill.design.md) ("the transition's account must be the active
      account") and [lifecycle.design.md](./lifecycle.design.md) in the same change.
- [ ] **`background/notification.background.ts`, `background/overlay-notifications.background.ts`**
      — queue messages carry the target `userId`. "Save" targets the active account by default,
      with a choice among autofill accounts; "update" targets the account that owns the matched
      cipher; a match in more than one account asks. `canOfferSave`, folders, collections,
      organizations and policies are read for the target account. At-risk password tasks
      (`SecurityTask`) are per account.
- [ ] **Passkeys: `fido2/background/fido2.background.ts`,
      `fido2/services/browser-fido2-user-interface.service.ts`, `popup/fido2/fido2.component.ts`,
      `libs/common/src/platform/services/fido2/fido2-authenticator.service.ts`** — assertion
      searches all autofill accounts and the picker returns an `AccountCipherRef`; registration
      chooses a target account, default active; excluded-credential checks cover all autofill
      accounts; user verification runs against the cipher's account.
- [ ] **Popup suggestions tab: `vault/popup/services/vault-popup-items.service.ts`,
      `vault/popup/services/vault-popup-autofill.service.ts`** — a section per further autofill
      account; filling uses the cipher's account; opening an item of another account switches the
      active account first.
- [ ] **Opt-in control: `auth/popup/account-switching/`** — a per-account toggle bound to
      `enabled$` / `setEnabled`, offered for unlocked accounts, with the risk explained where the
      choice is made.
