import { signal, WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";

import { ViewCacheService } from "@bitwarden/angular/platform/view-cache";
import { UserId } from "@bitwarden/common/types/guid";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { CipherFormCacheService } from "./default-cipher-form-cache.service";

describe("CipherFormCacheService", () => {
  let service: CipherFormCacheService;
  let testBed: TestBed;
  const cacheSignal = signal<CipherView | null>(null);
  const accountSignal = signal<UserId | null>(null);
  const getCacheSignal = jest.fn(({ key }: { key: string }) =>
    key === "cipher-form-cache" ? cacheSignal : accountSignal,
  );
  const cacheSetMock = jest.spyOn(cacheSignal, "set");

  beforeEach(() => {
    getCacheSignal.mockClear();
    cacheSetMock.mockClear();
    accountSignal.set(null);

    testBed = TestBed.configureTestingModule({
      providers: [
        { provide: ViewCacheService, useValue: { signal: getCacheSignal } },
        CipherFormCacheService,
      ],
    });
  });

  describe("Cache Service", () => {
    it("`getCachedCipherView` returns the cipher", async () => {
      cacheSignal.set({ id: "cipher-4" } as CipherView);
      service = testBed.inject(CipherFormCacheService);

      expect(service.getCachedCipherView()).toEqual({ id: "cipher-4" });
    });

    it("updates the signal value", async () => {
      service = testBed.inject(CipherFormCacheService);

      service.cacheCipherView(new CipherView({ id: "cipher-5" } as Cipher));

      expect(cacheSignal.set).toHaveBeenCalledWith(expect.any(CipherView)); // Ensure we keep the CipherView prototype
      expect(cacheSignal.set).toHaveBeenCalledWith(expect.objectContaining({ id: "cipher-5" }));
    });

    describe("initializedWithValue", () => {
      it("sets `initializedWithValue` to true when there is a cached cipher", async () => {
        cacheSignal.set({ id: "cipher-3" } as CipherView);
        service = testBed.inject(CipherFormCacheService);

        expect(service.initializedWithValue).toBe(true);
      });

      it("sets `initializedWithValue` to false when there is not a cached cipher", async () => {
        cacheSignal.set(null);
        service = testBed.inject(CipherFormCacheService);

        expect(service.initializedWithValue).toBe(false);
      });
    });
  });

  describe("with two accounts", () => {
    const accountA = "account-a" as UserId;
    const accountB = "account-b" as UserId;

    /**
     * A view cache that outlives the service, as the popup's does: it is stored by the background
     * and read by the popup and by every popout, each with its own `CipherFormCacheService`.
     */
    let stored: Map<string, WritableSignal<any>>;

    const newService = () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          {
            provide: ViewCacheService,
            useValue: {
              signal: ({ key, initialValue }: { key: string; initialValue: unknown }) => {
                if (!stored.has(key)) {
                  stored.set(key, signal(initialValue));
                }
                return stored.get(key);
              },
            },
          },
          CipherFormCacheService,
        ],
      });
      return TestBed.inject(CipherFormCacheService);
    };

    const draft = (fields: Partial<CipherView>) => Object.assign(new CipherView(), fields);

    beforeEach(() => {
      stored = new Map();
    });

    it("restores a draft into a form of the account that wrote it", () => {
      const writer = newService();
      writer.useAccount(accountA);
      writer.cacheCipherView(draft({ name: "draft of A" }));

      const reader = newService();
      reader.useAccount(accountA);

      expect(reader.initializedWithValue).toBe(true);
      expect(reader.getCachedCipherView()).toEqual(expect.objectContaining({ name: "draft of A" }));
    });

    it("never restores a new-item draft of account A into a form of account B", () => {
      const writer = newService();
      writer.useAccount(accountA);
      writer.cacheCipherView(draft({ name: "draft of A" }));

      const reader = newService();
      // Before the form names its account the service still holds what it found.
      expect(reader.initializedWithValue).toBe(true);

      reader.useAccount(accountB);

      expect(reader.initializedWithValue).toBe(false);
      expect(reader.getCachedCipherView()).toBeNull();
      // The stored draft is gone too, so no later form of B can pick it up.
      expect(stored.get("cipher-form-cache")!()).toBeNull();
    });

    it("never restores the draft of a shared item of account A into the form of the same item in account B", () => {
      const writer = newService();
      writer.useAccount(accountA);
      writer.cacheCipherView(draft({ id: "shared-cipher", name: "edited in A", folderId: "a" }));

      const reader = newService();
      reader.useAccount(accountB);

      expect(reader.getCachedCipherView()).toBeNull();
    });

    it("drops a draft that was written without an account", () => {
      const writer = newService();
      writer.cacheCipherView(draft({ name: "untagged draft" }));

      const reader = newService();
      reader.useAccount(accountB);

      expect(reader.getCachedCipherView()).toBeNull();
    });

    it("tags what the form caches after it named its account, and replaces the other account's tag", () => {
      const writer = newService();
      writer.useAccount(accountA);
      writer.cacheCipherView(draft({ name: "draft of A" }));

      const formOfB = newService();
      formOfB.useAccount(accountB);
      formOfB.cacheCipherView(draft({ name: "draft of B" }));

      const formOfA = newService();
      formOfA.useAccount(accountA);
      expect(formOfA.getCachedCipherView()).toBeNull();
    });

    it("clears the account with the draft", () => {
      const service = newService();
      service.useAccount(accountA);
      service.cacheCipherView(draft({ name: "draft of A" }));

      service.clearCache();

      expect(stored.get("cipher-form-cache")!()).toBeNull();
      expect(stored.get("cipher-form-cache-account")!()).toBeNull();
    });
  });
});
