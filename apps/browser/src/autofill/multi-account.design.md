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

> [!NOTE]
> Every surface under [Conversion checklist](#conversion-checklist) is converted. What still
> follows the active account is listed there per surface and collected under
> [Known limits](#known-limits).

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
- **A locked or logged-out account is never an autofill account.** Autofill raises an unlock
  prompt, always for the active account, only when no autofill account can serve the request, or
  when the user picked something that belongs to the locked active account (a save prompt that
  was queued for it). While at least one autofill account is unlocked, every autofill experience
  works for the accounts that serve, whether the active account is unlocked, locked or missing.
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
`lastLaunchedForUrl`. Each of those answers for one account: `CipherService` keeps a rotation per
user and URL, so a wrapped policy can only walk the ciphers of the account it is asked for. A
shortcut pressed repeatedly must instead walk the ciphers of every autofill account in one order,
and a page-load fill must prefer the most recently used login whichever account holds it. No
sequence of per-account answers gives that order, so the multi-account policy merges the accounts'
ciphers and keeps the merged rotation itself. `advanceRotation` advances that merged rotation; it
reaches the wrapped policy only while a single account is served, where it advances that account's
own rotation.

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
  whether the autofiller is injected for page-load fill, whether the toolbar badge counts, the
  clipboard clearing delay (`SystemService`: the shortest delay any autofill account has set,
  "never" only when all say so), and fill assist (`DomainSettingsService.fillAssistPolicy$`: the
  organization default applies only when it applies to every autofill account, and a custom rules
  feed only when all of them name the same one; otherwise the server's feed).
- **Some settings belong to the extension, not to an account, and need no rule:** inline menu
  visibility, the notification bar's add and update prompts, never-save domains, blocked domains,
  favicons, the context menu, passkeys on or off, and the user's own fill assist toggle. They are
  global state and read the same whichever account is active.
- **An offer to save is not such a behaviour: it has one target account.** The notification bar
  offers to save when at least one autofill account may save the login (`canOfferSave`), and it
  offers only the accounts that may. An account whose policy forbids the save is left out of the
  choice; it does not switch the offer off for the others.
- **A save has one target account** (`utils/save-target.ts`, `defaultSaveAccount`). It defaults to
  the active account while that account serves autofill, and otherwise to the first autofill
  account, in order of precedence, whose policy takes the login (`canOfferSave`). With no autofill
  account it is the active account, which is asked to unlock first. The target is subject to its
  own policies (for example, a policy that removes the personal vault). An update goes to the
  account that owns the cipher being updated. Nothing is copied between accounts, and nothing is
  saved to an account the user did not see named: injected UI names the account whenever more
  than one serves or the one that serves is not the active account (`showsAccountLabels`).
- **A password is generated for the save target.** The inline menu's generator, the context
  menu's and the shortcut's use the generator options, policies and history of the account the
  new login would be saved to, and the generated password is filled as that account's.
- **Do not withhold silently.** When an account's setting or policy keeps its ciphers out, the
  experience still works for the other accounts, and where the user would expect the cipher it
  says why it is missing.

## Account-scoped item pages

The popup's vault item pages, the popouts the background opens, and the `libs/vault` services
behind them take the account that owns the cipher as an explicit `userId`. A caller opens or acts
on an item of any autofill account without making that account the active one.

- **`userId` is always optional and always last.** Without it, every call, input and route below
  means the active account, exactly as before. Web and desktop pass none.
- **A page opened with `userId` operates on that account alone.** It loads, decrypts, checks
  permissions and premium, re-prompts, saves, deletes and logs events for `userId`, and lists that
  account's organizations, collections and folders. It never reads or writes the active account's
  vault, also not when the two accounts hold the same shared item.
- **`userId` must be an unlocked autofill account** (`AutofillAccountsService.isAutofillUser$`).
  A page opened for an account that is not one loads nothing and leaves. When the account stops
  being one while the page is open (it locked, logged out or withdrew its opt-in), the page
  leaves: a single action popout closes, any other page goes to `/tabs/vault` with the popup
  history cleared. It never falls back to the active account. While `userId` is the active
  account, its lock is left to the popup's own lock handling.
- **The page says whose vault it shows.** While `userId` is not the active account, the page shows
  "Vault of user@example.com" (`itemAccountHint`) above its content, and the master password
  re-prompt names the account (`masterPasswordOfAccount`).

### Routes

The query param is `userId` on every vault item route
(`ITEM_ACCOUNT_QUERY_PARAM`, `itemAccountQueryParams(userId)`, `itemAccountFromParams(params)` in
`vault/popup/services/vault-popup-item-account.service.ts`).

```ts
// View
router.navigate(["/view-cipher"], { queryParams: { cipherId, type, userId } });
// Add a new item to the vault of `userId`
router.navigate(["/add-cipher"], { queryParams: { type, userId /* , name, uri, username, … */ } });
// Edit
router.navigate(["/edit-cipher"], { queryParams: { cipherId, type, userId } });
// Clone
router.navigate(["/clone-cipher"], { queryParams: { clone: "true", cipherId, type, userId } });
// Attachments, password history, assign collections
router.navigate(["/attachments"], { queryParams: { cipherId, userId } });
router.navigate(["/cipher-password-history"], { queryParams: { cipherId, userId } });
router.navigate(["/assign-collections"], { queryParams: { cipherId, userId } });
```

Each page carries `userId` to the pages it opens: view to edit, add to the view of the saved item,
edit to attachments, the item history to the password history, and `restrictedCipherGuard` to the
view it redirects to. The view page takes the load actions it always took (`action`,
`senderTabId`) and performs them for `userId`.

A page reads its account from `VaultPopupItemAccount`, provided on the page component:

```ts
@Injectable()
export class VaultPopupItemAccount {
  readonly explicitUserId$: Observable<UserId | undefined>; // the route's `userId`
  readonly explicitUserId: Signal<UserId | undefined>;
  readonly userId$: Observable<UserId>; // `userId` while it serves, else the active account
  readonly accountHint: Signal<string | undefined>; // email while `userId` is not the active account
  userId(): Promise<UserId | null>; // null: the account does not serve, the page is leaving
  queryParams(): { userId?: UserId }; // for the next page
}
```

### Popouts from the background

`vault/popup/utils/vault-popout-window.ts`:

```ts
openViewVaultItemPopout(senderTab, { cipherId, action, forceCloseExistingWindows?, userId? });
openVaultItemPasswordRepromptPopout(senderTab, { cipherId, action, userId? });
openAddEditVaultItemPopout(senderTab, { cipherId?, cipherType?, fillAfterSave?, userId? });
viewVaultItemPopoutKey(cipherId: string, userId?: UserId): string;
closeViewVaultItemPopout(viewVaultItemPopoutKey(cipherId, userId));
```

- **View:** `openViewVaultItemPopout(tab, { cipherId, action: SHOW_AUTOFILL_BUTTON, userId })`.
- **Re-prompt, then fill:**
  `openVaultItemPasswordRepromptPopout(tab, { cipherId, action: AUTOFILL_ID, userId })`. It tells
  the tab `bgVaultItemRepromptPopoutOpened`, as before. The popout fills with
  `VaultPopupAutofillService.doAutofillForAccount({ userId, cipher }, false)`, which sends `fillCipherForPopup` with `{ tabId, tabUrl, cipherId, userId }` and closes with
  `closeViewVaultItemPopout(viewVaultItemPopoutKey(cipherId, userId))`. The copy actions
  (`COPY_USERNAME_ID`, `COPY_PASSWORD_ID`, `COPY_VERIFICATION_CODE_ID`) re-prompt and copy for
  `userId` the same way.
- **Re-prompt for a password update:** `action: UPDATE_PASSWORD` asks for the master password of
  `userId` and answers with `bgHandleReprompt` `{ tab, cipherId, success, userId }`.
- **Add or edit:** store the prefill for the target account first
  (`cipherService.setAddEditCipherInfo(info, userId)`), then
  `openAddEditVaultItemPopout(tab, { cipherType, userId })` for a new item or
  `openAddEditVaultItemPopout(tab, { cipherId, userId })` for an edit. The message to a popout
  that is already open is `reloadAddEditCipherData` with `data: { cipherId, cipherType, userId }`;
  a popout reloads only when `data.userId` is its own account. After "Save and fill" the popout
  sends `showLoginSavedNotification` with the `userId` it saved to.
- **Popout keys name the account.** `viewVaultItemPopoutKey(cipherId, userId)` is
  `vault_viewVaultItem_<userId>_<cipherId>`, and the add/edit key is
  `vault_AddEditVaultItem_<userId>[_<cipherId>|_<cipherType>]`. Without `userId` the keys are the
  ones used before. The popouts of one shared item in two accounts are therefore two popouts.

### Acting on an item

`@bitwarden/vault`:

```ts
// Master password re-prompt: asks for and verifies the master password of `userId`.
PasswordRepromptService.passwordRepromptCheck(cipher: CipherViewLike, userId?: UserId): Promise<boolean>;
PasswordRepromptService.showPasswordPrompt(userId?: UserId): Promise<boolean>;
PasswordRepromptService.enabled(userId?: UserId): Promise<boolean>;

// Copy: re-prompt, TOTP premium and the collected event are those of `userId`.
CopyCipherFieldService.copy(valueToCopy: string, actionType: CopyAction, cipher: CipherViewLike, skipReprompt?: boolean, userId?: UserId): Promise<boolean>;
CopyCipherFieldService.totpAllowed(cipher: CipherViewLike, userId?: UserId): Promise<boolean>;

// Archive
ArchiveCipherUtilitiesService.archiveCipher(cipher: CipherView, skipReprompt?: boolean, userId?: UserId);
ArchiveCipherUtilitiesService.unarchiveCipher(cipher: CipherView, skipReprompt?: boolean, userId?: UserId);

// Cipher form: `config.userId` is the vault the form reads and writes.
CipherFormConfigService.buildConfig(mode: CipherFormMode, cipherId?: CipherId, cipherType?: CipherType, userId?: UserId): Promise<CipherFormConfig>;
CipherFormService.decryptCipher(cipher: Cipher, userId?: UserId): Promise<CipherView>;
CipherFormService.saveCipher(cipher: CipherView, config: CipherFormConfig): Promise<CipherView>; // saves to config.userId
```

```html
<!-- Everything the view renders follows `userId`: collections, organization, folder, premium,
     tasks, password risk, copy buttons, attachments, password history, events. -->
<app-cipher-view [cipher]="cipher" [userId]="userId" />
<!-- Copy one field of a full cipher or of a list view, which is decrypted from the vault of `userId`. -->
<button appCopyField="password" [cipher]="cipher" [userId]="userId"></button>
<vault-item-copy-actions [cipher]="cipher" [userId]="userId" />
<app-cipher-attachments [cipherId]="cipherId" [userId]="userId" />
<app-download-attachment [cipher]="cipher" [attachment]="attachment" [userId]="userId" />
<assign-collections [params]="{ ciphers, organizationId, availableCollections, userId }" />
```

`@bitwarden/common`:

```ts
CipherAuthorizationService.canDeleteCipher$(cipher: CipherLike, isAdminConsoleAction?: boolean, userId?: UserId): Observable<boolean>;
CipherAuthorizationService.canRestoreCipher$(cipher: CipherLike, isAdminConsoleAction?: boolean, userId?: UserId): Observable<boolean>;
CipherAuthorizationService.canEditCipher$(cipher: CipherLike, isAdminConsoleAction?: boolean, userId?: UserId): Observable<boolean>;
CipherAuthorizationService.canCloneCipher$(cipher: CipherLike, isAdminConsoleAction?: boolean, userId?: UserId): Observable<boolean>;
CipherService.getFullCipherView(c: CipherViewLike, userId?: UserId): Promise<CipherView>;
ViewPasswordHistoryService.viewPasswordHistory(cipher: CipherView, userId?: UserId): Promise<void>;
VaultSettingsService.showAtRiskPasswordNotificationsFor$(userId: UserId): Observable<boolean>;
```

Popup rows (`vault/popup/components/vault/`):

```html
<app-item-copy-actions [cipher]="cipher" [userId]="userId" />
<app-item-more-options [cipher]="cipher" [userId]="userId" />
```

With `[userId]` the more-options menu runs every action for that account: view, edit, clone and
assign collections open the routes above after that account's re-prompt, and favourite, archive
and delete write to its vault. A caller that acts without the menu uses the calls that already
took the account: `cipherService.updateWithServer(cipher, userId)` for the favourite,
`cipherService.softDeleteWithServer(id, userId)`, `cipherService.deleteWithServer(id, userId)`,
`cipherService.restoreWithServer(id, userId)` and
`cipherArchiveService.archiveWithServer(id, userId)`.

### How a component learns the account

Components below a host read the account from `CipherAccountContext` (`@bitwarden/vault`) instead
of the active account. The root instance always means the active account. `CipherViewComponent`,
`CipherAttachmentsComponent` and `VaultItemCopyActionsComponent` provide their own instance bound
to their `userId` input, so `appCopyField`, the attachment download and delete, the item history
and every view section below them follow it without an input of their own. The cipher form reads
`CipherFormContainer.config.userId`. A component opened through `DialogService` inherits neither;
it is given the account in its dialog data, as `PasswordRepromptComponent` is.

### What an account-scoped page does not do

- **Fill a re-prompt-protected item of another account.** The pages fill through
  `VaultPopupAutofillService.doAutofillForAccount`, which still declines such an item instead of
  asking for that account's master password with
  `PasswordRepromptService.showPasswordPrompt(userId)`.
- **Add the page's URL to the item while filling ("Autofill and save").**
  `VaultPopupAutofillService.doAutofillAndSave` saves to the active account's vault, so a page or
  menu of another account fills without offering it.
- **Share an item by link.** `@bitwarden/tools-share` creates the Send in the active account, so
  the share actions are not offered for an item of another account.
- **Offer contributed row actions (`VAULT_ROW_ACTIONS`).** An action receives the cipher without
  its account.
- **Offer the item's account an upgrade to premium.** `PremiumUpgradePromptService` and the
  premium badge open the upgrade of the active account. Premium itself is checked for the item's
  account. The more-options menu leaves the archive upgrade out for another account; the TOTP
  badge of the view and the attachments entry of the form still open the active account's
  upgrade when the item's account has no premium.
- **Use the item account's password generator.** The generator in the form uses the active
  account's options, policies and history.
- **Follow the item account's display settings.** Quick copy buttons
  (`VaultCopyButtonsService.showQuickCopyActions$`) and favicons are the popup's own, read from
  the active account.

## Conversion checklist

Each item converts one surface from the active account to the autofill accounts. Common to all:
replace `FillCipherPolicy` with `MultiAccountFillCipherPolicy`, drop the `userId` argument, carry
`AccountCipher` or `AccountCipherRef` instead of `CipherView` or a cipher id, and take every
per-account input from `accountCipher.userId`. Each conversion must leave behaviour unchanged
while no account has opted in, and adds the cases "two unlocked accounts, same URL in both", "one
of them locks while the surface is open" and "the same shared item in both accounts" to the
surface's spec.

Prerequisites in shared code, each needed before the first surface that depends on it ships:

- [x] `CipherService.filterCiphersForUrl` reads equivalent domains and the default URI match of
      the active account (`DomainSettingsService`). Make both per account, so
      `getAllDecryptedForUrl(url, userId)` matches with `userId`'s settings.
- [x] `EventCollectionService.collect` records for the active account. Give it the account.
- [x] `UserVerificationService.hasMasterPassword()` in `AutofillService.isPasswordRepromptRequired`
      reads the active account. Pass the cipher's account, and verify the reprompt popout against
      that account. The popout shows and verifies the active account's vault
      (`vault/popup/utils/vault-popout-window.ts`, `ViewComponent`), so a protected cipher of
      another autofill account makes its account the active one first ("switch, then reprompt"):
      `AutofillService.isPasswordRepromptRequired` and the context menu take a `switchAccount`
      callback, as the notification bar does. The popout then verifies that account's master
      password and fills from its vault. The cipher is refused without a popout when its account
      no longer serves autofill or the switch does not take effect. The switch is visible: the
      popup shows the cipher's account afterwards, and the account left behind keeps serving
      autofill only if it has opted in.
- [x] Sync: `MainBackground.fullSync` syncs the active account and then every other unlocked
      account; an account unlocked while not active syncs then
      (`syncAccountsUnlockedWhileNotActive`). With `processForNonActiveAccounts`, which only the
      browser sets, `default-server-notifications.service.ts` processes a non-active account's
      notifications and its sync on connect, see [Known limits](#known-limits).
      A logout found by a non-active account's sync logs out that account alone and leaves the
      active account where it is.
- [x] `AutofillSettingsService` and `DomainSettingsService` expose most settings for the active
      account only. Add per-account readers as surfaces need them, following
      `autofillOnPageLoadDefaultFor$`.

Surfaces:

- [x] **`background/autofill-orchestrator.ts`** — `selectFill`, `selectLogin`,
      `selectCipherTypeCipher`, `autoSubmitLoginOnTab` select through the multi-account policy;
      `PlannedFill` and `AutoFillOptions` carry the cipher's `userId`. `commit` denies when the
      account is no longer an autofill account. `recordActiveAccountActivity` records activity for
      the cipher's account. A request with no autofill account is abandoned as it is today with no
      active account. A page-load fill offers only the logins of accounts that have autofill on
      page load on.
- [x] **`services/autofill.service.ts`** — `doAutoFill` takes the account from its options: premium
      (`hasPremiumFromAnySource$`), `updateLastUsedDate`, event collection, TOTP, reprompt. Script
      injection (`injectAutofillScripts`) is on when any autofill account is unlocked, with
      page-load injection under the stricter-wins rule.
- [x] **`background/overlay.background.ts`** — `inlineMenuCiphers` holds `AccountCipher`; the list
      sent to the inline menu carries an account label for display, and fill, view and
      passkey messages name the cipher by `AccountCipherRef`. Cards, identities and the
      show-cards/identities settings apply per account. Add-login data goes through
      `canOfferSave` for the target account. A lock of any autofill account rebuilds the list.
      "View item" is offered only for the active account's ciphers, because the vault item view
      shows the active account's vault. The password generator and "new item" follow the save
      target; a new item for an account that is not active makes it the active one first. A
      cipher's icon comes from its own account's server.
- [x] **`services/autofill-badge-updater.service.ts`** — count `ciphersForUrl(url, Badge)` across
      accounts; recompute on `MultiAccountFillCipherPolicy.changed$` instead of the active
      account's `changed$`. The badge setting follows the stricter-wins rule: the counter shows
      only while the active account and every autofill account have it on
      (`BadgeSettingsService.enableBadgeCounterFor$`).
- [x] **`browser/cipher-context-menu-handler.ts`, `browser/context-menu-clicked-handler.ts`,
      `browser/main-context-menu-handler.ts`** — menu item ids encode `accountCipherKey`; titles
      show the account when more than one serves or the one that serves is not active; a click
      resolves through `ciphersForRefs`; "new item" follows the save target. The
      "unlock" and "no match" entries depend on the autofill accounts, not the active account.
- [x] **`background/web-request.background.ts`** (HTTP basic auth) — an automatic fill: candidates
      from all accounts, each under its own `enableBasicAuthResponse` setting and feature
      availability; with candidates from more than one account, do not answer.
- [x] **`background/auto-submit-login.background.ts`** — the approved-host policy is read per
      account; a host approved by one account's organization submits only that account's ciphers.
- [x] **`background/commands.background.ts`, `background/runtime.background.ts`,
      `background/tabs.background.ts`** — shortcuts act when any autofill account is unlocked;
      by-id fills (`ciphersForRefs`) take a reference; tab refreshes subscribe to
      `MultiAccountFillCipherPolicy.changed$`.
- [x] **`rx/account-events.ts` and the lifecycle** — monitoring starts and stops on the autofill
      accounts becoming non-empty or empty, not on the active account alone; an opportunity is
      attributed to the autofill accounts at the time it is received and retired per the rule
      under [Attributing a cipher to its account](#attributing-a-cipher-to-its-account). Update
      [autofill.design.md](./autofill.design.md) ("the transition's account must be the active
      account") and [lifecycle.design.md](./lifecycle.design.md) in the same change.
- [x] **`background/notification.background.ts`, `background/overlay-notifications.background.ts`**
      — queue messages carry the target `userId`. "Save" targets the active account by default,
      with a choice among autofill accounts; "update" targets the account that owns the matched
      cipher; a match in more than one account asks. `canOfferSave`, folders, collections,
      organizations and policies are read for the target account. At-risk password tasks
      (`SecurityTask`) are per account. "View", "edit" and a reprompt make the cipher's account
      the active one first, and are dropped when that account no longer serves autofill. The
      "login saved" confirmation of the inline menu's "Save and fill" carries the account the
      popout saved to, so its "View" follows the same rule. A bar is raised whenever an autofill
      account can take it, whatever the active account's state; the unlock prompt is left for when
      none can. The at-risk bar names the account the task belongs to.
- [x] **Passkeys: `fido2/background/fido2.background.ts`,
      `fido2/services/browser-fido2-user-interface.service.ts`, `popup/fido2/fido2.component.ts`,
      `libs/common/src/platform/services/fido2/fido2-authenticator.service.ts`** — assertion
      searches all autofill accounts and the picker returns an `AccountCipherRef`; registration
      chooses a target account, default active; excluded-credential checks cover all autofill
      accounts; user verification runs against the cipher's account. The passkey scripts are
      injected, and a request is answered without an unlock prompt (`ensureUnlockedVault`,
      `fido2AuthGuard`), while any autofill account serves. Remaining: creating a new login to
      hold a passkey is offered only while the target is the active account.
- [x] **Popup suggestions tab: `vault/popup/services/vault-popup-items.service.ts`,
      `vault/popup/services/vault-popup-autofill.service.ts`** — a section per further autofill
      account; filling uses the cipher's account; opening an item of another account switches the
      active account first. Remaining: a cipher of another account offers "fill" and "switch
      account and view item" only (no copy, edit or fill-and-save actions); a reprompt-protected
      one is opened in its account instead of filled; the list table behind the
      `VFO1Foundation` flag is not converted.
- [x] **Opt-in control: `auth/popup/account-switching/`** — a per-account toggle bound to
      `enabled$` / `setEnabled`, offered for unlocked accounts, with the risk explained where the
      choice is made.

## Known limits

What still follows the active account, or is otherwise short of the rules above.

- **View, edit and copy act on the active account's vault.** For a cipher of another autofill
  account they either make its account the active one first (popup suggestions "switch account and
  view item", the notification bar's "view" and "edit", every master password reprompt) or are not
  offered (inline menu "view item", the popup's copy and more-options actions).
- **The popup's list table (`VFO1Foundation` flag) is not converted.** It shows the active
  account's suggestions only.
- **A locked non-active account gets sync notifications only with its sync on unlock.** Sync
  notifications (vault, send, policy, organization status, collection settings, a key rotation
  logout) are processed for a non-active account while it is unlocked. Logout and premium status
  notifications are processed whatever its lock state. Bank account verifications refresh only the
  page in view, which shows the active account. `SyncService.syncInProgress` is one flag shared by
  all accounts.
- **Desktop, web and the CLI keep upstream's notification handling.** Only the browser sets
  `processForNonActiveAccounts`; elsewhere a non-active account's notifications are dropped except
  `AllowedMultiUserNotificationTypes`. Two upstream bugs follow, candidates for separate issues:
  a server-forced logout (`LogOut` other than a key rotation or KDF change) of a background
  account is dropped, so that account stays signed in and unlocked locally; and policy,
  organization status and collection-setting notifications of a background account are missed,
  and since they may not bump the account revision date, the revision-gated sync on switching to
  it may miss them too.
- **The active account still decides where it is what is meant:** the "lock vault" shortcut
  locks it; the unlock prompt is for it; the clipboard-setting notice on the badge is its own;
  with no autofill account, the page is set up from its card and identity settings, its premium
  decides whether the inline menu opens on TOTP fields, and fill assist follows its policy.
- **A locked active account's passkeys are not found while another account serves.** A passkey
  request is answered from the autofill accounts without asking to unlock, so a passkey held
  only by the locked active account is reported as not found until that account is unlocked from
  the popup. The passkey popout offers no unlock for it.
- **A new item for an account that is not active switches to it.** The item form shows the active
  account's vault, so the inline menu's and the context menu's "new item" make the save target
  the active account first (as "view", "edit" and the reprompt do) when it is not.
- **TOTP after a passkey login is copied without the premium and auto-copy checks.** The inline
  menu copies the code of a login whose passkey was just used, as upstream does for a single
  account; a regular fill copies it only for an account with premium (or an organization grant)
  and auto-copy on.
- **The overlay is built at startup or at a login.** With no active account at startup and no
  autofill account yet, it is built when an account next logs in, as before.
- **A logout of a non-active account is told only to an open popup.** The popup shows a toast
  that names the account, with the reason where there is a text for it. With the popup closed, the
  account just leaves the account switcher and stops serving autofill.
