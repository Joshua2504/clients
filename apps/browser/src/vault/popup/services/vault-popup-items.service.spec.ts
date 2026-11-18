import { computed, signal, WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { mock } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom, of, skip, take, timeout } from "rxjs";

import { CollectionService } from "@bitwarden/admin-console/common";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { CollectionView } from "@bitwarden/common/admin-console/models/collections";
import { Organization } from "@bitwarden/common/admin-console/models/domain/organization";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { AccountCipher } from "@bitwarden/common/autofill/types/account-cipher";
import { ProductTierType } from "@bitwarden/common/billing/enums";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import { uuidAsString } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { SyncService } from "@bitwarden/common/platform/sync";
import {
  FakeAccountService,
  mockAccountInfoWith,
  mockAccountServiceWith,
  ObservableTracker,
} from "@bitwarden/common/spec";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { RevealedCipherService } from "@bitwarden/common/vault/abstractions/revealed-cipher.service";
import { SearchService } from "@bitwarden/common/vault/abstractions/search.service";
import { VaultSettingsService } from "@bitwarden/common/vault/abstractions/vault-settings/vault-settings.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  RestrictedCipherType,
  RestrictedItemTypesService,
} from "@bitwarden/common/vault/services/restricted-item-types.service";
import { CipherViewLikeUtils } from "@bitwarden/common/vault/utils/cipher-view-like-utils";

import { CipherUse } from "../../../autofill/services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../../../autofill/services/abstractions/multi-account-fill-cipher-policy";
import { InlineMenuFieldQualificationService } from "../../../autofill/services/inline-menu-field-qualification.service";
import { BrowserApi } from "../../../platform/browser/browser-api";
import { PopupViewCacheService } from "../../../platform/popup/view-cache/popup-view-cache.service";

import { VaultPopupAutofillService } from "./vault-popup-autofill.service";
import { VaultPopupItemsService } from "./vault-popup-items.service";
import {
  MY_VAULT_ID,
  PopupListFilter,
  VaultPopupListFiltersService,
} from "./vault-popup-list-filters.service";
import { VaultPopupListTableFiltersService } from "./vault-popup-list-table-filters.service";

describe("VaultPopupItemsService", () => {
  let testBed: TestBed;
  let service: VaultPopupItemsService;
  let allCiphers: Record<CipherId, CipherView>;
  let autoFillCiphers: CipherView[];

  let mockOrg: Organization;
  let mockCollections: CollectionView[];
  let activeUserLastSync$: BehaviorSubject<Date | null>;
  let vfo1Enabled$: BehaviorSubject<boolean>;
  let viewCacheService: {
    signal: jest.Mock;
    mockSignal: WritableSignal<string | null>;
  };

  let cipherList$: BehaviorSubject<CipherView[]>;
  let failedToDecryptCiphersSubject: BehaviorSubject<CipherView[]>;

  const cipherServiceMock = mock<CipherService>();
  const vaultSettingsServiceMock = mock<VaultSettingsService>();
  const organizationServiceMock = mock<OrganizationService>();
  const searchService = mock<SearchService>();
  const collectionService = mock<CollectionService>();
  const vaultAutofillServiceMock = mock<VaultPopupAutofillService>();
  const syncServiceMock = mock<SyncService>();
  const vaultPopupListFiltersServiceMock = mock<VaultPopupListFiltersService>();
  /** Stands in for the filters service's per-vault search text store. */
  const searchTextByScope = signal<Record<string, string>>({});
  const vaultPopupListTableFiltersServiceMock = mock<VaultPopupListTableFiltersService>({
    searchText: computed(() => searchTextByScope()["allItems"] ?? ""),
    setSearchText: jest.fn(async (text: string) => searchTextByScope.set({ allItems: text })),
  });
  const configServiceMock = mock<ConfigService>();
  let filters$: BehaviorSubject<PopupListFilter>;

  const inlineMenuFieldQualificationServiceMock = mock<InlineMenuFieldQualificationService>();
  const userId = Utils.newGuid() as UserId;
  const accountServiceMock = mockAccountServiceWith(userId);

  const revealedCipherService = mock<RevealedCipherService>();
  let revealed$: BehaviorSubject<ReadonlyMap<CipherId, CipherView>>;

  const restrictedItemTypesService = {
    restricted$: new BehaviorSubject<RestrictedCipherType[]>([]),
    restrictedFor$: jest.fn((_userId: UserId) => of<RestrictedCipherType[]>([])),
    isCipherRestricted: jest.fn().mockReturnValue(false),
  };

  /** The active account of the service under test. */
  const activeUserId = "UserId" as UserId;
  const otherUserId = "OtherUserId" as UserId;
  let autofillUserIds$: BehaviorSubject<UserId[]>;
  let fillCipherPolicyChanged$: BehaviorSubject<void>;
  const multiAccountFillCipherPolicy = mock<MultiAccountFillCipherPolicy>();

  beforeEach(() => {
    revealed$ = new BehaviorSubject<ReadonlyMap<CipherId, CipherView>>(new Map());
    revealedCipherService.revealed$.mockReturnValue(revealed$);
    allCiphers = cipherFactory(10);
    const cipherList = Object.values(allCiphers);
    // First 2 ciphers are autofill
    autoFillCiphers = cipherList.slice(0, 2);

    // First autofill cipher is also favorite
    autoFillCiphers[0].favorite = true;

    // 3rd and 4th ciphers are favorite
    cipherList[2].favorite = true;
    cipherList[3].favorite = true;

    cipherList$ = new BehaviorSubject<CipherView[]>(cipherList);

    cipherServiceMock.cipherListViewsIncludingRestricted$.mockReturnValue(
      cipherList$.asObservable(),
    );

    failedToDecryptCiphersSubject = new BehaviorSubject<CipherView[]>([]);

    cipherServiceMock.failedToDecryptCiphers$.mockImplementation((userId: UserId) =>
      failedToDecryptCiphersSubject.asObservable(),
    );

    searchService.searchCiphers.mockImplementation(
      async (userId, _organizationId, _query, ciphers) => ciphers!,
    );
    vfo1Enabled$ = new BehaviorSubject<boolean>(false);
    configServiceMock.getFeatureFlag$.mockReturnValue(vfo1Enabled$);
    cipherServiceMock.filterCiphersForUrl.mockImplementation(async (ciphers) =>
      ciphers.filter((c) => ["0", "1"].includes(uuidAsString(c.id))),
    );
    vaultSettingsServiceMock.showCardsCurrentTab$ = new BehaviorSubject(false);
    vaultSettingsServiceMock.showIdentitiesCurrentTab$ = new BehaviorSubject(false);

    vaultAutofillServiceMock.currentAutofillTab$ = new BehaviorSubject({
      url: "https://example.com",
    } as chrome.tabs.Tab);

    vaultAutofillServiceMock.nonLoginCipherTypesOnPage$ = new BehaviorSubject({
      [CipherType.Card]: true,
      [CipherType.Identity]: true,
    });

    mockOrg = {
      id: "org1",
      name: "Organization 1",
      productTierType: ProductTierType.Enterprise,
      enabled: true,
    } as Organization;

    filters$ = new BehaviorSubject<PopupListFilter>({
      organization: null,
      collection: null,
      folder: null,
      cipherType: null,
    });
    vaultPopupListFiltersServiceMock.filters$ = filters$;
    vaultPopupListFiltersServiceMock.filterFunction$ = of((ciphers) => ciphers);
    vaultPopupListTableFiltersServiceMock.hasFilterApplied$ = of(false);
    searchTextByScope.set({});

    mockCollections = [
      { id: "col1", name: "Collection 1" } as CollectionView,
      { id: "col2", name: "Collection 2" } as CollectionView,
    ];

    organizationServiceMock.organizations$.mockReturnValue(new BehaviorSubject([mockOrg]));
    collectionService.decryptedCollections$.mockReturnValue(new BehaviorSubject(mockCollections));

    activeUserLastSync$ = new BehaviorSubject<Date | null>(new Date());
    syncServiceMock.activeUserLastSync$.mockReturnValue(activeUserLastSync$);

    const testSearchSignal = createMockSignal<string | null>("");
    viewCacheService = {
      mockSignal: testSearchSignal,
      signal: jest.fn((options) => testSearchSignal),
    };

    // No account has opted in: the active account is the only autofill account.
    autofillUserIds$ = new BehaviorSubject<UserId[]>([activeUserId]);
    fillCipherPolicyChanged$ = new BehaviorSubject<void>(undefined);
    (multiAccountFillCipherPolicy as { changed$: unknown }).changed$ = fillCipherPolicyChanged$;
    multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue([]);

    testBed = TestBed.configureTestingModule({
      providers: [
        { provide: AutofillAccountsService, useValue: { autofillUserIds$ } },
        { provide: MultiAccountFillCipherPolicy, useValue: multiAccountFillCipherPolicy },
        { provide: RevealedCipherService, useValue: revealedCipherService },
        { provide: CipherService, useValue: cipherServiceMock },
        { provide: VaultSettingsService, useValue: vaultSettingsServiceMock },
        { provide: SearchService, useValue: searchService },
        { provide: OrganizationService, useValue: organizationServiceMock },
        { provide: AccountService, useValue: accountServiceMock },
        { provide: CollectionService, useValue: collectionService },
        { provide: VaultPopupAutofillService, useValue: vaultAutofillServiceMock },
        { provide: VaultPopupListFiltersService, useValue: vaultPopupListFiltersServiceMock },
        {
          provide: VaultPopupListTableFiltersService,
          useValue: vaultPopupListTableFiltersServiceMock,
        },
        { provide: SyncService, useValue: syncServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
        { provide: AccountService, useValue: mockAccountServiceWith(activeUserId) },
        {
          provide: InlineMenuFieldQualificationService,
          useValue: inlineMenuFieldQualificationServiceMock,
        },
        { provide: PopupViewCacheService, useValue: viewCacheService },
        {
          provide: RestrictedItemTypesService,
          useValue: restrictedItemTypesService,
        },
      ],
    });

    service = testBed.inject(VaultPopupItemsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be created", () => {
    service = testBed.inject(VaultPopupItemsService);
    expect(service).toBeTruthy();
  });

  it("should merge cipher views with collections and organization", (done) => {
    const cipherList = Object.values(allCiphers);
    cipherList[0].organizationId = "org1";
    cipherList[0].collectionIds = ["col1", "col2"];

    service.autoFillCiphers$.subscribe((ciphers) => {
      expect(ciphers[0].organization).toEqual(mockOrg);
      expect(ciphers[0].collections).toContain(mockCollections[0]);
      expect(ciphers[0].collections).toContain(mockCollections[1]);
      done();
    });
  });

  it("should update cipher list when cipherService.cipherListViewsIncludingRestricted$ emits", async () => {
    const tracker = new ObservableTracker(service.autoFillCiphers$);

    await tracker.expectEmission();

    cipherList$.next(cipherList$.value);

    await tracker.expectEmission();

    // Should only emit twice
    expect(tracker.emissions.length).toBe(2);
    await expect(tracker.pauseUntilReceived(3)).rejects.toThrow("Timeout exceeded");
  });

  it("should not emit cipher list if syncService.getLastSync returns null", async () => {
    activeUserLastSync$.next(null);

    const obs$ = service.autoFillCiphers$.pipe(timeout(50));

    await expect(firstValueFrom(obs$)).rejects.toThrow("Timeout has occurred");
  });

  describe("autoFillCiphers$", () => {
    it("should return empty array if there is no current tab", (done) => {
      (vaultAutofillServiceMock.currentAutofillTab$ as BehaviorSubject<any>).next(null);
      service.autoFillCiphers$.subscribe((ciphers) => {
        expect(ciphers).toEqual([]);
        done();
      });
    });

    it("should filter ciphers for the current tab and types", (done) => {
      const currentTab = { url: "https://example.com" } as chrome.tabs.Tab;

      (vaultSettingsServiceMock.showCardsCurrentTab$ as BehaviorSubject<boolean>).next(true);
      (vaultSettingsServiceMock.showIdentitiesCurrentTab$ as BehaviorSubject<boolean>).next(true);
      jest.spyOn(BrowserApi, "getTabFromCurrentWindow").mockResolvedValue(currentTab);

      service.autoFillCiphers$.subscribe((ciphers) => {
        expect(cipherServiceMock.filterCiphersForUrl.mock.calls.length).toBe(1);
        expect(cipherServiceMock.filterCiphersForUrl).toHaveBeenCalledWith(
          expect.anything(),
          currentTab.url,
          [CipherType.Card, CipherType.Identity],
        );
        done();
      });
    });

    it("should return ciphers sorted by type, then by last used date, then by name", (done) => {
      const expectedTypeOrder: Record<CipherType, number> = {
        [CipherType.Login]: 1,
        [CipherType.Card]: 2,
        [CipherType.Identity]: 3,
        [CipherType.SecureNote]: 4,
        [CipherType.SshKey]: 5,
        [CipherType.BankAccount]: 6,
        [CipherType.DriversLicense]: 7,
        [CipherType.Passport]: 8,
      };

      // Assume all ciphers are autofill ciphers to test sorting
      cipherServiceMock.filterCiphersForUrl.mockResolvedValue(Object.values(allCiphers));

      service.autoFillCiphers$.subscribe((ciphers) => {
        expect(ciphers.length).toBe(10);

        for (let i = 0; i < ciphers.length - 1; i++) {
          const current = ciphers[i];
          const next = ciphers[i + 1];

          expect(expectedTypeOrder[CipherViewLikeUtils.getType(current)]).toBeLessThanOrEqual(
            expectedTypeOrder[CipherViewLikeUtils.getType(next)],
          );
        }
        expect(cipherServiceMock.sortCiphersByLastUsedThenName).toHaveBeenCalled();
        done();
      });
    });

    it("should filter autoFillCiphers$ down to search term", (done) => {
      const searchText = "Login";

      searchService.searchCiphers.mockImplementation(
        async (userId, _organizationId, q, ciphers) => {
          return ciphers!.filter((cipher) => {
            return cipher.name.includes(searchText);
          });
        },
      );

      // there is only 1 Login returned for filteredCiphers.
      service.autoFillCiphers$.subscribe((ciphers) => {
        expect(ciphers[0].name.includes(searchText)).toBe(true);
        expect(ciphers.length).toBe(1);
        done();
      });
    });
  });

  describe("filteredCiphers$", () => {
    it("should filter filteredCipher$ down to search term", (done) => {
      const cipherList = Object.values(allCiphers);
      const searchText = "Login";

      const searchResult = cipherList.filter((cipher) => {
        return cipher.name.includes(searchText);
      });
      searchService.searchCiphers.mockResolvedValue(searchResult);

      service.filteredCiphers$.subscribe((ciphers) => {
        // There are 10 ciphers but only 3 with "Login" in the name
        expect(ciphers.length).toBe(3);
        done();
      });
    });
  });

  describe("restricted ciphers", () => {
    const restrictedRow = () =>
      Object.assign(new CipherView(), { id: "restricted" as CipherId, partial: true });

    beforeEach(() => {
      searchService.searchCiphers.mockImplementation(
        async (_userId, _filter, _text, ciphers) => ciphers,
      );
    });

    it("lists restricted ciphers", async () => {
      cipherServiceMock.cipherListViewsIncludingRestricted$.mockReturnValue(of([restrictedRow()]));

      const ciphers = await firstValueFrom(service.filteredCiphers$);

      expect(ciphers.map((c) => c.id)).toEqual(["restricted"]);
      expect(cipherServiceMock.cipherListViewsIncludingRestricted$).toHaveBeenCalled();
      expect(cipherServiceMock.cipherListViews$).not.toHaveBeenCalled();
    });

    it("swaps the revealed view in for its restricted row, keeping the row's organization", async () => {
      const row = Object.assign(restrictedRow(), { organizationId: "org1" });
      const revealed = Object.assign(new CipherView(), { id: "restricted" as CipherId });
      cipherServiceMock.cipherListViewsIncludingRestricted$.mockReturnValue(of([row]));
      revealed$.next(new Map([["restricted" as CipherId, revealed]]));

      const [shown] = await firstValueFrom(service.filteredCiphers$);

      expect(shown).toBe(revealed);
      expect(shown.organization).toEqual(mockOrg);
    });

    it("leaves restricted ciphers out of the trash", async () => {
      const deletedRow = Object.assign(restrictedRow(), { deletedDate: new Date() });
      const deleted = Object.assign(new CipherView(), { deletedDate: new Date() });
      cipherServiceMock.cipherListViewsIncludingRestricted$.mockReturnValue(
        of([deletedRow, deleted]),
      );

      const deletedCiphers = await firstValueFrom(service.deletedCiphers$);

      expect(deletedCiphers).toHaveLength(1);
      expect(deletedCiphers[0].id).not.toBe("restricted");
    });
  });

  describe("favoriteCiphers$", () => {
    it("should exclude autofill ciphers", (done) => {
      service.favoriteCiphers$.subscribe((ciphers) => {
        // 2 autofill ciphers, 3 favorite ciphers, 1 favorite cipher is also autofill = 2 favorite ciphers to show
        expect(ciphers.length).toBe(2);
        done();
      });
    });

    it("should filter favoriteCiphers$ down to search term", (done) => {
      const cipherList = Object.values(allCiphers);
      const searchText = "Card 2";

      const searchResult = cipherList.filter((cipher) => {
        return cipher.name.includes(searchText);
      });
      searchService.searchCiphers.mockResolvedValue(searchResult);

      service.favoriteCiphers$.subscribe((ciphers) => {
        // There are 2 favorite items but only one Card 2
        expect(ciphers[0].name).toBe(searchText);
        expect(ciphers.length).toBe(1);
        done();
      });
    });
  });

  describe("emptyVault$", () => {
    it("should return true if there are no ciphers", (done) => {
      cipherServiceMock.cipherListViewsIncludingRestricted$.mockReturnValue(of([]));
      service.emptyVault$.pipe(take(1)).subscribe((empty) => {
        expect(empty).toBe(true);
        done();
      });
    });

    it("should return false if there are ciphers", (done) => {
      cipherServiceMock.cipherListViewsIncludingRestricted$.mockReturnValue(
        of([{ id: "1", type: CipherType.Login, name: "Login 1" }] as CipherView[]),
      );

      service.emptyVault$.pipe(take(1)).subscribe((empty) => {
        expect(empty).toBe(false);
        done();
      });
    });

    it("should return true when all ciphers are deleted/archived", (done) => {
      cipherServiceMock.cipherListViewsIncludingRestricted$.mockReturnValue(
        of([
          { id: "1", type: CipherType.Login, name: "Login 1", isDeleted: true },
          { id: "2", type: CipherType.Login, name: "Login 2", isDeleted: true },
          { id: "3", type: CipherType.Login, name: "Login 3", isDeleted: false, isArchived: true },
        ] as CipherView[]),
      );

      service.emptyVault$.pipe(take(1)).subscribe((empty) => {
        expect(empty).toBe(true);
        done();
      });
    });
  });

  describe("noFilteredResults$", () => {
    it("should return false when filteredResults has values", (done) => {
      service.noFilteredResults$.subscribe((noResults) => {
        expect(noResults).toBe(false);
        done();
      });
    });

    it("should return true when there are zero filteredResults", (done) => {
      searchService.searchCiphers.mockResolvedValue([]);
      service.noFilteredResults$.subscribe((noResults) => {
        expect(noResults).toBe(true);
        done();
      });
    });
  });

  describe("deletedCiphers$", () => {
    it("should return deleted ciphers", async () => {
      const deletedCipher = new CipherView();
      deletedCipher.deletedDate = new Date();
      const ciphers = [new CipherView(), new CipherView(), new CipherView(), deletedCipher];

      cipherServiceMock.cipherListViewsIncludingRestricted$.mockReturnValue(of(ciphers));

      const deletedCiphers = await firstValueFrom(service.deletedCiphers$);
      expect(deletedCiphers.length).toBe(1);
    });

    it("should exclude deleted ciphers from organizations the user no longer belongs to", async () => {
      const personalCipher = new CipherView();
      personalCipher.deletedDate = new Date();
      const memberOrgCipher = new CipherView();
      memberOrgCipher.deletedDate = new Date();
      memberOrgCipher.organizationId = "org1";
      const revokedOrgCipher = new CipherView();
      revokedOrgCipher.deletedDate = new Date();
      revokedOrgCipher.organizationId = "revokedOrg";

      cipherServiceMock.cipherListViewsIncludingRestricted$.mockReturnValue(
        of([personalCipher, memberOrgCipher, revokedOrgCipher]),
      );

      const deletedCiphers = await firstValueFrom(service.deletedCiphers$);
      expect(deletedCiphers.map((c) => c.organizationId)).toEqual([undefined, "org1"]);
    });
  });

  describe("organization access", () => {
    it("should exclude ciphers from organizations the user no longer belongs to", async () => {
      const cipherList = Object.values(allCiphers);
      cipherList[0].organizationId = "org1";
      cipherList[1].organizationId = "revokedOrg";

      const activeCiphers = await firstValueFrom(service.activeCiphers$);

      expect(activeCiphers.map((c) => c.id)).not.toContain(cipherList[1].id);
      expect(activeCiphers.find((c) => c.id === cipherList[0].id)?.organization).toEqual(mockOrg);
      expect(activeCiphers.length).toBe(cipherList.length - 1);
    });

    it("should drop an organization's ciphers as soon as the organization is removed", async () => {
      const organizations$ = new BehaviorSubject<Organization[]>([mockOrg]);
      organizationServiceMock.organizations$.mockReturnValue(organizations$);
      const cipherList = Object.values(allCiphers);
      cipherList[0].organizationId = "org1";

      const tracker = new ObservableTracker(service.activeCiphers$, false);
      const [initial] = await tracker.pauseUntilReceived(1);
      expect(initial.map((c) => c.id)).toContain(cipherList[0].id);

      // A sync replaces organizations before ciphers, so the cipher list has not changed yet.
      organizations$.next([]);

      const updated = (await tracker.pauseUntilReceived(2))[1];
      expect(updated.map((c) => c.id)).not.toContain(cipherList[0].id);
      expect(updated.every((c) => !c.organizationId || c.organization != null)).toBe(true);
    });
  });

  describe("showDeactivatedOrg$", () => {
    it("returns false when no organization filter is selected", async () => {
      expect(await firstValueFrom(service.showDeactivatedOrg$)).toBe(false);
    });

    it("returns false when the selected organization is enabled", (done) => {
      filters$.next({
        organization: mockOrg,
        collection: null,
        folder: null,
        cipherType: null,
      });

      service.showDeactivatedOrg$.subscribe((showDeactivatedOrg) => {
        expect(showDeactivatedOrg).toBe(false);
        done();
      });
    });

    it("returns true when the selected organization is disabled", (done) => {
      organizationServiceMock.organizations$.mockReturnValue(
        new BehaviorSubject([{ ...mockOrg, enabled: false } as Organization]),
      );
      filters$.next({
        organization: mockOrg,
        collection: null,
        folder: null,
        cipherType: null,
      });

      service.showDeactivatedOrg$.subscribe((showDeactivatedOrg) => {
        expect(showDeactivatedOrg).toBe(true);
        done();
      });
    });

    it("returns false when 'My vault' is selected, even though it can never be suspended", (done) => {
      filters$.next({
        organization: { id: MY_VAULT_ID } as Organization,
        collection: null,
        folder: null,
        cipherType: null,
      });

      service.showDeactivatedOrg$.subscribe((showDeactivatedOrg) => {
        expect(showDeactivatedOrg).toBe(false);
        done();
      });
    });
  });

  describe("hasFilterApplied$", () => {
    it("should return true if the search term provided is searchable", (done) => {
      searchService.isSearchable.mockImplementation(async () => true);
      service.applyFilter("test");
      service.hasFilterApplied$.subscribe((canSearch) => {
        expect(canSearch).toBe(true);
        done();
      });
    });

    it("should return false if the search term provided is not searchable", (done) => {
      searchService.isSearchable.mockImplementation(async () => false);
      service.hasFilterApplied$.subscribe((canSearch) => {
        expect(canSearch).toBe(false);
        done();
      });
    });
  });

  describe("loading$", () => {
    let tracked: ObservableTracker<boolean>;
    let trackedCiphers: ObservableTracker<any>;
    beforeEach(() => {
      // Start tracking loading$ emissions
      tracked = new ObservableTracker(service.loading$);

      // Track favoriteCiphers$ to make cipher observables active
      trackedCiphers = new ObservableTracker(service.favoriteCiphers$);
    });

    it("should initialize with true first", async () => {
      expect(tracked.emissions[0]).toBe(true);
    });

    it("should emit false once ciphers are available", async () => {
      await trackedCiphers.expectEmission();
      expect(tracked.emissions.length).toBe(2);
      expect(tracked.emissions[0]).toBe(true);
      expect(tracked.emissions[1]).toBe(false);
    });

    it("should cycle when cipherService.cipherListViewsIncludingRestricted$ emits", async () => {
      await trackedCiphers.expectEmission();
      // Restart tracking
      tracked = new ObservableTracker(service.loading$);
      cipherList$.next(cipherList$.value);

      await trackedCiphers.pauseUntilReceived(2);

      expect(tracked.emissions.length).toBe(3);
      expect(tracked.emissions[0]).toBe(false);
      expect(tracked.emissions[1]).toBe(true);
      expect(tracked.emissions[2]).toBe(false);
    });
  });

  describe("applyFilter", () => {
    it("should call search Service with the new search term", async () => {
      const searchText = "Hello";
      const searchServiceSpy = jest.spyOn(searchService, "searchCiphers");
      searchService.isSearchable.mockImplementation(async () => true);

      service.applyFilter(searchText);

      await firstValueFrom(service.favoriteCiphers$.pipe(take(1)));

      expect(searchServiceSpy).toHaveBeenCalledWith("UserId", null, searchText, expect.anything());
    });
  });

  it("should update searchText$ and the view cache when applyFilter is called", (done) => {
    service.searchText$.subscribe((val) => {
      expect(val).toEqual("test search");
      expect(viewCacheService.mockSignal()).toEqual("test search");
      done();
    });

    service.applyFilter("test search");
  });

  it("should not write the legacy search text to the per-user state", () => {
    service.applyFilter("test search");

    expect(vaultPopupListTableFiltersServiceMock.setSearchText).not.toHaveBeenCalled();
  });

  describe("with VFO1 enabled", () => {
    beforeEach(() => {
      vfo1Enabled$.next(true);
    });

    it("should store the search text per user when applyScopedFilter is called", () => {
      service.applyScopedFilter("test search");

      expect(vaultPopupListTableFiltersServiceMock.setSearchText).toHaveBeenCalledWith(
        "test search",
      );
      expect(viewCacheService.mockSignal()).toBe("");
    });

    it("should read the search text from the per-user state", () => {
      service.applyScopedFilter("test search");

      expect(service.searchText()).toBe("test search");
    });

    it("should ignore the view-cached search text", () => {
      viewCacheService.mockSignal.set("legacy text");

      expect(service.searchText()).toBe("");
    });
  });

  describe("clearSearchText on account switch", () => {
    it("should clear search text when the active account changes", () => {
      service.applyFilter("some search text");
      expect(viewCacheService.mockSignal()).toBe("some search text");

      const accountService = testBed.inject(AccountService) as FakeAccountService;
      const newUserId = Utils.newGuid() as UserId;
      accountService.activeAccountSubject.next({
        id: newUserId,
        name: "New User",
        email: "new@example.com",
        emailVerified: true,
        creationDate: new Date(),
      });

      expect(viewCacheService.mockSignal()).toBe("");
    });

    it("should not clear search text when the same account re-emits", () => {
      service.applyFilter("some search text");
      expect(viewCacheService.mockSignal()).toBe("some search text");

      const accountService = testBed.inject(AccountService) as FakeAccountService;
      // Re-emit the same userId — distinctUntilChanged should swallow it
      accountService.activeAccountSubject.next({
        id: "UserId" as UserId,
        name: "name",
        email: "email",
        emailVerified: true,
        creationDate: new Date(),
      });

      expect(viewCacheService.mockSignal()).toBe("some search text");
    });
  });

  describe("otherAccountAutoFillCiphers$", () => {
    const otherEmail = "other@example.com";
    let otherLogin: CipherView;
    let otherCard: CipherView;

    /** The matches of the multi-account policy: the active account's first, as it returns them. */
    const policyMatches = (...other: CipherView[]): AccountCipher[] => [
      ...autoFillCiphers.map((cipher) => ({ userId: activeUserId, cipher })),
      ...other.map((cipher) => ({ userId: otherUserId, cipher })),
    ];

    beforeEach(async () => {
      otherLogin = { id: "other-login", type: CipherType.Login, name: "Other login" } as CipherView;
      otherCard = { id: "other-card", type: CipherType.Card, name: "Other card" } as CipherView;
      restrictedItemTypesService.isCipherRestricted.mockReturnValue(false);
      cipherServiceMock.sortCiphersByLastUsedThenName.mockReturnValue(0);

      await (testBed.inject(AccountService) as FakeAccountService).addAccount(
        otherUserId,
        mockAccountInfoWith({ email: otherEmail }),
      );
    });

    it("is empty and reads no other vault while no account has opted in", async () => {
      expect(await firstValueFrom(service.otherAccountAutoFillCiphers$)).toEqual([]);
      expect(multiAccountFillCipherPolicy.ciphersForUrl).not.toHaveBeenCalled();
    });

    it("lists the matches of a second unlocked account that has opted in", async () => {
      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(
        policyMatches(otherCard, otherLogin),
      );
      autofillUserIds$.next([activeUserId, otherUserId]);

      const accounts = await firstValueFrom(service.otherAccountAutoFillCiphers$);

      // The active account keeps its own section: none of its ciphers are repeated here.
      expect(accounts).toEqual([
        { userId: otherUserId, email: otherEmail, ciphers: [otherLogin, otherCard] },
      ]);
      expect(multiAccountFillCipherPolicy.ciphersForUrl).toHaveBeenCalledWith(
        "https://example.com",
        CipherUse.UserFill,
        { includeOtherTypes: [CipherType.Card, CipherType.Identity] },
      );
    });

    it("leaves the active account's suggestions as they are", async () => {
      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(policyMatches(otherLogin));
      autofillUserIds$.next([activeUserId, otherUserId]);

      await firstValueFrom(service.otherAccountAutoFillCiphers$);

      expect(await firstValueFrom(service.autoFillCiphers$)).toEqual(autoFillCiphers);
    });

    it("lists no account that has no match", async () => {
      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(policyMatches());
      autofillUserIds$.next([activeUserId, otherUserId]);

      expect(await firstValueFrom(service.otherAccountAutoFillCiphers$)).toEqual([]);
    });

    it("drops the account's ciphers when it locks", async () => {
      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(policyMatches(otherLogin));
      autofillUserIds$.next([activeUserId, otherUserId]);
      const emissions: unknown[] = [];
      const subscription = service.otherAccountAutoFillCiphers$.subscribe((value) =>
        emissions.push(value),
      );
      await firstValueFrom(service.otherAccountAutoFillCiphers$);

      // A locked account is no autofill account.
      autofillUserIds$.next([activeUserId]);

      expect(emissions).toEqual([
        [{ userId: otherUserId, email: otherEmail, ciphers: [otherLogin] }],
        [],
      ]);
      subscription.unsubscribe();
    });

    it("lists a shared item under each account that holds it", async () => {
      const sharedId = autoFillCiphers[0].id;
      const sharedInOther = {
        id: sharedId,
        type: CipherType.Login,
        name: "Shared login",
        organizationId: "org2",
        collectionIds: ["col9"],
      } as unknown as CipherView;
      const otherOrg = { id: "org2", name: "Organization 2" } as Organization;
      const otherCollection = { id: "col9", name: "Collection 9" } as CollectionView;
      organizationServiceMock.organizations$.mockImplementation((id) =>
        of(id === otherUserId ? [otherOrg] : [mockOrg]),
      );
      collectionService.decryptedCollections$.mockImplementation((id) =>
        of(id === otherUserId ? [otherCollection] : mockCollections),
      );
      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(policyMatches(sharedInOther));
      autofillUserIds$.next([activeUserId, otherUserId]);

      const [account] = await firstValueFrom(service.otherAccountAutoFillCiphers$);
      const active = await firstValueFrom(service.autoFillCiphers$);

      expect(active.map((cipher) => cipher.id)).toContain(sharedId);
      expect(account.userId).toBe(otherUserId);
      // The other account's copy, with the organization and collections of that account.
      expect(account.ciphers).toEqual([sharedInOther]);
      expect(account.ciphers[0].organization).toBe(otherOrg);
      expect(account.ciphers[0].collections).toEqual([otherCollection]);
    });

    it("applies the restricted item types of the cipher's own account", async () => {
      const restrictions: RestrictedCipherType[] = [
        { cipherType: CipherType.Card, allowViewOrgIds: [] },
      ];
      restrictedItemTypesService.restrictedFor$.mockReturnValue(of(restrictions));
      restrictedItemTypesService.isCipherRestricted.mockImplementation(
        (cipher: CipherView, restricted: RestrictedCipherType[]) =>
          restricted === restrictions && cipher.type === CipherType.Card,
      );
      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(
        policyMatches(otherLogin, otherCard),
      );
      autofillUserIds$.next([activeUserId, otherUserId]);

      const [account] = await firstValueFrom(service.otherAccountAutoFillCiphers$);

      expect(restrictedItemTypesService.restrictedFor$).toHaveBeenCalledWith(otherUserId);
      expect(account.ciphers).toEqual([otherLogin]);
    });

    it("leaves out an item of an organization the account no longer belongs to", async () => {
      const orphaned = { ...otherLogin, id: "orphaned", organizationId: "gone" } as CipherView;
      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(
        policyMatches(orphaned, otherLogin),
      );
      autofillUserIds$.next([activeUserId, otherUserId]);

      const [account] = await firstValueFrom(service.otherAccountAutoFillCiphers$);

      expect(account.ciphers).toEqual([otherLogin]);
    });

    it("looks the ciphers up again when the policy reports a change", async () => {
      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(policyMatches());
      autofillUserIds$.next([activeUserId, otherUserId]);
      const subscription = service.otherAccountAutoFillCiphers$.subscribe();
      await firstValueFrom(service.otherAccountAutoFillCiphers$);

      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(policyMatches(otherLogin));
      const next = firstValueFrom(service.otherAccountAutoFillCiphers$.pipe(skip(1)));
      fillCipherPolicyChanged$.next();

      expect(await next).toEqual([
        { userId: otherUserId, email: otherEmail, ciphers: [otherLogin] },
      ]);
      subscription.unsubscribe();
    });

    it("is empty while the autofill accounts do not lead with the active account", async () => {
      // During a switch the previous active account can still lead the list.
      multiAccountFillCipherPolicy.ciphersForUrl.mockResolvedValue(policyMatches(otherLogin));
      autofillUserIds$.next([otherUserId, activeUserId]);

      expect(await firstValueFrom(service.otherAccountAutoFillCiphers$)).toEqual([]);
      expect(multiAccountFillCipherPolicy.ciphersForUrl).not.toHaveBeenCalled();
    });

    it("is empty when the lookup fails", async () => {
      multiAccountFillCipherPolicy.ciphersForUrl.mockRejectedValue(new Error("locked"));
      autofillUserIds$.next([activeUserId, otherUserId]);

      expect(await firstValueFrom(service.otherAccountAutoFillCiphers$)).toEqual([]);
    });
  });
});

// A function to generate a list of ciphers of different types
function cipherFactory(count: number): Record<CipherId, CipherView> {
  const ciphers: CipherView[] = [];
  for (let i = 0; i < count; i++) {
    const type = ((i % 4) + 1) as CipherType;
    switch (type) {
      case CipherType.Login:
        ciphers.push({
          id: `${i}`,
          type: CipherType.Login,
          name: `Login ${i}`,
          login: {
            username: `username${i}`,
            password: `password${i}`,
          },
        } as CipherView);
        break;
      case CipherType.SecureNote:
        ciphers.push({
          id: `${i}`,
          type: CipherType.SecureNote,
          name: `SecureNote ${i}`,
          notes: `notes${i}`,
        } as CipherView);
        break;
      case CipherType.Card:
        ciphers.push({
          id: `${i}`,
          type: CipherType.Card,
          name: `Card ${i}`,
          card: {
            cardholderName: `cardholderName${i}`,
            number: `number${i}`,
            brand: `brand${i}`,
          },
        } as CipherView);
        break;
      case CipherType.Identity:
        ciphers.push({
          id: `${i}`,
          type: CipherType.Identity,
          name: `Identity ${i}`,
          identity: {
            firstName: `firstName${i}`,
            lastName: `lastName${i}`,
          },
        } as CipherView);
        break;
    }
  }
  return Object.fromEntries(ciphers.map((c) => [c.id, c]));
}

function createMockSignal<T>(initialValue: T): WritableSignal<T> {
  const s = signal(initialValue);
  s.set = (value: T) => s.update(() => value);
  return s;
}
