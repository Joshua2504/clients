import { mock, MockProxy } from "jest-mock-extended";
import { firstValueFrom, of } from "rxjs";

import { mockAccountServiceWith } from "../../../../spec/fake-account-service";
import { FakeStateProvider } from "../../../../spec/fake-state-provider";
import { Utils } from "../../../platform/misc/utils";
import { UserId } from "../../../types/guid";
import { SHOW_AT_RISK_PASSWORD_NOTIFICATIONS } from "../key-state/vault-settings.state";
import { RestrictedItemTypesService } from "../restricted-item-types.service";

import { VaultSettingsService } from "./vault-settings.service";

describe("VaultSettingsService", () => {
  let service: VaultSettingsService;
  let stateProvider: FakeStateProvider;
  let restrictedItemTypesService: MockProxy<RestrictedItemTypesService>;

  const mockUserId = Utils.newGuid() as UserId;

  beforeEach(() => {
    const accountService = mockAccountServiceWith(mockUserId);
    stateProvider = new FakeStateProvider(accountService);

    restrictedItemTypesService = mock<RestrictedItemTypesService>();
    (restrictedItemTypesService as any).restricted$ = of([]);

    service = new VaultSettingsService(stateProvider, restrictedItemTypesService);
  });

  describe("showAtRiskPasswordNotifications$", () => {
    it("defaults to true when no value is stored", async () => {
      const result = await firstValueFrom(service.showAtRiskPasswordNotifications$);
      expect(result).toBe(true);
    });

    it("emits false after setShowAtRiskPasswordNotifications(false)", async () => {
      await service.setShowAtRiskPasswordNotifications(false);
      const result = await firstValueFrom(service.showAtRiskPasswordNotifications$);
      expect(result).toBe(false);
    });

    it("emits true after setShowAtRiskPasswordNotifications(true)", async () => {
      await service.setShowAtRiskPasswordNotifications(false);
      await service.setShowAtRiskPasswordNotifications(true);
      const result = await firstValueFrom(service.showAtRiskPasswordNotifications$);
      expect(result).toBe(true);
    });
  });

  describe("showAtRiskPasswordNotificationsFor$", () => {
    const otherUserId = "other-user-id" as UserId;

    it("defaults to true when the account stored no value", async () => {
      await expect(
        firstValueFrom(service.showAtRiskPasswordNotificationsFor$(otherUserId)),
      ).resolves.toBe(true);
    });

    it("emits the value of the given account, not of the active one", async () => {
      await service.setShowAtRiskPasswordNotifications(false);

      await expect(
        firstValueFrom(service.showAtRiskPasswordNotificationsFor$(otherUserId)),
      ).resolves.toBe(true);

      await stateProvider.setUserState(SHOW_AT_RISK_PASSWORD_NOTIFICATIONS, false, otherUserId);
      await service.setShowAtRiskPasswordNotifications(true);

      await expect(
        firstValueFrom(service.showAtRiskPasswordNotificationsFor$(otherUserId)),
      ).resolves.toBe(false);
    });
  });
});
