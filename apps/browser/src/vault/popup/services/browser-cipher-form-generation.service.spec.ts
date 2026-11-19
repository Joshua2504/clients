import { Overlay } from "@angular/cdk/overlay";
import { TestBed } from "@angular/core/testing";
import { of } from "rxjs";

import { UserId } from "@bitwarden/common/types/guid";
import { DialogService } from "@bitwarden/components";

import { VaultGeneratorDialogComponent } from "../components/vault/vault-generator-dialog/vault-generator-dialog.component";

import { BrowserCipherFormGenerationService } from "./browser-cipher-form-generation.service";

describe("BrowserCipherFormGenerationService", () => {
  let service: BrowserCipherFormGenerationService;
  let openSpy: jest.SpyInstance;
  const dialogService = {} as DialogService;
  const overlay = {} as Overlay;

  beforeEach(() => {
    openSpy = jest.spyOn(VaultGeneratorDialogComponent, "open").mockReturnValue({
      closed: of({ action: "selected", generatedValue: "generated" }),
    } as any);

    TestBed.configureTestingModule({
      providers: [
        BrowserCipherFormGenerationService,
        { provide: DialogService, useValue: dialogService },
        { provide: Overlay, useValue: overlay },
      ],
    });
    service = TestBed.inject(BrowserCipherFormGenerationService);
  });

  afterEach(() => openSpy.mockRestore());

  it("opens the password generator for the active account without an account", async () => {
    expect(await service.generatePassword()).toBe("generated");

    expect(openSpy).toHaveBeenCalledWith(dialogService, overlay, { data: { type: "password" } });
  });

  it("opens the password generator for the account of the form", async () => {
    await service.generatePassword("form-account" as UserId);

    expect(openSpy).toHaveBeenCalledWith(dialogService, overlay, {
      data: { type: "password", userId: "form-account" },
    });
  });

  it("opens the username generator for the active account without an account", async () => {
    await service.generateUsername("https://example.com");

    expect(openSpy).toHaveBeenCalledWith(dialogService, overlay, {
      data: { type: "username", uri: "https://example.com" },
    });
  });

  it("opens the username generator for the account of the form", async () => {
    await service.generateUsername("https://example.com", "form-account" as UserId);

    expect(openSpy).toHaveBeenCalledWith(dialogService, overlay, {
      data: { type: "username", uri: "https://example.com", userId: "form-account" },
    });
  });
});
