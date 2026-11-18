import { Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { BillingAccountProfileStateService } from "@bitwarden/common/billing/abstractions/account/billing-account-profile-state.service";
import { EventCollectionService, EventType } from "@bitwarden/common/dirt/event-logs";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { uuidAsString } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { UserId } from "@bitwarden/common/types/guid";
import { TotpService } from "@bitwarden/common/vault/abstractions/totp.service";
import { CipherRepromptType } from "@bitwarden/common/vault/enums";
import {
  CipherViewLike,
  CipherViewLikeUtils,
} from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { ToastService } from "@bitwarden/components";

import { PasswordRepromptService } from "./password-reprompt.service";

/**
 * The types of fields that can be copied from a cipher.
 */
export type CopyAction =
  | "username"
  | "password"
  | "totp"
  | "cardNumber"
  | "securityCode"
  | "email"
  | "phone"
  | "address"
  | "secureNote"
  | "hiddenField"
  | "privateKey"
  | "publicKey"
  | "keyFingerprint"
  | "nameOnAccount"
  | "accountNumber"
  | "routingNumber"
  | "branchNumber"
  | "pin"
  | "iban"
  | "swiftCode"
  | "firstNameLicense"
  | "middleNameLicense"
  | "lastNameLicense"
  | "licenseNumber"
  | "passportNumber"
  | "nationalIdentificationNumber"
  | "givenName"
  | "surname";

/**
 * Copy actions that can be used with the appCopyField directive.
 * Excludes "hiddenField" which requires special handling.
 */
export type CopyFieldAction = Exclude<CopyAction, "hiddenField">;

type CopyActionInfo = {
  /**
   * The i18n key for the type of field being copied. Will be used to display a toast message.
   */
  typeI18nKey: string;

  /**
   * Whether the field is protected and requires password re-prompting before being copied.
   */
  protected: boolean;

  /**
   * Optional event to collect when the field is copied.
   */
  event?: EventType;
};

const CopyActions: Record<CopyAction, CopyActionInfo> = {
  username: { typeI18nKey: "username", protected: false },
  password: {
    typeI18nKey: "password",
    protected: true,
    event: EventType.Cipher_ClientCopiedPassword,
  },
  totp: { typeI18nKey: "verificationCode", protected: true },
  cardNumber: { typeI18nKey: "number", protected: true },
  securityCode: {
    typeI18nKey: "securityCode",
    protected: true,
    event: EventType.Cipher_ClientCopiedCardCode,
  },
  email: { typeI18nKey: "email", protected: true },
  phone: { typeI18nKey: "phone", protected: true },
  address: { typeI18nKey: "address", protected: true },
  secureNote: { typeI18nKey: "typeSecureNote", protected: true },
  privateKey: { typeI18nKey: "sshPrivateKey", protected: true },
  publicKey: { typeI18nKey: "sshPublicKey", protected: true },
  keyFingerprint: { typeI18nKey: "sshFingerprint", protected: true },
  nameOnAccount: { typeI18nKey: "nameOnAccount", protected: false },
  accountNumber: {
    typeI18nKey: "accountNumber",
    protected: true,
    event: EventType.Cipher_ClientCopiedBankAccountNumber,
  },
  routingNumber: { typeI18nKey: "bankRoutingNumber", protected: false },
  branchNumber: { typeI18nKey: "branchNumber", protected: false },
  pin: { typeI18nKey: "pin", protected: true, event: EventType.Cipher_ClientCopiedBankAccountPin },
  iban: { typeI18nKey: "iban", protected: true, event: EventType.Cipher_ClientCopiedIban },
  swiftCode: {
    typeI18nKey: "swiftCode",
    protected: true,
    event: EventType.Cipher_ClientCopiedSwiftCode,
  },
  firstNameLicense: { typeI18nKey: "firstName", protected: false },
  middleNameLicense: { typeI18nKey: "middleName", protected: false },
  lastNameLicense: { typeI18nKey: "lastName", protected: false },
  licenseNumber: {
    typeI18nKey: "licenseNumber",
    protected: true,
    event: EventType.Cipher_ClientCopiedLicenseNumber,
  },
  passportNumber: {
    typeI18nKey: "passportNumber",
    protected: true,
    event: EventType.Cipher_ClientCopiedPassportNumber,
  },
  nationalIdentificationNumber: {
    typeI18nKey: "nationalIdentificationNumber",
    protected: true,
    event: EventType.Cipher_ClientCopiedNationalIdentificationNumber,
  },
  givenName: { typeI18nKey: "firstName", protected: false },
  surname: { typeI18nKey: "lastName", protected: false },
  hiddenField: {
    typeI18nKey: "value",
    protected: true,
    event: EventType.Cipher_ClientCopiedHiddenField,
  },
};

@Injectable({
  providedIn: "root",
})
export class CopyCipherFieldService {
  constructor(
    private platformUtilsService: PlatformUtilsService,
    private toastService: ToastService,
    private eventCollectionService: EventCollectionService,
    private passwordRepromptService: PasswordRepromptService,
    private totpService: TotpService,
    private i18nService: I18nService,
    private billingAccountProfileStateService: BillingAccountProfileStateService,
    private accountService: AccountService,
  ) {}

  /**
   * Copy a field value from a cipher to the clipboard.
   * @param valueToCopy The value to copy.
   * @param actionType The type of field being copied.
   * @param cipher The cipher containing the field to copy.
   * @param skipReprompt Whether to skip password re-prompting.
   * @param userId The account whose vault holds `cipher`. The re-prompt, the TOTP premium check
   * and the collected event are that account's. Defaults to the active account.
   *
   * @returns Whether the field was copied successfully.
   */
  async copy(
    valueToCopy: string,
    actionType: CopyAction,
    cipher: CipherViewLike,
    skipReprompt: boolean = false,
    userId?: UserId,
  ): Promise<boolean> {
    // Ciphers saved with empty strings can still report the field as copyable,
    // so avoid prompting, copying, and showing a success toast when there is nothing to copy.
    if (!valueToCopy) {
      return false;
    }

    const action = CopyActions[actionType];
    if (
      !skipReprompt &&
      cipher.reprompt !== CipherRepromptType.None &&
      action.protected &&
      !(await this.passwordRepromptService.showPasswordPrompt(userId))
    ) {
      return false;
    }

    if (actionType === "totp") {
      if (!(await this.totpAllowed(cipher, userId))) {
        return false;
      }
      const totpResponse = await firstValueFrom(this.totpService.getCode$(valueToCopy));
      if (!totpResponse?.code) {
        return false;
      }
      valueToCopy = totpResponse.code;
    }

    this.platformUtilsService.copyToClipboard(valueToCopy);
    this.toastService.showToast({
      variant: "success",
      message: this.i18nService.t("valueCopied", this.i18nService.t(action.typeI18nKey)),
      title: "",
    });

    if (action.event !== undefined) {
      await this.eventCollectionService.collect(
        action.event,
        cipher.id ? uuidAsString(cipher.id) : undefined,
        false,
        cipher.organizationId ? uuidAsString(cipher.organizationId) : undefined,
        userId,
      );
    }

    return true;
  }

  /**
   * Determines if TOTP generation is allowed for a cipher and user.
   * @param cipher The cipher that holds the TOTP key.
   * @param userId The account whose vault holds `cipher`. Defaults to the active account.
   */
  async totpAllowed(cipher: CipherViewLike, userId?: UserId): Promise<boolean> {
    const accountId = userId ?? (await firstValueFrom(this.accountService.activeAccount$))?.id;
    if (!accountId) {
      return false;
    }

    const login = CipherViewLikeUtils.getLogin(cipher);

    return (
      !!login?.totp &&
      (cipher.organizationUseTotp ||
        (await firstValueFrom(
          this.billingAccountProfileStateService.hasPremiumFromAnySource$(accountId),
        )))
    );
  }
}
