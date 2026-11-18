import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { of } from "rxjs";

// eslint-disable-next-line no-restricted-imports
import { CollectionService } from "@bitwarden/admin-console/common";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { PolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { PolicyType } from "@bitwarden/common/admin-console/enums";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { mockAccountServiceWith } from "@bitwarden/common/spec";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { FolderService } from "@bitwarden/common/vault/abstractions/folder/folder.service.abstraction";
import { CipherType } from "@bitwarden/common/vault/enums";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";

import { DefaultCipherFormConfigService } from "./default-cipher-form-config.service";

describe("DefaultCipherFormConfigService", () => {
  const activeUserId = "active-user-id" as UserId;
  const otherUserId = "other-user-id" as UserId;
  const cipherId = "cipher-id" as CipherId;

  let service: DefaultCipherFormConfigService;
  let policyService: MockProxy<PolicyService>;
  let organizationService: MockProxy<OrganizationService>;
  let cipherService: MockProxy<CipherService>;
  let folderService: MockProxy<FolderService>;
  let collectionService: MockProxy<CollectionService>;

  /** Every account the vault was read for. */
  const accountsRead = () =>
    [
      organizationService.organizations$,
      collectionService.encryptedCollections$,
      collectionService.decryptedCollections$,
      folderService.folders$,
      folderService.folderViews$,
      policyService.policyAppliesToUser$,
      cipherService.get,
    ].flatMap((fn) =>
      (fn as jest.Mock).mock.calls.flatMap((args: unknown[]) =>
        args.filter((arg) => arg === activeUserId || arg === otherUserId),
      ),
    );

  beforeEach(() => {
    policyService = mock<PolicyService>();
    organizationService = mock<OrganizationService>();
    cipherService = mock<CipherService>();
    folderService = mock<FolderService>();
    collectionService = mock<CollectionService>();

    policyService.policyAppliesToUser$.mockReturnValue(of(false));
    organizationService.organizations$.mockReturnValue(of([]));
    collectionService.encryptedCollections$.mockReturnValue(of([]));
    collectionService.decryptedCollections$.mockReturnValue(of([]));
    folderService.folders$.mockReturnValue(of([]));
    folderService.folderViews$.mockReturnValue(of([]));
    cipherService.get.mockResolvedValue(Object.assign(new Cipher(), { type: CipherType.Card }));

    TestBed.configureTestingModule({
      providers: [
        { provide: PolicyService, useValue: policyService },
        { provide: OrganizationService, useValue: organizationService },
        { provide: CipherService, useValue: cipherService },
        { provide: FolderService, useValue: folderService },
        { provide: CollectionService, useValue: collectionService },
        { provide: AccountService, useValue: mockAccountServiceWith(activeUserId) },
        DefaultCipherFormConfigService,
      ],
    });

    service = TestBed.inject(DefaultCipherFormConfigService);
  });

  it("builds the config from the vault of the given account", async () => {
    const config = await service.buildConfig("edit", cipherId, undefined, otherUserId);

    expect(cipherService.get).toHaveBeenCalledWith(cipherId, otherUserId);
    expect(organizationService.organizations$).toHaveBeenCalledWith(otherUserId);
    expect(collectionService.decryptedCollections$).toHaveBeenCalledWith(otherUserId);
    expect(folderService.folderViews$).toHaveBeenCalledWith(otherUserId);
    expect(policyService.policyAppliesToUser$).toHaveBeenCalledWith(
      PolicyType.OrganizationDataOwnership,
      otherUserId,
    );
    expect(accountsRead()).not.toContain(activeUserId);
    expect(config.userId).toBe(otherUserId);
    expect(config.cipherType).toBe(CipherType.Card);
  });

  it("builds the config of a new cipher for the given account", async () => {
    const config = await service.buildConfig("add", undefined, CipherType.Login, otherUserId);

    expect(cipherService.get).not.toHaveBeenCalled();
    expect(accountsRead()).not.toContain(activeUserId);
    expect(config.userId).toBe(otherUserId);
    expect(config.mode).toBe("add");
  });

  it("builds the config from the active account's vault without an account", async () => {
    const config = await service.buildConfig("edit", cipherId);

    expect(cipherService.get).toHaveBeenCalledWith(cipherId, activeUserId);
    expect(accountsRead()).not.toContain(otherUserId);
    expect(config.userId).toBeUndefined();
  });
});
