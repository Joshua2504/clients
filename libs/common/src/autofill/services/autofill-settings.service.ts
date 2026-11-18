// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { combineLatest, distinctUntilChanged, map, Observable, of, switchMap } from "rxjs";

import { PolicyService } from "../../admin-console/abstractions/policy/policy.service.abstraction";
import { PolicyType } from "../../admin-console/enums";
import { AccountService } from "../../auth/abstractions/account.service";
import { getOptionalUserId, getUserId } from "../../auth/services/account.service";
import { FeatureFlag } from "../../enums/feature-flag.enum";
import { ConfigService } from "../../platform/abstractions/config/config.service";
import {
  AUTOFILL_SETTINGS_DISK,
  AUTOFILL_SETTINGS_DISK_LOCAL,
  ActiveUserState,
  GlobalState,
  KeyDefinition,
  StateProvider,
  UserKeyDefinition,
} from "../../platform/state";
import { UserId } from "../../types/guid";
import { CipherType } from "../../vault/enums";
import { RestrictedItemTypesService } from "../../vault/services/restricted-item-types.service";
import { ClearClipboardDelay, AutofillOverlayVisibility } from "../constants";
import { ClearClipboardDelaySetting, InlineMenuVisibilitySetting } from "../types";

const AUTOFILL_ON_PAGE_LOAD = new UserKeyDefinition(AUTOFILL_SETTINGS_DISK, "autofillOnPageLoad", {
  deserializer: (value: boolean) => value ?? false,
  clearOn: [],
});

const AUTOFILL_ON_PAGE_LOAD_DEFAULT = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK,
  "autofillOnPageLoadDefault",
  {
    deserializer: (value: boolean) => value ?? false,
    clearOn: [],
  },
);

const AUTOFILL_ON_PAGE_LOAD_CALLOUT_DISMISSED = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK,
  "autofillOnPageLoadCalloutIsDismissed",
  {
    deserializer: (value: boolean) => value ?? false,
    clearOn: [],
  },
);

const AUTOFILL_ON_PAGE_LOAD_POLICY_TOAST_HAS_DISPLAYED = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK,
  "autofillOnPageLoadPolicyToastHasDisplayed",
  {
    deserializer: (value: boolean) => value ?? false,
    clearOn: [],
  },
);

const AUTO_COPY_TOTP = new UserKeyDefinition(AUTOFILL_SETTINGS_DISK, "autoCopyTotp", {
  deserializer: (value: boolean) => value ?? true,
  clearOn: [],
});

const INLINE_MENU_VISIBILITY = new KeyDefinition(
  AUTOFILL_SETTINGS_DISK_LOCAL,
  "inlineMenuVisibility",
  {
    deserializer: (value: InlineMenuVisibilitySetting) => value ?? AutofillOverlayVisibility.Off,
  },
);

const SHOW_INLINE_MENU_IDENTITIES = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK,
  "showInlineMenuIdentities",
  {
    deserializer: (value: boolean) => value ?? true,
    clearOn: [],
  },
);

const SHOW_INLINE_MENU_CARDS = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK,
  "showInlineMenuCards",
  {
    deserializer: (value: boolean) => value ?? true,
    clearOn: [],
  },
);

const SHOW_INLINE_MENU_SSH_KEYS = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK,
  "showInlineMenuSshKeys",
  {
    deserializer: (value: boolean) => value ?? true,
    clearOn: [],
  },
);

const HONOR_BITWARDEN_IGNORE_ATTRIBUTE = new KeyDefinition(
  AUTOFILL_SETTINGS_DISK_LOCAL,
  "honorBitwardenIgnoreAttribute",
  {
    deserializer: (value: boolean) => value ?? false,
  },
);

const HONOR_BITWARDEN_AUTOFILL_ATTRIBUTE = new KeyDefinition(
  AUTOFILL_SETTINGS_DISK_LOCAL,
  "honorBitwardenAutofillAttribute",
  {
    deserializer: (value: boolean) => value ?? false,
  },
);

const ENABLE_BASIC_AUTH_RESPONSE = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK,
  "enableBasicAuthResponse",
  {
    deserializer: (value: boolean) => value ?? false,
    clearOn: [],
  },
);

const ENABLE_CONTEXT_MENU = new KeyDefinition(AUTOFILL_SETTINGS_DISK, "enableContextMenu", {
  deserializer: (value: boolean) => value ?? true,
});

const CLEAR_CLIPBOARD_DELAY = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK_LOCAL,
  "clearClipboardDelay",
  {
    deserializer: (value: ClearClipboardDelaySetting) => value ?? ClearClipboardDelay.FiveMinutes,
    clearOn: [],
  },
);

const HAD_PRE_MIGRATION_CLIPBOARD_VALUE = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK_LOCAL,
  "hadPreMigrationClipboardValue",
  {
    deserializer: (value: boolean) => value ?? false,
    clearOn: [],
  },
);

const CLIPBOARD_SETTING_UPDATED_NOTIFICATION_DISMISSED = new UserKeyDefinition(
  AUTOFILL_SETTINGS_DISK,
  "clipboardSettingUpdatedNotificationDismissed",
  {
    deserializer: (value: boolean) => value ?? false,
    clearOn: [],
  },
);

export abstract class AutofillSettingsServiceAbstraction {
  autofillOnPageLoad$: Observable<boolean>;
  /** {@link autofillOnPageLoad$} for `userId` instead of the active user. */
  autofillOnPageLoadFor$: (userId: UserId) => Observable<boolean>;
  setAutofillOnPageLoad: (newValue: boolean) => Promise<void>;
  /** {@link setAutofillOnPageLoad} for `userId` instead of the active user. */
  setAutofillOnPageLoadFor: (newValue: boolean, userId: UserId) => Promise<void>;
  autofillOnPageLoadDefault$: Observable<boolean>;
  /**
   * {@link autofillOnPageLoadDefault$} for `userId` instead of the active user: whether a login
   * without its own page-load setting fills on page load.
   */
  autofillOnPageLoadDefaultFor$: (userId: UserId) => Observable<boolean>;
  setAutofillOnPageLoadDefault: (newValue: boolean) => Promise<void>;
  autofillOnPageLoadCalloutIsDismissed$: Observable<boolean>;
  setAutofillOnPageLoadCalloutIsDismissed: (newValue: boolean) => Promise<void>;
  activateAutofillOnPageLoadFromPolicy$: Observable<boolean>;
  /**
   * {@link activateAutofillOnPageLoadFromPolicy$} for `userId` instead of the active user:
   * whether one of that user's organizations turns autofill on page load on.
   */
  activateAutofillOnPageLoadFromPolicyFor$: (userId: UserId) => Observable<boolean>;
  setAutofillOnPageLoadPolicyToastHasDisplayed: (newValue: boolean) => Promise<void>;
  autofillOnPageLoadPolicyToastHasDisplayed$: Observable<boolean>;
  autoCopyTotp$: Observable<boolean>;
  /** {@link autoCopyTotp$} for `userId` instead of the active user. */
  autoCopyTotpFor$: (userId: UserId) => Observable<boolean>;
  setAutoCopyTotp: (newValue: boolean) => Promise<void>;
  inlineMenuVisibility$: Observable<InlineMenuVisibilitySetting>;
  setInlineMenuVisibility: (newValue: InlineMenuVisibilitySetting) => Promise<void>;
  showInlineMenuIdentities$: Observable<boolean>;
  /** {@link showInlineMenuIdentities$} for `userId` instead of the active user. */
  showInlineMenuIdentitiesFor$: (userId: UserId) => Observable<boolean>;
  setShowInlineMenuIdentities: (newValue: boolean) => Promise<void>;
  showInlineMenuCards$: Observable<boolean>;
  /**
   * {@link showInlineMenuCards$} for `userId` instead of the active user: that user's setting,
   * off while one of that user's organizations restricts cards.
   */
  showInlineMenuCardsFor$: (userId: UserId) => Observable<boolean>;
  setShowInlineMenuCards: (newValue: boolean) => Promise<void>;
  showInlineMenuSshKeys$: Observable<boolean>;
  /**
   * {@link showInlineMenuSshKeys$} for `userId` instead of the active user: that user's setting,
   * off while one of that user's organizations restricts SSH keys.
   */
  showInlineMenuSshKeysFor$: (userId: UserId) => Observable<boolean>;
  setShowInlineMenuSshKeys: (newValue: boolean) => Promise<void>;
  honorBitwardenIgnoreAttribute$: Observable<boolean>;
  setHonorBitwardenIgnoreAttribute: (newValue: boolean) => Promise<void>;
  honorBitwardenAutofillAttribute$: Observable<boolean>;
  setHonorBitwardenAutofillAttribute: (newValue: boolean) => Promise<void>;
  /**
   * User-controlled setting for whether or not HTTP auth challenges should be
   * answered with a matching vault credential.
   */
  enableBasicAuthResponse$: Observable<boolean>;
  /** {@link enableBasicAuthResponse$} for `userId` instead of the active user. */
  enableBasicAuthResponseFor$: (userId: UserId) => Observable<boolean>;
  setEnableBasicAuthResponse: (newValue: boolean) => Promise<void>;
  /**
   * Resolved state for answering HTTP auth challenges for the active user: the
   * user setting, gated on HTTP authentication being available
   * ({@link httpAuthenticationAvailable$}).
   *
   * Emits `false` while there is no active user. Each subscription resolves the
   * setting of the user active when it subscribes, and follows later changes of
   * active user.
   */
  resolvedEnableBasicAuthResponse$: Observable<boolean>;
  /**
   * {@link resolvedEnableBasicAuthResponse$} for `userId` instead of the active user: that user's
   * setting, gated on the {@link FeatureFlag.EnableBasicAuthResponse} flag.
   */
  resolvedEnableBasicAuthResponseFor$: (userId: UserId) => Observable<boolean>;
  /**
   * Whether HTTP authentication challenges may be answered from the active user's vault, gated on
   * the {@link FeatureFlag.EnableBasicAuthResponse} flag. This reports availability only; it does
   * not make any login eligible. A login is answered when the user setting
   * ({@link resolvedEnableBasicAuthResponse$}) is on, or when the login itself has opted in; both
   * are gated on availability.
   *
   * Emits `false` while there is no active user, and follows changes of active user.
   */
  httpAuthenticationAvailable$: Observable<boolean>;
  /**
   * {@link httpAuthenticationAvailable$} for a user other than the active one: whether HTTP
   * authentication challenges may be answered from `userId`'s vault, gated on the
   * {@link FeatureFlag.EnableBasicAuthResponse} flag. It does not depend on which user is active.
   */
  httpAuthenticationAvailableFor$: (userId: UserId) => Observable<boolean>;
  enableContextMenu$: Observable<boolean>;
  setEnableContextMenu: (newValue: boolean) => Promise<void>;
  clearClipboardDelay$: Observable<ClearClipboardDelaySetting>;
  /** {@link clearClipboardDelay$} for `userId` instead of the active user. */
  clearClipboardDelayFor$: (userId: UserId) => Observable<ClearClipboardDelaySetting>;
  setClearClipboardDelay: (newValue: ClearClipboardDelaySetting) => Promise<void>;
  hadPreMigrationClipboardValue$: Observable<boolean>;
  clipboardSettingUpdatedNotificationDismissed$: Observable<boolean>;
  setClipboardSettingUpdatedNotificationDismissed: (newValue: boolean) => Promise<void>;
  showClipboardSettingUpdateNotification$: Observable<boolean>;
}

export class AutofillSettingsService implements AutofillSettingsServiceAbstraction {
  private autofillOnPageLoadState: ActiveUserState<boolean>;
  readonly autofillOnPageLoad$: Observable<boolean>;

  private autofillOnPageLoadDefaultState: ActiveUserState<boolean>;
  readonly autofillOnPageLoadDefault$: Observable<boolean>;

  private autofillOnPageLoadCalloutIsDismissedState: ActiveUserState<boolean>;
  readonly autofillOnPageLoadCalloutIsDismissed$: Observable<boolean>;

  readonly activateAutofillOnPageLoadFromPolicy$: Observable<boolean>;

  private autofillOnPageLoadPolicyToastHasDisplayedState: ActiveUserState<boolean>;
  readonly autofillOnPageLoadPolicyToastHasDisplayed$: Observable<boolean>;

  private autoCopyTotpState: ActiveUserState<boolean>;
  readonly autoCopyTotp$: Observable<boolean>;

  private inlineMenuVisibilityState: GlobalState<InlineMenuVisibilitySetting>;
  readonly inlineMenuVisibility$: Observable<InlineMenuVisibilitySetting>;

  private showInlineMenuIdentitiesState: ActiveUserState<boolean>;
  readonly showInlineMenuIdentities$: Observable<boolean>;

  private showInlineMenuCardsState: ActiveUserState<boolean>;
  readonly showInlineMenuCards$: Observable<boolean>;

  private showInlineMenuSshKeysState: ActiveUserState<boolean>;
  readonly showInlineMenuSshKeys$: Observable<boolean>;

  private honorBitwardenIgnoreAttributeState: GlobalState<boolean>;
  readonly honorBitwardenIgnoreAttribute$: Observable<boolean>;

  private honorBitwardenAutofillAttributeState: GlobalState<boolean>;
  readonly honorBitwardenAutofillAttribute$: Observable<boolean>;

  private enableBasicAuthResponseState: ActiveUserState<boolean>;
  readonly enableBasicAuthResponse$: Observable<boolean>;
  readonly resolvedEnableBasicAuthResponse$: Observable<boolean>;
  readonly httpAuthenticationAvailable$: Observable<boolean>;

  private enableContextMenuState: GlobalState<boolean>;
  readonly enableContextMenu$: Observable<boolean>;

  private clearClipboardDelayState: ActiveUserState<ClearClipboardDelaySetting>;
  readonly clearClipboardDelay$: Observable<ClearClipboardDelaySetting>;

  private hadPreMigrationClipboardValueState: ActiveUserState<boolean>;
  readonly hadPreMigrationClipboardValue$: Observable<boolean>;

  private clipboardSettingUpdatedNotificationDismissedState: ActiveUserState<boolean>;
  readonly clipboardSettingUpdatedNotificationDismissed$: Observable<boolean>;

  readonly showClipboardSettingUpdateNotification$: Observable<boolean>;

  constructor(
    private stateProvider: StateProvider,
    private policyService: PolicyService,
    private accountService: AccountService,
    private restrictedItemTypesService: RestrictedItemTypesService,
    private configService: ConfigService,
  ) {
    this.autofillOnPageLoadState = this.stateProvider.getActive(AUTOFILL_ON_PAGE_LOAD);
    this.autofillOnPageLoad$ = this.autofillOnPageLoadState.state$.pipe(map((x) => x ?? false));

    this.autofillOnPageLoadDefaultState = this.stateProvider.getActive(
      AUTOFILL_ON_PAGE_LOAD_DEFAULT,
    );
    this.autofillOnPageLoadDefault$ = this.autofillOnPageLoadDefaultState.state$.pipe(
      map((x) => x ?? true),
    );

    this.autofillOnPageLoadCalloutIsDismissedState = this.stateProvider.getActive(
      AUTOFILL_ON_PAGE_LOAD_CALLOUT_DISMISSED,
    );
    this.autofillOnPageLoadCalloutIsDismissed$ =
      this.autofillOnPageLoadCalloutIsDismissedState.state$.pipe(map((x) => x ?? false));

    this.activateAutofillOnPageLoadFromPolicy$ = this.accountService.activeAccount$.pipe(
      getUserId,
      switchMap((userId) =>
        this.policyService.policyAppliesToUser$(PolicyType.ActivateAutofill, userId),
      ),
    );

    this.autofillOnPageLoadPolicyToastHasDisplayedState = this.stateProvider.getActive(
      AUTOFILL_ON_PAGE_LOAD_POLICY_TOAST_HAS_DISPLAYED,
    );
    this.autofillOnPageLoadPolicyToastHasDisplayed$ =
      this.autofillOnPageLoadPolicyToastHasDisplayedState.state$.pipe(map((x) => x ?? false));

    this.autoCopyTotpState = this.stateProvider.getActive(AUTO_COPY_TOTP);
    this.autoCopyTotp$ = this.autoCopyTotpState.state$.pipe(map((x) => x ?? true));

    this.inlineMenuVisibilityState = this.stateProvider.getGlobal(INLINE_MENU_VISIBILITY);
    this.inlineMenuVisibility$ = this.inlineMenuVisibilityState.state$.pipe(
      map((x) => x ?? AutofillOverlayVisibility.Off),
    );

    this.showInlineMenuIdentitiesState = this.stateProvider.getActive(SHOW_INLINE_MENU_IDENTITIES);
    this.showInlineMenuIdentities$ = this.showInlineMenuIdentitiesState.state$.pipe(
      map((x) => x ?? true),
    );

    this.showInlineMenuCardsState = this.stateProvider.getActive(SHOW_INLINE_MENU_CARDS);
    this.showInlineMenuCards$ = combineLatest([
      this.showInlineMenuCardsState.state$.pipe(map((x) => x ?? true)),
      this.restrictedItemTypesService.restricted$,
    ]).pipe(
      map(
        ([enabled, restrictions]) =>
          // If enabled, show cards inline menu unless card type is restricted
          enabled && !restrictions.some((r) => r.cipherType === CipherType.Card),
      ),
    );

    this.showInlineMenuSshKeysState = this.stateProvider.getActive(SHOW_INLINE_MENU_SSH_KEYS);
    this.showInlineMenuSshKeys$ = combineLatest([
      this.showInlineMenuSshKeysState.state$.pipe(map((x) => x ?? true)),
      this.restrictedItemTypesService.restricted$,
    ]).pipe(
      map(
        ([enabled, restrictions]) =>
          // If enabled, show SSH keys inline menu unless the SSH key type is restricted
          enabled && !restrictions.some((r) => r.cipherType === CipherType.SshKey),
      ),
    );

    this.honorBitwardenIgnoreAttributeState = this.stateProvider.getGlobal(
      HONOR_BITWARDEN_IGNORE_ATTRIBUTE,
    );
    this.honorBitwardenIgnoreAttribute$ = this.honorBitwardenIgnoreAttributeState.state$.pipe(
      map((x) => x ?? false),
    );

    this.honorBitwardenAutofillAttributeState = this.stateProvider.getGlobal(
      HONOR_BITWARDEN_AUTOFILL_ATTRIBUTE,
    );
    this.honorBitwardenAutofillAttribute$ = this.honorBitwardenAutofillAttributeState.state$.pipe(
      map((x) => x ?? false),
    );

    this.enableBasicAuthResponseState = this.stateProvider.getActive(ENABLE_BASIC_AUTH_RESPONSE);
    this.enableBasicAuthResponse$ = this.enableBasicAuthResponseState.state$.pipe(
      map((x) => x ?? false),
    );

    // The active user is resolved here rather than through `enableBasicAuthResponseState`,
    // and the result is not shared, so that each subscription reads the setting of the user
    // active at subscription time. A shared replay would hand a new subscriber the previous
    // user's value until the newly active user's setting has been read from storage.
    this.resolvedEnableBasicAuthResponse$ = this.accountService.activeAccount$.pipe(
      getOptionalUserId,
      switchMap((userId) =>
        userId == null ? of(false) : this.resolvedEnableBasicAuthResponseFor$(userId),
      ),
      distinctUntilChanged(),
    );

    this.httpAuthenticationAvailable$ = this.accountService.activeAccount$.pipe(
      getOptionalUserId,
      switchMap((userId) =>
        userId == null ? of(false) : this.httpAuthenticationFeatureEnabled$(),
      ),
      distinctUntilChanged(),
    );

    this.enableContextMenuState = this.stateProvider.getGlobal(ENABLE_CONTEXT_MENU);
    this.enableContextMenu$ = this.enableContextMenuState.state$.pipe(map((x) => x ?? true));

    this.clearClipboardDelayState = this.stateProvider.getActive(CLEAR_CLIPBOARD_DELAY);
    this.clearClipboardDelay$ = this.clearClipboardDelayState.state$.pipe(
      map((x) => x ?? ClearClipboardDelay.FiveMinutes),
    );

    this.hadPreMigrationClipboardValueState = this.stateProvider.getActive(
      HAD_PRE_MIGRATION_CLIPBOARD_VALUE,
    );
    this.hadPreMigrationClipboardValue$ = this.hadPreMigrationClipboardValueState.state$.pipe(
      map((x) => x ?? false),
    );

    this.clipboardSettingUpdatedNotificationDismissedState = this.stateProvider.getActive(
      CLIPBOARD_SETTING_UPDATED_NOTIFICATION_DISMISSED,
    );
    this.clipboardSettingUpdatedNotificationDismissed$ =
      this.clipboardSettingUpdatedNotificationDismissedState.state$.pipe(map((x) => x ?? false));

    // Observable that determines if notification should be shown
    // Shows notification if:
    // 1. User went through migration with null/Never value (hadPreMigrationValue is true)
    // 2. Notification hasn't been dismissed
    this.showClipboardSettingUpdateNotification$ = combineLatest([
      this.hadPreMigrationClipboardValue$,
      this.clipboardSettingUpdatedNotificationDismissed$,
    ]).pipe(
      map(([hadPreMigrationValue, dismissed]) => {
        return hadPreMigrationValue && !dismissed;
      }),
    );
  }

  autofillOnPageLoadFor$(userId: UserId): Observable<boolean> {
    return this.stateProvider
      .getUser(userId, AUTOFILL_ON_PAGE_LOAD)
      .state$.pipe(map((x) => x ?? false));
  }

  async setAutofillOnPageLoad(newValue: boolean): Promise<void> {
    await this.autofillOnPageLoadState.update(() => newValue);
  }

  async setAutofillOnPageLoadFor(newValue: boolean, userId: UserId): Promise<void> {
    await this.stateProvider.getUser(userId, AUTOFILL_ON_PAGE_LOAD).update(() => newValue);
  }

  activateAutofillOnPageLoadFromPolicyFor$(userId: UserId): Observable<boolean> {
    return this.policyService.policyAppliesToUser$(PolicyType.ActivateAutofill, userId);
  }

  autofillOnPageLoadDefaultFor$(userId: UserId): Observable<boolean> {
    return this.stateProvider
      .getUser(userId, AUTOFILL_ON_PAGE_LOAD_DEFAULT)
      .state$.pipe(map((x) => x ?? true));
  }

  async setAutofillOnPageLoadDefault(newValue: boolean): Promise<void> {
    await this.autofillOnPageLoadDefaultState.update(() => newValue);
  }

  async setAutofillOnPageLoadCalloutIsDismissed(newValue: boolean): Promise<void> {
    await this.autofillOnPageLoadCalloutIsDismissedState.update(() => newValue);
  }

  async setAutofillOnPageLoadPolicyToastHasDisplayed(newValue: boolean): Promise<void> {
    await this.autofillOnPageLoadPolicyToastHasDisplayedState.update(() => newValue);
  }

  autoCopyTotpFor$(userId: UserId): Observable<boolean> {
    return this.stateProvider.getUser(userId, AUTO_COPY_TOTP).state$.pipe(map((x) => x ?? true));
  }

  async setAutoCopyTotp(newValue: boolean): Promise<void> {
    await this.autoCopyTotpState.update(() => newValue);
  }

  async setInlineMenuVisibility(newValue: InlineMenuVisibilitySetting): Promise<void> {
    await this.inlineMenuVisibilityState.update(() => newValue);
  }

  showInlineMenuIdentitiesFor$(userId: UserId): Observable<boolean> {
    return this.stateProvider
      .getUser(userId, SHOW_INLINE_MENU_IDENTITIES)
      .state$.pipe(map((x) => x ?? true));
  }

  async setShowInlineMenuIdentities(newValue: boolean): Promise<void> {
    await this.showInlineMenuIdentitiesState.update(() => newValue);
  }

  showInlineMenuCardsFor$(userId: UserId): Observable<boolean> {
    return this.showInlineMenuTypeFor$(userId, SHOW_INLINE_MENU_CARDS, CipherType.Card);
  }

  showInlineMenuSshKeysFor$(userId: UserId): Observable<boolean> {
    return this.showInlineMenuTypeFor$(userId, SHOW_INLINE_MENU_SSH_KEYS, CipherType.SshKey);
  }

  /** The user's setting for a cipher type in the inline menu, off while that type is restricted. */
  private showInlineMenuTypeFor$(
    userId: UserId,
    setting: UserKeyDefinition<boolean>,
    cipherType: CipherType,
  ): Observable<boolean> {
    return combineLatest([
      this.stateProvider.getUser(userId, setting).state$.pipe(map((x) => x ?? true)),
      this.restrictedItemTypesService.restrictedFor$(userId),
    ]).pipe(
      map(
        ([enabled, restrictions]) =>
          enabled && !restrictions.some((r) => r.cipherType === cipherType),
      ),
    );
  }

  async setShowInlineMenuCards(newValue: boolean): Promise<void> {
    await this.showInlineMenuCardsState.update(() => newValue);
  }

  async setShowInlineMenuSshKeys(newValue: boolean): Promise<void> {
    await this.showInlineMenuSshKeysState.update(() => newValue);
  }

  async setHonorBitwardenIgnoreAttribute(newValue: boolean): Promise<void> {
    await this.honorBitwardenIgnoreAttributeState.update(() => newValue);
  }

  async setHonorBitwardenAutofillAttribute(newValue: boolean): Promise<void> {
    await this.honorBitwardenAutofillAttributeState.update(() => newValue);
  }

  /**
   * Whether the {@link FeatureFlag.EnableBasicAuthResponse} flag is on. Both the user setting
   * ({@link resolvedEnableBasicAuthResponse$}) and logins' own settings are gated on this.
   */
  private httpAuthenticationFeatureEnabled$(): Observable<boolean> {
    return this.configService
      .getFeatureFlag$(FeatureFlag.EnableBasicAuthResponse)
      .pipe(map((featureFlag) => featureFlag === true));
  }

  enableBasicAuthResponseFor$(userId: UserId): Observable<boolean> {
    return this.stateProvider
      .getUser(userId, ENABLE_BASIC_AUTH_RESPONSE)
      .state$.pipe(map((x) => x ?? false));
  }

  resolvedEnableBasicAuthResponseFor$(userId: UserId): Observable<boolean> {
    return combineLatest([
      this.stateProvider.getUser(userId, ENABLE_BASIC_AUTH_RESPONSE).state$,
      this.httpAuthenticationFeatureEnabled$(),
    ]).pipe(map(([userSetting, available]) => available && userSetting === true));
  }

  httpAuthenticationAvailableFor$(_userId: UserId): Observable<boolean> {
    return this.httpAuthenticationFeatureEnabled$();
  }

  async setEnableBasicAuthResponse(newValue: boolean): Promise<void> {
    await this.enableBasicAuthResponseState.update(() => newValue);
  }

  async setEnableContextMenu(newValue: boolean): Promise<void> {
    await this.enableContextMenuState.update(() => newValue);
  }

  clearClipboardDelayFor$(userId: UserId): Observable<ClearClipboardDelaySetting> {
    return this.stateProvider
      .getUser(userId, CLEAR_CLIPBOARD_DELAY)
      .state$.pipe(map((x) => x ?? ClearClipboardDelay.FiveMinutes));
  }

  async setClearClipboardDelay(newValue: ClearClipboardDelaySetting): Promise<void> {
    await this.clearClipboardDelayState.update(() => newValue);
  }

  async setClipboardSettingUpdatedNotificationDismissed(newValue: boolean): Promise<void> {
    await this.clipboardSettingUpdatedNotificationDismissedState.update(() => newValue);
  }
}
