import { BehaviorSubject, of } from "rxjs";

import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { UserId } from "@bitwarden/common/types/guid";

// This test skips all the initialization of the background script and just
// focuses on making sure we don't accidentally delete the initialization of
// background vault syncing. This has happened before!
describe("MainBackground sync task scheduling", () => {
  it("includes code to schedule the sync interval task", () => {
    // Get the bootstrap method source code as string
    const { default: MainBackground } = jest.requireActual("./main.background");
    const bootstrapSource = MainBackground.prototype.bootstrap.toString();

    // Check that the source includes the critical sync interval scheduling code
    expect(bootstrapSource).toContain("this.backgroundSyncService.init();");
    expect(bootstrapSource).toContain("this.syncAccountsUnlockedWhileNotActive();");
  });
});

// Runs the sync methods on a bare instance, without the background's initialization.
describe("MainBackground sync of all unlocked accounts", () => {
  const activeUser = "active" as UserId;
  const otherUser = "other" as UserId;
  const lockedUser = "locked" as UserId;
  const thirdUser = "third" as UserId;

  let authStatuses$: BehaviorSubject<Record<UserId, AuthenticationStatus>>;
  let lastSyncs: Record<UserId, Date | null>;
  let syncService: { getLastSync: jest.Mock; lastSync$: jest.Mock; fullSync: jest.Mock };
  let sut: any;

  const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    const { default: MainBackground } = jest.requireActual("./main.background");
    authStatuses$ = new BehaviorSubject({
      [activeUser]: AuthenticationStatus.Unlocked,
      [otherUser]: AuthenticationStatus.Unlocked,
      [lockedUser]: AuthenticationStatus.Locked,
      [thirdUser]: AuthenticationStatus.Unlocked,
    } as Record<UserId, AuthenticationStatus>);
    lastSyncs = { [activeUser]: null, [otherUser]: null, [lockedUser]: null, [thirdUser]: null };
    syncService = {
      getLastSync: jest.fn(async () => lastSyncs[activeUser]),
      lastSync$: jest.fn((userId: UserId) => of(lastSyncs[userId])),
      fullSync: jest.fn().mockResolvedValue(true),
    };
    sut = Object.create(MainBackground.prototype);
    sut.syncService = syncService;
    sut.accountService = { activeAccount$: of({ id: activeUser }) };
    sut.authService = { authStatuses$ };
    sut.logService = { error: jest.fn() };
  });

  it("syncs the active account first, then every other unlocked account in order", async () => {
    await sut.fullSync(false);

    expect(syncService.fullSync.mock.calls).toEqual([
      [false],
      [false, { userId: otherUser }],
      [false, { userId: thirdUser }],
    ]);
  });

  it("skips accounts whose last sync is recent unless the sync is forced", async () => {
    lastSyncs[activeUser] = new Date();
    lastSyncs[otherUser] = new Date();

    await sut.fullSync(false);
    expect(syncService.fullSync.mock.calls).toEqual([[false, { userId: thirdUser }]]);

    syncService.fullSync.mockClear();
    await sut.fullSync(true);
    expect(syncService.fullSync.mock.calls).toEqual([
      [true],
      [true, { userId: otherUser }],
      [true, { userId: thirdUser }],
    ]);
  });

  it("syncs only the active account when no other account is unlocked", async () => {
    authStatuses$.next({
      [activeUser]: AuthenticationStatus.Unlocked,
      [lockedUser]: AuthenticationStatus.Locked,
    } as Record<UserId, AuthenticationStatus>);

    await sut.fullSync(false);

    expect(syncService.fullSync.mock.calls).toEqual([[false]]);
  });

  it("syncs an account that becomes unlocked while not active", async () => {
    sut.syncAccountsUnlockedWhileNotActive();

    authStatuses$.next({
      ...authStatuses$.value,
      [lockedUser]: AuthenticationStatus.Unlocked,
    });
    await flushPromises();

    expect(syncService.fullSync.mock.calls).toEqual([[false, { userId: lockedUser }]]);
  });

  it("leaves the active account's unlock and newly added accounts to their own flows", async () => {
    authStatuses$.next({
      [activeUser]: AuthenticationStatus.Locked,
    } as Record<UserId, AuthenticationStatus>);
    sut.syncAccountsUnlockedWhileNotActive();

    authStatuses$.next({
      [activeUser]: AuthenticationStatus.Unlocked,
      [otherUser]: AuthenticationStatus.Unlocked,
    } as Record<UserId, AuthenticationStatus>);
    await flushPromises();

    expect(syncService.fullSync).not.toHaveBeenCalled();
  });
});

// Runs `logout` on a bare instance, without the background's initialization.
describe("MainBackground logout", () => {
  const activeUser = "active" as UserId;
  const otherUser = "other" as UserId;

  let sut: any;
  let send: jest.Mock;

  beforeEach(() => {
    const { default: MainBackground } = jest.requireActual("./main.background");
    const { BrowserApi } = jest.requireActual("../platform/browser/browser-api");
    jest.spyOn(BrowserApi, "isManifestVersion").mockReturnValue(false);

    const clear = () => jest.fn().mockResolvedValue(undefined);
    send = jest.fn();
    sut = Object.create(MainBackground.prototype);
    sut.accountService = {
      activeAccount$: of({ id: activeUser }),
      nextUpAccount$: of({ id: otherUser }),
      clean: clear(),
    };
    sut.authService = { authStatusFor$: jest.fn(() => of(AuthenticationStatus.LoggedOut)) };
    sut.eventUploadService = { uploadEvents: clear() };
    sut.cipherService = { clear: clear() };
    sut.folderService = { clear: clear() };
    sut.biometricStateService = { logout: clear() };
    sut.popupViewCacheBackgroundService = { clearState: clear() };
    sut.pinService = { logout: clear() };
    sut.keyService = { clearKeys: clear() };
    sut.vaultTimeoutSettingsService = { getVaultTimeoutByUserId$: jest.fn(() => of("never")) };
    sut.stateService = { clean: clear() };
    sut.tokenService = { clearTokens: clear() };
    sut.stateEventRunnerService = { handleEvent: clear() };
    sut.messagingService = { send };
    sut.mainContextMenuHandler = { noAccess: clear() };
    sut.systemService = { clearPendingClipboard: clear() };
    sut.processReloadService = { reloadProcess: clear() };
    sut.switchAccount = clear();
    sut.refreshMenu = clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("switches to the next account when the active account is logged out", async () => {
    await sut.logout("userInitiated", activeUser);

    expect(sut.switchAccount).toHaveBeenCalledWith(otherUser);
    expect(sut.cipherService.clear).toHaveBeenCalledWith(activeUser);
    expect(send).toHaveBeenCalledWith("doneLoggingOut", {
      logoutReason: "userInitiated",
      userId: activeUser,
      loggedOutActiveAccount: true,
    });
    expect(sut.mainContextMenuHandler.noAccess).toHaveBeenCalled();
    expect(sut.refreshMenu).not.toHaveBeenCalled();
  });

  it("logs out the active account when no account is named", async () => {
    await sut.logout("userInitiated");

    expect(sut.switchAccount).toHaveBeenCalledWith(otherUser);
    expect(sut.accountService.clean).toHaveBeenCalledWith(activeUser);
  });

  it("leaves the active account where it is when another account is logged out", async () => {
    await sut.logout("invalidSecurityStamp", otherUser);

    expect(sut.switchAccount).not.toHaveBeenCalled();
    expect(sut.eventUploadService.uploadEvents).toHaveBeenCalledWith(otherUser);
    expect(sut.cipherService.clear).toHaveBeenCalledWith(otherUser);
    expect(sut.keyService.clearKeys).toHaveBeenCalledWith(otherUser);
    expect(sut.tokenService.clearTokens).toHaveBeenCalledWith(otherUser);
    expect(sut.accountService.clean).toHaveBeenCalledWith(otherUser);
    expect(sut.stateEventRunnerService.handleEvent).toHaveBeenCalledWith("logout", otherUser);
    expect(send).toHaveBeenCalledWith("doneLoggingOut", {
      logoutReason: "invalidSecurityStamp",
      userId: otherUser,
      loggedOutActiveAccount: false,
    });
    // The context menu keeps serving the active account.
    expect(sut.mainContextMenuHandler.noAccess).not.toHaveBeenCalled();
    expect(sut.refreshMenu).toHaveBeenCalled();
  });
});
