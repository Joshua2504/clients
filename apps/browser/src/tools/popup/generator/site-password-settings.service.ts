import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { SdkService } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { SitePasswordSettings } from "@bitwarden/generator-components";
import { PasswordGenerationOptions } from "@bitwarden/generator-core";
import { PasswordGeneratorRequest } from "@bitwarden/sdk-internal";

import { BrowserApi } from "../../../platform/browser/browser-api";
import BrowserPopupUtils from "../../../platform/browser/browser-popup-utils";

import { findPasswordRules } from "./password-rules/password-rules";

@Injectable()
export class SitePasswordSettingsService {
  private readonly sdkService = inject(SdkService);
  private readonly logService = inject(LogService);

  /** Password settings that match the current tab's password rules, or `null` when none apply. */
  async currentTab(): Promise<SitePasswordSettings | null> {
    // only the toolbar popup closes when the user changes tabs; a pop-out, sidebar or side
    // panel would keep the rules of a site the user has left
    if (!BrowserPopupUtils.inPopup(window)) {
      return null;
    }

    try {
      const tab = await BrowserApi.getTabFromCurrentWindow();
      const match = findPasswordRules(tab?.url);
      if (!match) {
        return null;
      }

      const client = await firstValueFrom(this.sdkService.client$);
      const request = client.generator().password_rules(match.rules);
      return { website: match.domain, settings: toSettings(request) };
    } catch (e: unknown) {
      this.logService.error(e);
      return null;
    }
  }
}

function toSettings(request: PasswordGeneratorRequest): PasswordGenerationOptions {
  // the SDK puts at least one character of each enabled set in the output
  const atLeastOne = (enabled: boolean, min: number | undefined) => (enabled ? (min ?? 1) : 0);
  return {
    length: request.length,
    lowercase: request.lowercase,
    minLowercase: atLeastOne(request.lowercase, request.minLowercase),
    uppercase: request.uppercase,
    minUppercase: atLeastOne(request.uppercase, request.minUppercase),
    number: request.numbers,
    minNumber: atLeastOne(request.numbers, request.minNumber),
    special: request.special,
    minSpecial: atLeastOne(request.special, request.minSpecial),
    customRequiredChars: request.customRequiredChars,
    customAllowedChars: request.customAllowedChars,
    maxConsecutive: request.maxConsecutive,
  };
}
