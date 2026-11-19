import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { firstValueFrom, of, throwError } from "rxjs";

import { CollectionService } from "@bitwarden/admin-console/common";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { PolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { Organization } from "@bitwarden/common/admin-console/models/domain/organization";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { BillingAccountProfileStateService } from "@bitwarden/common/billing/abstractions/account/billing-account-profile-state.service";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import {
  Environment,
  EnvironmentService,
} from "@bitwarden/common/platform/abstractions/environment.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { SendView } from "@bitwarden/common/tools/send/models/view/send.view";
import { SendApiService } from "@bitwarden/common/tools/send/services/send-api.service";
import { SendService } from "@bitwarden/common/tools/send/services/send.service.abstraction";
import { SendType } from "@bitwarden/common/tools/send/types/send-type";
import { OrganizationId, CipherId, UserId } from "@bitwarden/common/types/guid";
import { FolderService } from "@bitwarden/common/vault/abstractions/folder/folder.service.abstraction";
import { RevealedCipherService } from "@bitwarden/common/vault/abstractions/revealed-cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { ShareLinkService } from "./share-link.service";

const organizationId = "org-1" as OrganizationId;

function cipher(overrides: Partial<CipherView> = {}): CipherView {
  return Object.assign(new CipherView(), {
    id: "cipher-1",
    name: "Item",
    type: CipherType.Login,
    collectionIds: [],
    ...overrides,
  });
}

describe("ShareLinkService", () => {
  let organizationService: MockProxy<OrganizationService>;
  let revealedCipherService: MockProxy<RevealedCipherService>;
  let billingAccountProfileStateService: MockProxy<BillingAccountProfileStateService>;
  let policyService: MockProxy<PolicyService>;
  let collectionService: MockProxy<CollectionService>;
  let environmentService: MockProxy<EnvironmentService>;
  let sendApiService: MockProxy<SendApiService>;
  let sendService: MockProxy<SendService>;
  let folderService: MockProxy<FolderService>;
  let service: ShareLinkService;

  const activeUserId = "user-1" as UserId;
  const otherUserId = "user-2" as UserId;

  const environment = (sendUrl: string) => ({ getSendUrl: () => sendUrl }) as Environment;

  /** An item Send that shares `cipherId`, as the form's link list reads it. */
  function itemSend(id: string, cipherId: string): SendView {
    return Object.assign(new SendView(), {
      id,
      accessId: `access-${id}`,
      type: SendType.Item,
      key: new Uint8Array([1, 2, 3]),
      emails: ["a@example.com"],
      deletionDate: new Date("2030-01-01T00:00:00.000Z"),
      data: { data: { id: cipherId } },
    });
  }

  beforeEach(() => {
    const accountService = mock<AccountService>();
    accountService.activeAccount$ = of({ id: "user-1" } as Account);

    const configService = mock<ConfigService>();
    configService.getFeatureFlag$.mockReturnValue(of(true));

    billingAccountProfileStateService = mock<BillingAccountProfileStateService>();
    billingAccountProfileStateService.hasPremiumFromAnySource$.mockReturnValue(of(true));

    organizationService = mock<OrganizationService>();
    organizationService.organizations$.mockReturnValue(of([]));

    policyService = mock<PolicyService>();
    policyService.policiesByType$.mockReturnValue(of([]));

    collectionService = mock<CollectionService>();
    collectionService.decryptedCollections$.mockReturnValue(of([]));

    revealedCipherService = mock<RevealedCipherService>();
    revealedCipherService.revealed$.mockReturnValue(of(new Map()));

    environmentService = mock<EnvironmentService>();
    environmentService.environment$ = of(environment("https://active.example/#/send/"));
    environmentService.getEnvironment$.mockImplementation((userId) =>
      userId === otherUserId
        ? of(environment("https://other.example/#/send/"))
        : throwError(() => new Error("environment read for the wrong account")),
    );

    sendApiService = mock<SendApiService>();
    sendApiService.mutateSend.mockResolvedValue({
      id: "send-1",
      accessId: "access-1",
      key: "a2V5",
    } as never);

    sendService = mock<SendService>();
    sendService.sendViews$ = of([itemSend("active-send", "cipher-1")]);
    sendService.sendViewsFor$.mockImplementation((userId) =>
      userId === otherUserId
        ? of([itemSend("other-send", "cipher-1"), itemSend("unrelated", "cipher-2")])
        : throwError(() => new Error("sends read for the wrong account")),
    );

    folderService = mock<FolderService>();
    folderService.getDecrypted$.mockReturnValue(of({ name: "Folder" } as never));

    const i18nService = mock<I18nService>();
    i18nService.t.mockImplementation((key) => key);

    TestBed.configureTestingModule({
      providers: [
        ShareLinkService,
        { provide: AccountService, useValue: accountService },
        { provide: BillingAccountProfileStateService, useValue: billingAccountProfileStateService },
        { provide: CollectionService, useValue: collectionService },
        { provide: ConfigService, useValue: configService },
        { provide: EnvironmentService, useValue: environmentService },
        { provide: I18nService, useValue: i18nService },
        { provide: OrganizationService, useValue: organizationService },
        { provide: PolicyService, useValue: policyService },
        { provide: SendApiService, useValue: sendApiService },
        { provide: RevealedCipherService, useValue: revealedCipherService },
        { provide: SendService, useValue: sendService },
        { provide: FolderService, useValue: folderService },
      ],
    });

    service = TestBed.inject(ShareLinkService);
  });

  describe("cipherCanBeShared$", () => {
    it("allows an ordinary item", async () => {
      expect(await firstValueFrom(service.cipherCanBeShared$(cipher()))).toBe(true);
    });

    it("refuses a restricted item, which is read-only", async () => {
      expect(await firstValueFrom(service.cipherCanBeShared$(cipher({ partial: true })))).toBe(
        false,
      );
    });

    it("refuses a restricted item even where the user can edit every organization item", async () => {
      organizationService.organizations$.mockReturnValue(
        of([{ id: organizationId, canEditAllCiphers: true } as Organization]),
      );

      expect(
        await firstValueFrom(service.cipherCanBeShared$(cipher({ organizationId, partial: true }))),
      ).toBe(false);
    });

    it("refuses a restricted item while its full view is revealed", async () => {
      const revealedView = cipher();
      revealedCipherService.revealed$.mockReturnValue(
        of(new Map([[revealedView.id as CipherId, revealedView]])),
      );

      expect(await firstValueFrom(service.cipherCanBeShared$(revealedView))).toBe(false);
    });
  });

  describe("cipherCanBeShared$ for an account other than the active one", () => {
    it("reads premium, organizations, policies, collections and reveals of that account alone", async () => {
      await firstValueFrom(service.cipherCanBeShared$(cipher(), otherUserId));

      expect(billingAccountProfileStateService.hasPremiumFromAnySource$).toHaveBeenCalledWith(
        otherUserId,
      );
      expect(organizationService.organizations$).toHaveBeenCalledWith(otherUserId);
      expect(policyService.policiesByType$).toHaveBeenCalledWith(expect.anything(), otherUserId);
      expect(collectionService.decryptedCollections$).toHaveBeenCalledWith(otherUserId);
      expect(revealedCipherService.revealed$).toHaveBeenCalledWith(otherUserId);

      expect(billingAccountProfileStateService.hasPremiumFromAnySource$).not.toHaveBeenCalledWith(
        activeUserId,
      );
      expect(organizationService.organizations$).not.toHaveBeenCalledWith(activeUserId);
      expect(policyService.policiesByType$).not.toHaveBeenCalledWith(
        expect.anything(),
        activeUserId,
      );
      expect(collectionService.decryptedCollections$).not.toHaveBeenCalledWith(activeUserId);
      expect(revealedCipherService.revealed$).not.toHaveBeenCalledWith(activeUserId);
    });

    it("refuses when that account has no premium although the active account has", async () => {
      billingAccountProfileStateService.hasPremiumFromAnySource$.mockImplementation((userId) =>
        of(userId === activeUserId),
      );

      expect(await firstValueFrom(service.cipherCanBeShared$(cipher(), otherUserId))).toBe(false);
      expect(await firstValueFrom(service.cipherCanBeShared$(cipher()))).toBe(true);
    });

    it("refuses when that account's policy disables Send although the active account's does not", async () => {
      policyService.policiesByType$.mockImplementation((_, userId) =>
        of(userId === otherUserId ? [{ data: { disableSend: true } } as never] : []),
      );

      expect(await firstValueFrom(service.cipherCanBeShared$(cipher(), otherUserId))).toBe(false);
      expect(await firstValueFrom(service.cipherCanBeShared$(cipher()))).toBe(true);
    });
  });

  describe("createShareLink", () => {
    const shared = () =>
      cipher({
        folderId: "folder-1",
        collectionIds: ["collection-1"] as never,
        organizationId,
        creationDate: new Date("2024-01-01T00:00:00.000Z"),
        revisionDate: new Date("2024-01-02T00:00:00.000Z"),
      });

    it("creates the Send in the active account without an account", async () => {
      const link = await service.createShareLink(shared(), ["a@example.com"], 1, false);

      expect(sendApiService.mutateSend).toHaveBeenCalledWith(
        expect.any(SendView),
        activeUserId,
        null,
      );
      expect(sendApiService.refreshAfterMutation).toHaveBeenCalledWith("send-1", undefined);
      expect(folderService.getDecrypted$).toHaveBeenCalledWith("folder-1", activeUserId);
      expect(environmentService.getEnvironment$).not.toHaveBeenCalled();
      expect(link).toMatch(/^https:\/\/active\.example\/#\/send\/access-1\//);
    });

    it("creates the Send in the item's account, with its names and its server's link", async () => {
      const link = await service.createShareLink(
        shared(),
        ["a@example.com"],
        1,
        false,
        otherUserId,
      );

      expect(sendApiService.mutateSend).toHaveBeenCalledTimes(1);
      expect(sendApiService.mutateSend).toHaveBeenCalledWith(
        expect.any(SendView),
        otherUserId,
        null,
      );
      expect(sendApiService.refreshAfterMutation).toHaveBeenCalledWith("send-1", otherUserId);
      expect(folderService.getDecrypted$).toHaveBeenCalledWith("folder-1", otherUserId);
      expect(collectionService.decryptedCollections$).toHaveBeenCalledWith(otherUserId);
      expect(organizationService.organizations$).toHaveBeenCalledWith(otherUserId);
      expect(link).toMatch(/^https:\/\/other\.example\/#\/send\/access-1\//);

      expect(folderService.getDecrypted$).not.toHaveBeenCalledWith("folder-1", activeUserId);
      expect(collectionService.decryptedCollections$).not.toHaveBeenCalledWith(activeUserId);
      expect(organizationService.organizations$).not.toHaveBeenCalledWith(activeUserId);
    });
  });

  describe("links$ and deleteLink", () => {
    it("lists and deletes the active account's links without an account", async () => {
      service.setCipher("cipher-1" as CipherId);

      const links = await firstValueFrom(service.links$);
      expect(links.map((link) => link.sendId)).toEqual(["active-send"]);
      expect(links[0].url).toMatch(/^https:\/\/active\.example\//);
      expect(sendService.sendViewsFor$).not.toHaveBeenCalled();

      await service.deleteLink("active-send");

      expect(sendApiService.delete).toHaveBeenCalledWith("active-send");
    });

    it("lists the links of the item's account, on its server", async () => {
      service.setCipher("cipher-1" as CipherId, otherUserId);

      const links = await firstValueFrom(service.links$);

      expect(sendService.sendViewsFor$).toHaveBeenCalledWith(otherUserId);
      expect(links.map((link) => link.sendId)).toEqual(["other-send"]);
      expect(links[0].url).toMatch(/^https:\/\/other\.example\//);
    });

    it("deletes a link in the item's account", async () => {
      service.setCipher("cipher-1" as CipherId, otherUserId);

      await service.deleteLink("other-send");

      expect(sendApiService.delete).toHaveBeenCalledTimes(1);
      expect(sendApiService.delete).toHaveBeenCalledWith("other-send", otherUserId);
    });

    it("does not delete a link of the active account through another account's form", async () => {
      service.setCipher("cipher-1" as CipherId, otherUserId);

      await service.deleteLink("active-send");

      expect(sendApiService.delete).not.toHaveBeenCalled();
    });
  });
});
