import { mock } from "jest-mock-extended";
import { of } from "rxjs";

import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { BitIconButtonComponent, MenuItemComponent } from "@bitwarden/components";

import { CopyCipherFieldService } from "..";
import { CipherAccountContext } from "../services/cipher-account-context";

import { CopyCipherFieldDirective } from "./copy-cipher-field.directive";

describe("CopyCipherFieldDirective", () => {
  const copyFieldService = {
    copy: jest.fn().mockResolvedValue(null),
    totpAllowed: jest.fn().mockResolvedValue(true),
  };
  let mockAccountService: AccountService;
  let mockCipherService: CipherService;

  let copyCipherFieldDirective: CopyCipherFieldDirective;

  beforeEach(() => {
    copyFieldService.copy.mockClear();
    copyFieldService.totpAllowed.mockClear();
    mockAccountService = mock<AccountService>();
    mockAccountService.activeAccount$ = of({ id: "test-account-id" } as Account);
    mockCipherService = mock<CipherService>();

    copyCipherFieldDirective = new CopyCipherFieldDirective(
      copyFieldService as unknown as CopyCipherFieldService,
      mockAccountService,
      mockCipherService,
    );
    copyCipherFieldDirective.cipher = new CipherView();
    copyCipherFieldDirective.cipher.type = CipherType.Login;
  });

  describe("disabled state", () => {
    it("should be enabled when the field is available", async () => {
      copyCipherFieldDirective.action = "username";
      (copyCipherFieldDirective.cipher as CipherView).login.username = "test-username";

      await copyCipherFieldDirective.ngOnChanges();

      expect(copyCipherFieldDirective["hostDisabled"]).toBe(null);
    });

    it("should be disabled when the field is not available", async () => {
      // create empty cipher
      copyCipherFieldDirective.cipher = new CipherView();
      copyCipherFieldDirective.cipher.type = CipherType.Login;

      copyCipherFieldDirective.action = "username";

      await copyCipherFieldDirective.ngOnChanges();

      expect(copyCipherFieldDirective["hostDisabled"]).toBe(true);
    });

    it("should be disabled when externally disabled even if the field is available", async () => {
      copyCipherFieldDirective.action = "username";
      (copyCipherFieldDirective.cipher as CipherView).login.username = "test-username";
      copyCipherFieldDirective.disabled = true;

      await copyCipherFieldDirective.ngOnChanges();

      expect(copyCipherFieldDirective["hostDisabled"]).toBe(true);
    });

    it("stays disabled for an unavailable field when the external disabled state is toggled off", async () => {
      // Empty cipher, so the field has no value to copy.
      copyCipherFieldDirective.cipher = new CipherView();
      copyCipherFieldDirective.cipher.type = CipherType.Login;
      copyCipherFieldDirective.action = "username";

      // Simulate a list refresh toggling the external disabled state true -> false.
      copyCipherFieldDirective.disabled = true;
      await copyCipherFieldDirective.ngOnChanges();
      copyCipherFieldDirective.disabled = false;
      await copyCipherFieldDirective.ngOnChanges();

      expect(copyCipherFieldDirective["hostDisabled"]).toBe(true);
    });

    it("updates icon button disabled state", async () => {
      const iconButton = {
        disabled: {
          set: jest.fn(),
        },
      };

      copyCipherFieldDirective = new CopyCipherFieldDirective(
        copyFieldService as unknown as CopyCipherFieldService,
        mockAccountService,
        mockCipherService,
        undefined,
        iconButton as unknown as BitIconButtonComponent,
      );

      copyCipherFieldDirective.action = "password";
      copyCipherFieldDirective.cipher = new CipherView();
      copyCipherFieldDirective.cipher.type = CipherType.Login;

      await copyCipherFieldDirective.ngOnChanges();

      expect(iconButton.disabled.set).toHaveBeenCalledWith(true);
    });

    it("updates menuItemDirective disabled state", async () => {
      const menuItemComponent = {
        disabled: false,
      };

      copyCipherFieldDirective = new CopyCipherFieldDirective(
        copyFieldService as unknown as CopyCipherFieldService,
        mockAccountService,
        mockCipherService,
        menuItemComponent as unknown as MenuItemComponent,
      );

      copyCipherFieldDirective.action = "totp";

      await copyCipherFieldDirective.ngOnChanges();

      expect(menuItemComponent.disabled).toBe(true);
    });
  });

  describe("copy guard", () => {
    it("does not copy when the field has no value", async () => {
      copyCipherFieldDirective.cipher = new CipherView();
      copyCipherFieldDirective.cipher.type = CipherType.Login;
      copyCipherFieldDirective.action = "username";

      await copyCipherFieldDirective.ngOnChanges();
      await copyCipherFieldDirective.copy();

      expect(copyFieldService.copy).not.toHaveBeenCalled();
    });

    it("does not copy when externally disabled", async () => {
      copyCipherFieldDirective.action = "username";
      (copyCipherFieldDirective.cipher as CipherView).login.username = "test-username";
      copyCipherFieldDirective.disabled = true;

      await copyCipherFieldDirective.ngOnChanges();
      await copyCipherFieldDirective.copy();

      expect(copyFieldService.copy).not.toHaveBeenCalled();
    });
  });

  describe("login", () => {
    beforeEach(() => {
      const cipher = copyCipherFieldDirective.cipher as CipherView;
      cipher.type = CipherType.Login;
      cipher.login.username = "test-username";
      cipher.login.password = "test-password";
      cipher.login.totp = "test-totp";
    });

    it.each([
      ["username", "test-username"],
      ["password", "test-password"],
      ["totp", "test-totp"],
    ])("copies %s field from login to clipboard", async (action, value) => {
      copyCipherFieldDirective.action = action as CopyCipherFieldDirective["action"];

      await copyCipherFieldDirective.copy();

      expect(copyFieldService.copy).toHaveBeenCalledWith(
        value,
        action,
        copyCipherFieldDirective.cipher,
        false,
        undefined,
      );
    });
  });

  describe("identity", () => {
    beforeEach(() => {
      const cipher = copyCipherFieldDirective.cipher as CipherView;
      cipher.type = CipherType.Identity;
      cipher.identity.username = "test-username";
      cipher.identity.email = "test-email";
      cipher.identity.phone = "test-phone";
      cipher.identity.address1 = "test-address-1";
    });

    it.each([
      ["username", "test-username"],
      ["email", "test-email"],
      ["phone", "test-phone"],
      ["address", "test-address-1"],
    ])("copies %s field from identity to clipboard", async (action, value) => {
      copyCipherFieldDirective.action = action as CopyCipherFieldDirective["action"];

      await copyCipherFieldDirective.copy();

      expect(copyFieldService.copy).toHaveBeenCalledWith(
        value,
        action,
        copyCipherFieldDirective.cipher,
        false,
        undefined,
      );
    });
  });

  describe("card", () => {
    beforeEach(() => {
      const cipher = copyCipherFieldDirective.cipher as CipherView;
      cipher.type = CipherType.Card;
      cipher.card.number = "test-card-number";
      cipher.card.code = "test-card-code";
    });

    it.each([
      ["cardNumber", "test-card-number"],
      ["securityCode", "test-card-code"],
    ])("copies %s field from card to clipboard", async (action, value) => {
      copyCipherFieldDirective.action = action as CopyCipherFieldDirective["action"];

      await copyCipherFieldDirective.copy();

      expect(copyFieldService.copy).toHaveBeenCalledWith(
        value,
        action,
        copyCipherFieldDirective.cipher,
        false,
        undefined,
      );
    });
  });

  describe("secure note", () => {
    beforeEach(() => {
      const cipher = copyCipherFieldDirective.cipher as CipherView;
      cipher.type = CipherType.SecureNote;
      cipher.notes = "test-secure-note";
    });

    it("copies secure note field to clipboard", async () => {
      copyCipherFieldDirective.action = "secureNote";

      await copyCipherFieldDirective.copy();

      expect(copyFieldService.copy).toHaveBeenCalledWith(
        "test-secure-note",
        "secureNote",
        copyCipherFieldDirective.cipher,
        false,
        undefined,
      );
    });
  });

  describe("ssh key", () => {
    beforeEach(() => {
      const cipher = copyCipherFieldDirective.cipher as CipherView;
      cipher.type = CipherType.SshKey;
      cipher.sshKey.privateKey = "test-private-key";
      cipher.sshKey.publicKey = "test-public-key";
      cipher.sshKey.keyFingerprint = "test-key-fingerprint";
    });

    it.each([
      ["privateKey", "test-private-key"],
      ["publicKey", "test-public-key"],
      ["keyFingerprint", "test-key-fingerprint"],
    ])("copies %s field from ssh key to clipboard", async (action, value) => {
      copyCipherFieldDirective.action = action as CopyCipherFieldDirective["action"];

      await copyCipherFieldDirective.copy();

      expect(copyFieldService.copy).toHaveBeenCalledWith(
        value,
        action,
        copyCipherFieldDirective.cipher,
        false,
        undefined,
      );
    });
  });

  describe("bank account", () => {
    beforeEach(() => {
      const cipher = copyCipherFieldDirective.cipher as CipherView;
      cipher.type = CipherType.BankAccount;
      cipher.bankAccount.accountNumber = "test-account-number";
      cipher.bankAccount.routingNumber = "test-routing-number";
      cipher.bankAccount.pin = "test-pin";
      cipher.bankAccount.iban = "test-iban";
    });

    it.each([
      ["accountNumber", "test-account-number"],
      ["routingNumber", "test-routing-number"],
      ["pin", "test-pin"],
      ["iban", "test-iban"],
    ])("copies %s field from bank account to clipboard", async (action, value) => {
      copyCipherFieldDirective.action = action as CopyCipherFieldDirective["action"];

      await copyCipherFieldDirective.copy();

      expect(copyFieldService.copy).toHaveBeenCalledWith(
        value,
        action,
        copyCipherFieldDirective.cipher,
        false,
        undefined,
      );
    });
  });

  describe("for the account that owns the cipher", () => {
    const otherUserId = "other-account-id" as UserId;

    const directiveIn = (context?: CipherAccountContext) => {
      const directive = new CopyCipherFieldDirective(
        copyFieldService as unknown as CopyCipherFieldService,
        mockAccountService,
        mockCipherService,
        undefined,
        undefined,
        context,
      );
      directive.cipher = new CipherView();
      directive.cipher.type = CipherType.Login;
      (directive.cipher as CipherView).login.username = "test-username";
      (directive.cipher as CipherView).login.totp = "test-totp";
      directive.action = "username";
      return directive;
    };

    const contextOf = (userId: UserId | undefined) =>
      ({ explicitUserId: () => userId }) as unknown as CipherAccountContext;

    it("copies for the account given as input", async () => {
      const directive = directiveIn();
      directive.userId = otherUserId;

      await directive.copy();

      expect(copyFieldService.copy).toHaveBeenCalledWith(
        "test-username",
        "username",
        directive.cipher,
        false,
        otherUserId,
      );
    });

    it("copies for the account of the surrounding context", async () => {
      const directive = directiveIn(contextOf(otherUserId));

      await directive.copy();

      expect(copyFieldService.copy).toHaveBeenCalledWith(
        "test-username",
        "username",
        directive.cipher,
        false,
        otherUserId,
      );
    });

    it("prefers the input over the surrounding context", async () => {
      const directive = directiveIn(contextOf("context-account-id" as UserId));
      directive.userId = otherUserId;

      await directive.copy();

      expect(copyFieldService.copy).toHaveBeenCalledWith(
        "test-username",
        "username",
        directive.cipher,
        false,
        otherUserId,
      );
    });

    it("decides on TOTP with that account", async () => {
      const directive = directiveIn(contextOf(otherUserId));
      directive.action = "totp";

      await directive.ngOnChanges();

      expect(copyFieldService.totpAllowed).toHaveBeenCalledWith(directive.cipher, otherUserId);
    });

    it("decrypts a list view from that account's vault", async () => {
      const directive = directiveIn(contextOf(otherUserId));
      const listView = {
        id: "cipher-id",
        type: { login: {} },
        copyableFields: ["LoginUsername"],
      } as unknown as CipherViewLike;
      directive.cipher = listView;
      const fullCipher = new CipherView();
      fullCipher.login.username = "from-other-vault";
      (mockCipherService.get as jest.Mock).mockResolvedValue({ id: "cipher-id" });
      (mockCipherService.decrypt as jest.Mock).mockResolvedValue(fullCipher);

      await directive.copy();

      expect(mockCipherService.get).toHaveBeenCalledWith("cipher-id", otherUserId);
      expect(mockCipherService.decrypt).toHaveBeenCalledWith({ id: "cipher-id" }, otherUserId);
      expect(copyFieldService.copy).toHaveBeenCalledWith(
        "from-other-vault",
        "username",
        listView,
        false,
        otherUserId,
      );
    });

    it("decrypts a list view from the active account's vault without an account", async () => {
      const directive = directiveIn(contextOf(undefined));
      directive.cipher = {
        id: "cipher-id",
        type: { login: {} },
        copyableFields: ["LoginUsername"],
      } as unknown as CipherViewLike;
      (mockCipherService.get as jest.Mock).mockResolvedValue({ id: "cipher-id" });
      (mockCipherService.decrypt as jest.Mock).mockResolvedValue(new CipherView());

      await directive.copy();

      expect(mockCipherService.get).toHaveBeenCalledWith("cipher-id", "test-account-id");
    });
  });
});
