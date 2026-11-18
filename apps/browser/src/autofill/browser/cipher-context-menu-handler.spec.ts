import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherRepromptType } from "@bitwarden/common/vault/enums/cipher-reprompt-type";

import { CipherUse } from "../services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../services/abstractions/multi-account-fill-cipher-policy";

import { CipherContextMenuHandler } from "./cipher-context-menu-handler";
import { MainContextMenuHandler } from "./main-context-menu-handler";

describe("CipherContextMenuHandler", () => {
  let mainContextMenuHandler: MockProxy<MainContextMenuHandler>;
  let autofillAccountsService: MockProxy<AutofillAccountsService>;
  // The accounts autofill serves. Empty while the active account is locked or logged out.
  let autofillUserIds$: BehaviorSubject<UserId[]>;
  let cipherService: MockProxy<CipherService>;
  let fillCipherPolicy: MockProxy<MultiAccountFillCipherPolicy>;

  const mockUserId = "UserId" as UserId;
  const otherUserId = "OtherUserId" as UserId;
  const accountService = mockAccountServiceWith(mockUserId);

  let sut: CipherContextMenuHandler;

  beforeEach(() => {
    mainContextMenuHandler = mock();
    mainContextMenuHandler.initRunning = false;
    autofillUserIds$ = new BehaviorSubject<UserId[]>([mockUserId]);
    autofillAccountsService = mock();
    (autofillAccountsService as any).autofillUserIds$ = autofillUserIds$;
    cipherService = mock();
    fillCipherPolicy = mock();

    jest.spyOn(MainContextMenuHandler, "removeAll").mockResolvedValue();

    sut = new CipherContextMenuHandler(
      mainContextMenuHandler,
      autofillAccountsService,
      cipherService,
      accountService,
      fillCipherPolicy,
    );
  });

  afterEach(() => jest.resetAllMocks());

  describe("update", () => {
    it("skips updating if the init process for the mainContextMenuHandler is running", async () => {
      mainContextMenuHandler.initRunning = true;

      await sut.update("https://test.com");

      expect(MainContextMenuHandler.removeAll).not.toHaveBeenCalled();
      expect(mainContextMenuHandler.noAccess).not.toHaveBeenCalled();
    });

    it("locked, updates for no access", async () => {
      autofillUserIds$.next([]);

      await sut.update("https://test.com");

      expect(mainContextMenuHandler.noAccess).toHaveBeenCalledTimes(1);
    });

    it("logged out, updates for no access", async () => {
      autofillUserIds$.next([]);

      await sut.update("https://test.com");

      expect(mainContextMenuHandler.noAccess).toHaveBeenCalledTimes(1);
    });

    it("has menu disabled, does not load anything", async () => {
      await sut.update("https://test.com");

      expect(mainContextMenuHandler.loadOptions).not.toHaveBeenCalled();

      expect(mainContextMenuHandler.noAccess).not.toHaveBeenCalled();

      expect(mainContextMenuHandler.noLogins).not.toHaveBeenCalled();
    });

    it("has no ciphers, add no ciphers item", async () => {
      mainContextMenuHandler.init.mockResolvedValue(true);

      fillCipherPolicy.ciphersForUrl.mockResolvedValue([]);

      await sut.update("https://test.com");

      expect(mainContextMenuHandler.noLogins).toHaveBeenCalledTimes(1);
    });

    it("only adds autofill ciphers including ciphers that require reprompt", async () => {
      mainContextMenuHandler.init.mockResolvedValue(true);

      const loginCipher = {
        id: "5",
        type: CipherType.Login,
        reprompt: CipherRepromptType.None,
        name: "Test Cipher",
        login: { username: "Test Username" },
      };

      const repromptLoginCipher = {
        id: "6",
        type: CipherType.Login,
        reprompt: CipherRepromptType.Password,
        name: "Test Reprompt Cipher",
        login: { username: "Test Username" },
      };

      const cardCipher = {
        id: "7",
        type: CipherType.Card,
        name: "Test Card Cipher",
        card: { username: "Test Username" },
      };

      fillCipherPolicy.ciphersForUrl.mockResolvedValue(
        [
          null, // invalid cipher
          undefined, // invalid cipher
          { type: CipherType.SecureNote }, // invalid cipher
          loginCipher, // valid cipher
          repromptLoginCipher,
          cardCipher, // valid cipher
        ].map((cipher) => ({ userId: mockUserId, cipher })) as any[],
      );

      await sut.update("https://test.com");

      expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledTimes(1);

      expect(fillCipherPolicy.ciphersForUrl).toHaveBeenCalledWith(
        "https://test.com",
        CipherUse.UserFill,
        { includeOtherTypes: [CipherType.Card, CipherType.Identity] },
      );

      expect(mainContextMenuHandler.loadOptions).toHaveBeenCalledTimes(3);

      expect(mainContextMenuHandler.loadOptions).toHaveBeenCalledWith(
        "Test Cipher (Test Username)",
        `${mockUserId}:5`,
        loginCipher,
        mockUserId,
      );

      expect(mainContextMenuHandler.loadOptions).toHaveBeenCalledWith(
        "Test Reprompt Cipher (Test Username)",
        `${mockUserId}:6`,
        repromptLoginCipher,
        mockUserId,
      );

      expect(mainContextMenuHandler.loadOptions).toHaveBeenCalledWith(
        "Test Card Cipher",
        `${mockUserId}:7`,
        cardCipher,
        mockUserId,
      );
    });

    describe("with two accounts serving autofill", () => {
      const login = (id: string, name: string) => ({
        id,
        type: CipherType.Login,
        reprompt: CipherRepromptType.None,
        name,
        login: { username: "user" },
      });

      beforeEach(() => {
        mainContextMenuHandler.init.mockResolvedValue(true);
        accountService.accountsSubject.next({
          [mockUserId]: { email: "personal@example.com" },
          [otherUserId]: { email: "work@example.com" },
        } as any);
        autofillUserIds$.next([mockUserId, otherUserId]);
      });

      it("lists the ciphers of both accounts, each named by its account and labelled with it", async () => {
        const personal = login("1", "Personal");
        const work = login("2", "Work");
        fillCipherPolicy.ciphersForUrl.mockResolvedValue([
          { userId: mockUserId, cipher: personal },
          { userId: otherUserId, cipher: work },
        ] as any[]);

        await sut.update("https://test.com");

        expect(mainContextMenuHandler.loadOptions).toHaveBeenCalledWith(
          "Personal (user) \u2014 personal@example.com",
          `${mockUserId}:1`,
          personal,
          mockUserId,
        );
        expect(mainContextMenuHandler.loadOptions).toHaveBeenCalledWith(
          "Work (user) \u2014 work@example.com",
          `${otherUserId}:2`,
          work,
          otherUserId,
        );
      });

      it("lists the same shared item once for each account, under distinct ids", async () => {
        const shared = login("shared", "Shared");
        fillCipherPolicy.ciphersForUrl.mockResolvedValue([
          { userId: mockUserId, cipher: shared },
          { userId: otherUserId, cipher: shared },
        ] as any[]);

        await sut.update("https://test.com");

        expect(mainContextMenuHandler.loadOptions.mock.calls.map((call) => call[1])).toEqual([
          `${mockUserId}:shared`,
          `${otherUserId}:shared`,
        ]);
      });

      it("drops the account label once one of them has locked", async () => {
        const personal = login("1", "Personal");
        autofillUserIds$.next([mockUserId]);
        fillCipherPolicy.ciphersForUrl.mockResolvedValue([
          { userId: mockUserId, cipher: personal },
        ] as any[]);

        await sut.update("https://test.com");

        expect(mainContextMenuHandler.loadOptions).toHaveBeenCalledTimes(1);
        expect(mainContextMenuHandler.loadOptions).toHaveBeenCalledWith(
          "Personal (user)",
          `${mockUserId}:1`,
          personal,
          mockUserId,
        );
      });

      it("offers to unlock once both have locked", async () => {
        autofillUserIds$.next([]);

        await sut.update("https://test.com");

        expect(mainContextMenuHandler.noAccess).toHaveBeenCalledTimes(1);
        expect(fillCipherPolicy.ciphersForUrl).not.toHaveBeenCalled();
      });
    });
  });
});
