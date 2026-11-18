import { Observable } from "rxjs";

import { UriMatchStrategySetting } from "@bitwarden/common/models/domain/domain-service";
import { CommandDefinition } from "@bitwarden/common/platform/messaging";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { AutofillMessageCommand } from "../../enums/autofill-message.enums";
import { InlineMenuFillType } from "../../enums/autofill-overlay.enum";
import AutofillField from "../../models/autofill-field";
import AutofillForm from "../../models/autofill-form";
import AutofillPageDetails from "../../models/autofill-page-details";
import { FillResult } from "../../types/fill-result";

export interface PageDetail {
  frameId: number;
  tab: chrome.tabs.Tab;
  details: AutofillPageDetails;
}

export interface AutoFillOptions {
  cipher: CipherView;
  /**
   * The account whose vault `cipher` was read from. Every effect of the fill runs for it: the
   * premium check, the TOTP auto-copy setting, URI matching, the last-used update and event
   * collection. See `multi-account.design.md`, "Attributing a cipher to its account".
   */
  userId: UserId;
  pageDetails: PageDetail[];
  doc?: typeof self.document;
  tab: chrome.tabs.Tab;
  skipUsernameOnlyFill?: boolean;
  onlyEmptyFields?: boolean;
  fillNewPassword?: boolean;
  skipLastUsed?: boolean;
  allowUntrustedIframe?: boolean;
  allowTotpAutofill?: boolean;
  autoSubmitLogin?: boolean;
  focusedFieldForm?: string;
  focusedFieldOpid?: string;
  inlineMenuFillType?: InlineMenuFillType;
}

interface FormDataBase {
  form: AutofillForm;
  password: AutofillField;
  passwords: AutofillField[];
}

export interface FormDataWithUsername extends FormDataBase {
  username: AutofillField;
}

export interface FormDataPasswordOnly extends FormDataBase {
  username: null;
}

export type FormData = FormDataWithUsername | FormDataPasswordOnly;

export interface GenerateFillScriptOptions {
  skipUsernameOnlyFill: boolean;
  onlyEmptyFields: boolean;
  fillNewPassword: boolean;
  allowTotpAutofill: boolean;
  autoSubmitLogin: boolean;
  cipher: CipherView;
  /** The account that owns `cipher`. Its equivalent domains apply to URI matching. */
  userId: UserId;
  /**
   * Whether the account is entitled to TOTP for this cipher. Gates filling the value only,
   * `allowTotpAutofill` gates whether TOTP fields are identified.
   */
  canAccessTotp: boolean;
  tabUrl: string;
  defaultUriMatch: UriMatchStrategySetting;
  focusedFieldOpid?: string;
  inlineMenuFillType?: InlineMenuFillType;
}

export type CollectPageDetailsResponseMessage = {
  tab: chrome.tabs.Tab;
  details: AutofillPageDetails;
  sender?: string;
};

export const COLLECT_PAGE_DETAILS_RESPONSE_COMMAND =
  new CommandDefinition<CollectPageDetailsResponseMessage>(
    AutofillMessageCommand.collectPageDetailsResponse,
  );

export abstract class AutofillService {
  enableInlineMenuAnimation$!: Observable<boolean>;
  enableNotificationAnimation$!: Observable<boolean>;
  /** Non-null asserted. */
  collectPageDetailsFromTab$!: (tab: chrome.tabs.Tab, frameId?: number) => Observable<PageDetail[]>;
  /** Non-null asserted. */
  loadAutofillScriptsOnInstall!: () => Promise<void>;
  /** Non-null asserted. */
  reloadAutofillScripts!: () => Promise<void>;
  /** Non-null asserted. */
  injectAutofillScripts!: (
    tab: chrome.tabs.Tab,
    frameId?: number,
    triggeringOnPageLoad?: boolean,
  ) => Promise<void>;
  /** Non-null asserted. */
  getFormsWithPasswordFields!: (pageDetails: AutofillPageDetails) => FormData[];
  /**
   * Fills a concrete cipher into the instructed tab/frame(s) and reports the
   * outcome. Cipher selection and active-tab verification are the caller's concern.
   *
   * If you're calling this method, you're probably doing it wrong. Use the
   * {@link AutofillOrchestrator} to request an autofill!
   */
  doAutoFill!: (options: AutoFillOptions) => Promise<FillResult>;
  /** Non-null asserted. */
  setAutoFillOnPageLoadOrgPolicy!: () => Promise<void>;
  /**
   * Whether `cipher` must be re-prompted for before it is used, judged for the account that owns
   * it. Opens the reprompt popout when it must.
   *
   * @param userId The account whose vault `cipher` was read from.
   */
  isPasswordRepromptRequired!: (
    cipher: CipherView,
    tab: chrome.tabs.Tab,
    userId: UserId,
    action?: string,
  ) => Promise<boolean>;
}
