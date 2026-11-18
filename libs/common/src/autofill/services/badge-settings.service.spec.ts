import { firstValueFrom } from "rxjs";

import { FakeAccountService, FakeStateProvider, mockAccountServiceWith } from "../../../spec";
import { BADGE_SETTINGS_DISK, UserKeyDefinition } from "../../platform/state";
import { UserId } from "../../types/guid";

import { BadgeSettingsService } from "./badge-settings.service";

describe("BadgeSettingsService", () => {
  const activeUserId = "active-user" as UserId;
  const otherUserId = "other-user" as UserId;
  // Same location as the service's own definition.
  const ENABLE_BADGE_COUNTER = new UserKeyDefinition<boolean>(
    BADGE_SETTINGS_DISK,
    "enableBadgeCounter",
    { deserializer: (value) => value, clearOn: [] },
  );

  let accountService: FakeAccountService;
  let stateProvider: FakeStateProvider;
  let service: BadgeSettingsService;

  beforeEach(() => {
    accountService = mockAccountServiceWith(activeUserId);
    stateProvider = new FakeStateProvider(accountService);
    service = new BadgeSettingsService(stateProvider);
  });

  it("defaults to enabled for a user that never set it", async () => {
    expect(await firstValueFrom(service.enableBadgeCounterFor$(otherUserId))).toBe(true);
  });

  it("reads the setting of the given user, not of the active user", async () => {
    await stateProvider.setUserState(ENABLE_BADGE_COUNTER, false, otherUserId);

    expect(await firstValueFrom(service.enableBadgeCounterFor$(otherUserId))).toBe(false);
    expect(await firstValueFrom(service.enableBadgeCounterFor$(activeUserId))).toBe(true);
    expect(await firstValueFrom(service.enableBadgeCounter$)).toBe(true);
  });
});
