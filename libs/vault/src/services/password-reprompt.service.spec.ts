import { MockProxy, mock } from "jest-mock-extended";
import { of } from "rxjs";

import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherRepromptType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { DialogRef, DialogService } from "@bitwarden/components";

import { PasswordRepromptComponent } from "../components/password-reprompt.component";

import { PasswordRepromptService } from "./password-reprompt.service";

describe("PasswordRepromptService", () => {
  let passwordRepromptService: PasswordRepromptService;

  let userVerificationService: MockProxy<UserVerificationService>;
  let dialogService: MockProxy<DialogService>;

  beforeEach(() => {
    dialogService = mock<DialogService>();
    userVerificationService = mock<UserVerificationService>();

    passwordRepromptService = new PasswordRepromptService(dialogService, userVerificationService);
  });

  describe("enabled()", () => {
    it("returns false if a user does not have a master password", async () => {
      userVerificationService.hasMasterPassword.mockResolvedValue(false);

      expect(await passwordRepromptService.enabled()).toBe(false);
    });
    it("returns true if the user has a master password", async () => {
      userVerificationService.hasMasterPassword.mockResolvedValue(true);

      expect(await passwordRepromptService.enabled()).toBe(true);
    });
  });

  describe("for a given account", () => {
    const userId = "other-user-id" as UserId;

    /** Only `userId` has a master password. */
    const onlyGivenAccountHasMasterPassword = () =>
      userVerificationService.hasMasterPassword.mockImplementation(async (id) => id === userId);

    const dialogClosesWith = (result: boolean | undefined) =>
      dialogService.open.mockReturnValue({ closed: of(result) } as DialogRef<boolean>);

    it("asks whether that account has a master password", async () => {
      onlyGivenAccountHasMasterPassword();

      await expect(passwordRepromptService.enabled(userId)).resolves.toBe(true);
      await expect(passwordRepromptService.enabled()).resolves.toBe(false);
    });

    it("opens the prompt for that account", async () => {
      onlyGivenAccountHasMasterPassword();
      dialogClosesWith(true);

      await expect(passwordRepromptService.showPasswordPrompt(userId)).resolves.toBe(true);

      expect(dialogService.open).toHaveBeenCalledWith(PasswordRepromptComponent, {
        ariaModal: true,
        data: { userId },
      });
    });

    it("reports a dismissed prompt as not verified", async () => {
      onlyGivenAccountHasMasterPassword();
      dialogClosesWith(undefined);

      await expect(passwordRepromptService.showPasswordPrompt(userId)).resolves.toBe(false);
    });

    it("does not prompt when that account has no master password", async () => {
      userVerificationService.hasMasterPassword.mockResolvedValue(false);

      await expect(passwordRepromptService.showPasswordPrompt(userId)).resolves.toBe(true);

      expect(userVerificationService.hasMasterPassword).toHaveBeenCalledWith(userId);
      expect(dialogService.open).not.toHaveBeenCalled();
    });

    it("prompts for the account of a cipher that requires it", async () => {
      onlyGivenAccountHasMasterPassword();
      dialogClosesWith(true);
      const cipher = { reprompt: CipherRepromptType.Password } as CipherView;

      await expect(passwordRepromptService.passwordRepromptCheck(cipher, userId)).resolves.toBe(
        true,
      );

      expect(dialogService.open).toHaveBeenCalledWith(PasswordRepromptComponent, {
        ariaModal: true,
        data: { userId },
      });
    });

    it("opens the prompt without an account for the active account", async () => {
      userVerificationService.hasMasterPassword.mockResolvedValue(true);
      dialogClosesWith(true);

      await passwordRepromptService.showPasswordPrompt();

      expect(dialogService.open).toHaveBeenCalledWith(PasswordRepromptComponent, {
        ariaModal: true,
        data: { userId: undefined },
      });
    });
  });
});
