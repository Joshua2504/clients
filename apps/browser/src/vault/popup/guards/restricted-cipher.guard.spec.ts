import { TestBed } from "@angular/core/testing";
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from "@angular/router";
import { mock } from "jest-mock-extended";
import { of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { mockAccountServiceWith } from "@bitwarden/common/spec";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { RevealedCipherService } from "@bitwarden/common/vault/abstractions/revealed-cipher.service";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { RestrictedCipherAction } from "@bitwarden/common/vault/utils/restricted-cipher-policy";

import { restrictedCipherGuard } from "./restricted-cipher.guard";

describe("restrictedCipherGuard", () => {
  const userId = "user-id" as UserId;
  const cipherService = mock<CipherService>();
  const revealedCipherService = mock<RevealedCipherService>();
  const createUrlTree = jest.fn().mockReturnValue(new UrlTree());
  const isAutofillUser$ = jest.fn().mockReturnValue(of(true));

  const storedCipher = (restricted: boolean) =>
    Object.assign(new Cipher(), {
      id: "cipher-1",
      partialData: restricted ? {} : undefined,
    }) as Cipher;

  const runGuard = (action: RestrictedCipherAction, queryParams: Record<string, string>) =>
    TestBed.runInInjectionContext(() =>
      restrictedCipherGuard(action)(
        { queryParams } as unknown as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
      ),
    );

  const expectRedirectToView = (result: unknown) => {
    expect(createUrlTree).toHaveBeenCalledWith(["/view-cipher"], {
      queryParams: { cipherId: "cipher-1", type: "1" },
    });
    expect(result).toBeInstanceOf(UrlTree);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    revealedCipherService.getOrReveal.mockResolvedValue(null);

    TestBed.configureTestingModule({
      providers: [
        { provide: AccountService, useValue: mockAccountServiceWith(userId) },
        { provide: AutofillAccountsService, useValue: { isAutofillUser$ } },
        { provide: CipherService, useValue: cipherService },
        { provide: RevealedCipherService, useValue: revealedCipherService },
        { provide: Router, useValue: { createUrlTree } },
      ],
    });
  });

  it("allows a cipher that is not restricted", async () => {
    cipherService.get.mockResolvedValue(storedCipher(false));

    await expect(
      runGuard(RestrictedCipherAction.Clone, { cipherId: "cipher-1", type: "1" }),
    ).resolves.toBe(true);
    expect(cipherService.get).toHaveBeenCalledWith("cipher-1", userId);
    expect(revealedCipherService.getOrReveal).not.toHaveBeenCalled();
  });

  it("allows editing a restricted cipher while its revealed view is live", async () => {
    cipherService.get.mockResolvedValue(storedCipher(true));
    revealedCipherService.getOrReveal.mockResolvedValue(
      Object.assign(new CipherView(), { id: "cipher-1" }),
    );

    await expect(
      runGuard(RestrictedCipherAction.Edit, { cipherId: "cipher-1", type: "1" }),
    ).resolves.toBe(true);
    expect(revealedCipherService.getOrReveal).toHaveBeenCalledWith(userId, "cipher-1" as CipherId);
  });

  it("redirects editing a restricted cipher without a revealed view to its view", async () => {
    cipherService.get.mockResolvedValue(storedCipher(true));

    expectRedirectToView(
      await runGuard(RestrictedCipherAction.Edit, { cipherId: "cipher-1", type: "1" }),
    );
  });

  it.each([RestrictedCipherAction.Clone, RestrictedCipherAction.AssignCollections])(
    "redirects %s of a restricted cipher to its view without revealing it",
    async (action) => {
      cipherService.get.mockResolvedValue(storedCipher(true));

      expectRedirectToView(await runGuard(action, { cipherId: "cipher-1", type: "1" }));
      expect(revealedCipherService.getOrReveal).not.toHaveBeenCalled();
    },
  );

  it("allows a route without a cipher id", async () => {
    await expect(runGuard(RestrictedCipherAction.Edit, {})).resolves.toBe(true);
    expect(cipherService.get).not.toHaveBeenCalled();
  });

  describe("for the account named by `userId`", () => {
    const otherUserId = "other-user-id" as UserId;
    const params = { cipherId: "cipher-1", type: "1", userId: otherUserId };

    beforeEach(() => {
      isAutofillUser$.mockReturnValue(of(true));
    });

    it("reads the cipher from that account's vault", async () => {
      cipherService.get.mockResolvedValue(storedCipher(false));

      await expect(runGuard(RestrictedCipherAction.Clone, params)).resolves.toBe(true);

      expect(isAutofillUser$).toHaveBeenCalledWith(otherUserId);
      expect(cipherService.get).toHaveBeenCalledWith("cipher-1", otherUserId);
      expect(cipherService.get).not.toHaveBeenCalledWith("cipher-1", userId);
    });

    it("reveals a restricted cipher for that account", async () => {
      cipherService.get.mockResolvedValue(storedCipher(true));
      revealedCipherService.getOrReveal.mockResolvedValue(
        Object.assign(new CipherView(), { id: "cipher-1" }),
      );

      await expect(runGuard(RestrictedCipherAction.Edit, params)).resolves.toBe(true);

      expect(revealedCipherService.getOrReveal).toHaveBeenCalledWith(
        otherUserId,
        "cipher-1" as CipherId,
      );
    });

    it("redirects to the view of that account's cipher", async () => {
      cipherService.get.mockResolvedValue(storedCipher(true));

      const result = await runGuard(RestrictedCipherAction.Clone, params);

      expect(createUrlTree).toHaveBeenCalledWith(["/view-cipher"], {
        queryParams: { cipherId: "cipher-1", type: "1", userId: otherUserId },
      });
      expect(result).toBeInstanceOf(UrlTree);
    });

    it("reads no vault when that account does not serve autofill", async () => {
      isAutofillUser$.mockReturnValue(of(false));

      await expect(runGuard(RestrictedCipherAction.Edit, params)).resolves.toBe(true);

      expect(cipherService.get).not.toHaveBeenCalled();
      expect(revealedCipherService.getOrReveal).not.toHaveBeenCalled();
    });
  });
});
