import { UserId } from "@bitwarden/common/types/guid";

import { defaultSaveAccount, showsAccountLabels } from "./save-target";

describe("save target", () => {
  const active = "active-user" as UserId;
  const other = "other-user" as UserId;
  const third = "third-user" as UserId;
  const candidate = { uri: "https://example.com", username: "frodo", password: "ring" };
  let canOfferSave: jest.Mock;

  beforeEach(() => {
    canOfferSave = jest.fn().mockResolvedValue(true);
  });

  describe("defaultSaveAccount", () => {
    it("is the active account while no account serves autofill, for the unlock prompt", async () => {
      await expect(defaultSaveAccount(candidate, [], active, { canOfferSave })).resolves.toBe(
        active,
      );
      expect(canOfferSave).not.toHaveBeenCalled();
    });

    it("is no account while none serves and none is active", async () => {
      await expect(defaultSaveAccount(candidate, [], null, { canOfferSave })).resolves.toBeNull();
    });

    it("is the active account while it alone serves, without asking its policy here", async () => {
      canOfferSave.mockResolvedValue(false);

      await expect(defaultSaveAccount(candidate, [active], active, { canOfferSave })).resolves.toBe(
        active,
      );
      expect(canOfferSave).not.toHaveBeenCalled();
    });

    it("is the active account while it serves and may save", async () => {
      await expect(
        defaultSaveAccount(candidate, [active, other], active, { canOfferSave }),
      ).resolves.toBe(active);
    });

    it("is the serving account while the active account is locked", async () => {
      await expect(defaultSaveAccount(candidate, [other], active, { canOfferSave })).resolves.toBe(
        other,
      );
      expect(canOfferSave).toHaveBeenCalledWith(candidate, other);
    });

    it("is the serving account while there is no active account", async () => {
      await expect(defaultSaveAccount(candidate, [other], null, { canOfferSave })).resolves.toBe(
        other,
      );
    });

    it("is the first serving account whose policy takes the login", async () => {
      canOfferSave.mockImplementation(async (_form, userId) => userId === third);

      await expect(
        defaultSaveAccount(candidate, [active, other, third], active, { canOfferSave }),
      ).resolves.toBe(third);
    });

    it("is no account when the only serving account, which is not active, may not save", async () => {
      canOfferSave.mockResolvedValue(false);

      await expect(
        defaultSaveAccount(candidate, [other], active, { canOfferSave }),
      ).resolves.toBeNull();
    });

    it("never falls back to the locked active account when no serving account may save", async () => {
      canOfferSave.mockResolvedValue(false);

      await expect(
        defaultSaveAccount(candidate, [other, third], active, { canOfferSave }),
      ).resolves.toBeNull();
      expect(canOfferSave).not.toHaveBeenCalledWith(candidate, active);
    });
  });

  describe("showsAccountLabels", () => {
    it("shows none while no account serves", () => {
      expect(showsAccountLabels([], active)).toBe(false);
    });

    it("shows none while the active account alone serves", () => {
      expect(showsAccountLabels([active], active)).toBe(false);
    });

    it("names the account when the only serving account is not the active one", () => {
      expect(showsAccountLabels([other], active)).toBe(true);
      expect(showsAccountLabels([other], null)).toBe(true);
    });

    it("names the accounts when several serve", () => {
      expect(showsAccountLabels([active, other], active)).toBe(true);
    });
  });
});
