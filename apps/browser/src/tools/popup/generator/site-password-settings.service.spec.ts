import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { SdkService } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import {
  GeneratorClient,
  PasswordGeneratorRequest,
  PasswordManagerClient,
} from "@bitwarden/sdk-internal";

import { BrowserApi } from "../../../platform/browser/browser-api";
import BrowserPopupUtils from "../../../platform/browser/browser-popup-utils";

import { SitePasswordSettingsService } from "./site-password-settings.service";

jest.mock("./password-rules/password-rules.json", () => ({
  "example.com": { "password-rules": "minlength: 8; required: [-_];" },
}));

describe("SitePasswordSettingsService", () => {
  let service: SitePasswordSettingsService;
  let generator: MockProxy<GeneratorClient>;
  let logService: MockProxy<LogService>;

  const request: PasswordGeneratorRequest = {
    lowercase: true,
    uppercase: true,
    numbers: true,
    special: false,
    length: 16,
    avoidAmbiguous: false,
    minLowercase: undefined,
    minUppercase: undefined,
    minNumber: undefined,
    minSpecial: undefined,
    customRequiredChars: "-_",
    customAllowedChars: "-_",
    maxConsecutive: undefined,
  };

  beforeEach(() => {
    generator = mock<GeneratorClient>();
    const client = mock<PasswordManagerClient>();
    client.generator.mockReturnValue(generator);
    const sdkService = mock<SdkService>();
    sdkService.client$ = new BehaviorSubject(client);
    logService = mock<LogService>();

    TestBed.configureTestingModule({
      providers: [
        SitePasswordSettingsService,
        { provide: SdkService, useValue: sdkService },
        { provide: LogService, useValue: logService },
      ],
    });
    service = TestBed.inject(SitePasswordSettingsService);

    jest.spyOn(BrowserPopupUtils, "inPopup").mockReturnValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  function onTab(url: string) {
    jest.spyOn(BrowserApi, "getTabFromCurrentWindow").mockResolvedValue({ url } as chrome.tabs.Tab);
  }

  it("parses the rules of the current tab's site", async () => {
    onTab("https://login.example.com/signup");
    generator.password_rules.mockReturnValue(request);

    const result = await service.currentTab();

    expect(generator.password_rules).toHaveBeenCalledWith("minlength: 8; required: [-_];");
    expect(result).toEqual({
      website: "example.com",
      settings: {
        length: 16,
        lowercase: true,
        minLowercase: 1,
        uppercase: true,
        minUppercase: 1,
        number: true,
        minNumber: 1,
        special: false,
        minSpecial: 0,
        customRequiredChars: "-_",
        customAllowedChars: "-_",
        maxConsecutive: undefined,
      },
    });
  });

  it("returns null when the site has no rules", async () => {
    onTab("https://example.org");

    expect(await service.currentTab()).toBeNull();
    expect(generator.password_rules).not.toHaveBeenCalled();
  });

  it("returns null outside the toolbar popup without reading the tab", async () => {
    jest.spyOn(BrowserPopupUtils, "inPopup").mockReturnValue(false);
    const getTab = jest.spyOn(BrowserApi, "getTabFromCurrentWindow");

    expect(await service.currentTab()).toBeNull();
    expect(getTab).not.toHaveBeenCalled();
  });

  it("returns null and logs when the SDK rejects the rules", async () => {
    onTab("https://example.com");
    const error = new Error("invalid rules");
    generator.password_rules.mockImplementation(() => {
      throw error;
    });

    expect(await service.currentTab()).toBeNull();
    expect(logService.error).toHaveBeenCalledWith(error);
  });
});
