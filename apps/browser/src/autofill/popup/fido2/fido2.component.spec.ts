import { ActivatedRoute, convertToParamMap, Router } from "@angular/router";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom, of, Subject } from "rxjs";

import { AccountInfo, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { DomainSettingsService } from "@bitwarden/common/autofill/services/domain-settings.service";
import { AccountCipher } from "@bitwarden/common/autofill/types/account-cipher";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { SearchService } from "@bitwarden/common/vault/abstractions/search.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherRepromptType } from "@bitwarden/common/vault/enums/cipher-reprompt-type";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { LoginUriView } from "@bitwarden/common/vault/models/view/login-uri.view";
import { LoginView } from "@bitwarden/common/vault/models/view/login.view";
import { DialogService } from "@bitwarden/components";
import { PasswordRepromptService } from "@bitwarden/vault";

import { ZonedMessageListenerService } from "../../../platform/browser/zoned-message-listener.service";
import { BrowserRouterService } from "../../../platform/popup/services/browser-router.service";
import {
  BrowserFido2Message,
  BrowserFido2MessageTypes,
  BrowserFido2UserInterfaceSession,
} from "../../fido2/services/browser-fido2-user-interface.service";
import { CipherUse } from "../../services/abstractions/fill-cipher-policy";
import { MultiAccountFillCipherPolicy } from "../../services/abstractions/multi-account-fill-cipher-policy";

import { Fido2Component } from "./fido2.component";

describe("Fido2Component", () => {
  const sessionId = "session";
  const url = "https://example.com/login";
  const activeUserId = "active-user" as UserId;
  const otherUserId = "other-user" as UserId;

  let messages$: Subject<BrowserFido2Message>;
  let servedUserIds$: BehaviorSubject<UserId[]>;
  let vaults: Map<UserId, CipherView[]>;
  let router: MockProxy<Router>;
  let cipherService: MockProxy<CipherService>;
  let domainSettingsService: MockProxy<DomainSettingsService>;
  let searchService: MockProxy<SearchService>;
  let dialogService: MockProxy<DialogService>;
  let passwordRepromptService: MockProxy<PasswordRepromptService>;
  let multiAccountFillCipherPolicy: MockProxy<MultiAccountFillCipherPolicy>;
  let routerService: MockProxy<BrowserRouterService>;
  let authStatuses: Map<UserId, AuthenticationStatus>;
  let createComponent: (queryParams?: Record<string, string>) => void;
  let sendMessage: jest.SpyInstance;
  let windowClose: jest.SpyInstance;
  let component: Fido2Component;

  /** What the component shows, read as the template reads it. */
  const view = () =>
    component as unknown as {
      accounts: { userId: UserId; label: string }[];
      canAddCipher: boolean;
      displayedCiphers: AccountCipher[];
      loading: boolean;
      lockedAccounts: { userId: UserId; label: string }[];
      showAccountLabels: boolean;
      targetUserId: UserId | null;
      accountLabel(userId: UserId): string;
      saveNewLogin(): Promise<void>;
      selectTargetAccount(userId: UserId): Promise<void>;
      unlockAccount(userId: UserId): Promise<void>;
    };

  /** The messages the component sent to the background, without the connect announcement. */
  const sent = () =>
    sendMessage.mock.calls
      .map(([message]) => message as BrowserFido2Message)
      .filter((message) => message.type !== BrowserFido2MessageTypes.ConnectResponse);

  /** Delivers `message` from the background and waits until the component shows it. */
  const receive = async (message: Record<string, unknown>) => {
    const shown = firstValueFrom(component["data$"]);
    messages$.next({ sessionId, ...message } as BrowserFido2Message);
    await shown;
  };

  const accountCiphers = () =>
    [...vaults.entries()]
      .filter(([userId]) => servedUserIds$.value.includes(userId))
      .flatMap(([userId, ciphers]) => ciphers.map((cipher) => ({ userId, cipher })));

  beforeEach(() => {
    messages$ = new Subject();
    servedUserIds$ = new BehaviorSubject([activeUserId, otherUserId]);
    vaults = new Map([
      [activeUserId, []],
      [otherUserId, []],
    ]);

    router = mock<Router>();
    cipherService = mock<CipherService>();
    domainSettingsService = mock<DomainSettingsService>();
    domainSettingsService.getUrlEquivalentDomains.mockReturnValue(of(new Set<string>()));
    searchService = mock<SearchService>();
    dialogService = mock<DialogService>();
    passwordRepromptService = mock<PasswordRepromptService>();
    routerService = mock<BrowserRouterService>();
    router.createUrlTree.mockImplementation(
      (commands, extras) => ({ commands, queryParams: extras?.queryParams }) as any,
    );
    router.serializeUrl.mockImplementation((tree: any) => {
      return `${tree.commands.join("/")}?${new URLSearchParams(tree.queryParams).toString()}`;
    });
    authStatuses = new Map([
      [activeUserId, AuthenticationStatus.Unlocked],
      [otherUserId, AuthenticationStatus.Unlocked],
    ]);
    const authService = mock<AuthService>();
    authService.authStatusFor$.mockImplementation((userId) => of(authStatuses.get(userId)!));

    multiAccountFillCipherPolicy = mock<MultiAccountFillCipherPolicy>();
    multiAccountFillCipherPolicy.ciphers.mockImplementation(async () => accountCiphers());
    multiAccountFillCipherPolicy.ciphersForRefs.mockImplementation(async (refs) =>
      refs.flatMap((ref) =>
        accountCiphers().filter(
          (item) => item.userId === ref.userId && item.cipher.id === ref.cipherId,
        ),
      ),
    );

    const accountService = mock<AccountService>();
    accountService.activeAccount$ = of({ id: activeUserId, email: "active@example.com" } as any);
    accountService.accounts$ = of({
      [activeUserId]: { email: "active@example.com" },
      [otherUserId]: { email: "other@example.com" },
    } as Record<UserId, AccountInfo>);

    const autofillAccountsService = mock<AutofillAccountsService>();
    Object.defineProperty(autofillAccountsService, "autofillUserIds$", { value: servedUserIds$ });
    autofillAccountsService.isAutofillUser$.mockImplementation((userId) =>
      of(servedUserIds$.value.includes(userId)),
    );

    sendMessage = jest
      .spyOn(BrowserFido2UserInterfaceSession, "sendMessage")
      .mockImplementation(() => undefined);
    windowClose = jest.spyOn(window, "close").mockImplementation(() => undefined);

    createComponent = (extraQueryParams = {}) => {
      const queryParams = { sessionId, senderTabId: "7", senderUrl: url, ...extraQueryParams };
      component = new Fido2Component(
        router,
        {
          queryParamMap: of(convertToParamMap(queryParams)),
          snapshot: { queryParams },
        } as unknown as ActivatedRoute,
        cipherService,
        mock<PlatformUtilsService>(),
        domainSettingsService,
        searchService,
        mock<LogService>(),
        dialogService,
        { messageListener$: () => messages$ } as unknown as ZonedMessageListenerService,
        passwordRepromptService,
        accountService,
        multiAccountFillCipherPolicy,
        autofillAccountsService,
        authService,
        routerService,
      );
      component.ngOnInit();
    };
    createComponent();
  });

  afterEach(() => {
    component.ngOnDestroy();
    jest.restoreAllMocks();
  });

  describe("picking a passkey to log in with", () => {
    let activeCipher: CipherView;
    let otherCipher: CipherView;

    const pickRequest = (ciphers: AccountCipher[]) => ({
      type: BrowserFido2MessageTypes.PickCredentialRequest,
      cipherRefs: ciphers.map(({ userId, cipher }) => ({ userId, cipherId: cipher.id })),
      userVerification: false,
      fallbackSupported: false,
    });

    beforeEach(() => {
      activeCipher = createLogin("cipher-a");
      otherCipher = createLogin("cipher-b");
      vaults.set(activeUserId, [activeCipher]);
      vaults.set(otherUserId, [otherCipher]);
    });

    it("lists the passkeys of both accounts, each named with its account", async () => {
      await receive(pickRequest(accountCiphers()));

      expect(multiAccountFillCipherPolicy.ciphersForRefs).toHaveBeenCalledWith(
        [
          { userId: activeUserId, cipherId: "cipher-a" },
          { userId: otherUserId, cipherId: "cipher-b" },
        ],
        CipherUse.Passkey,
      );
      expect(view().displayedCiphers).toEqual([
        { userId: activeUserId, cipher: activeCipher },
        { userId: otherUserId, cipher: otherCipher },
      ]);
      expect(view().showAccountLabels).toBe(true);
      expect(view().accountLabel(otherUserId)).toBe("other@example.com");
    });

    it("does not name the account while one account serves", async () => {
      servedUserIds$.next([activeUserId]);

      await receive(pickRequest([{ userId: activeUserId, cipher: activeCipher }]));

      expect(view().displayedCiphers).toEqual([{ userId: activeUserId, cipher: activeCipher }]);
      expect(view().showAccountLabels).toBe(false);
    });

    it("answers with the account of the chosen passkey", async () => {
      await receive(pickRequest(accountCiphers()));

      await component.handleCipherItemSelect(view().displayedCiphers[1]);

      expect(sent()).toEqual([
        {
          sessionId,
          type: BrowserFido2MessageTypes.PickCredentialResponse,
          userId: otherUserId,
          cipherId: "cipher-b",
          userVerified: false,
        },
      ]);
    });

    it("lists the same shared item once per account and answers with the chosen account", async () => {
      const sharedInActive = createLogin("shared");
      const sharedInOther = createLogin("shared");
      vaults.set(activeUserId, [sharedInActive]);
      vaults.set(otherUserId, [sharedInOther]);
      await receive(pickRequest(accountCiphers()));

      expect(view().displayedCiphers).toHaveLength(2);
      await component.handleCipherItemSelect(view().displayedCiphers[1]);

      expect(sent()).toEqual([
        expect.objectContaining({ userId: otherUserId, cipherId: "shared" }),
      ]);
    });

    it("asks for the master password of the active account for its own passkey", async () => {
      activeCipher.reprompt = CipherRepromptType.Password;
      passwordRepromptService.showPasswordPrompt.mockResolvedValue(true);
      await receive(pickRequest(accountCiphers()));

      await component.handleCipherItemSelect(view().displayedCiphers[0]);

      expect(passwordRepromptService.showPasswordPrompt).toHaveBeenCalledTimes(1);
      expect(passwordRepromptService.showPasswordPrompt).toHaveBeenCalledWith(activeUserId);
      expect(sent()).toEqual([
        expect.objectContaining({ userId: activeUserId, userVerified: true }),
      ]);
    });

    it("asks for the master password of the account that owns the passkey", async () => {
      otherCipher.reprompt = CipherRepromptType.Password;
      passwordRepromptService.showPasswordPrompt.mockResolvedValue(true);
      await receive(pickRequest(accountCiphers()));

      await component.handleCipherItemSelect(view().displayedCiphers[1]);

      expect(passwordRepromptService.showPasswordPrompt).toHaveBeenCalledTimes(1);
      expect(passwordRepromptService.showPasswordPrompt).toHaveBeenCalledWith(otherUserId);
      expect(sent()).toEqual([
        expect.objectContaining({ userId: otherUserId, userVerified: true }),
      ]);
    });

    it("reports the user as not verified when the owning account's reprompt is dismissed", async () => {
      otherCipher.reprompt = CipherRepromptType.Password;
      passwordRepromptService.showPasswordPrompt.mockResolvedValue(false);
      await receive(pickRequest(accountCiphers()));

      await component.handleCipherItemSelect(view().displayedCiphers[1]);

      expect(sent()).toEqual([
        expect.objectContaining({ userId: otherUserId, userVerified: false }),
      ]);
    });

    it("does not ask for a master password for a passkey without a reprompt", async () => {
      await receive(pickRequest(accountCiphers()));

      await component.handleCipherItemSelect(view().displayedCiphers[1]);

      expect(passwordRepromptService.showPasswordPrompt).not.toHaveBeenCalled();
    });

    it("aborts when the account of the chosen passkey locked meanwhile", async () => {
      await receive(pickRequest(accountCiphers()));
      const chosen = view().displayedCiphers[1];
      servedUserIds$.next([activeUserId]);

      await component.handleCipherItemSelect(chosen);

      expect(sent()).toEqual([
        { sessionId, type: BrowserFido2MessageTypes.AbortResponse, fallbackRequested: false },
      ]);
      expect(windowClose).toHaveBeenCalled();
    });
  });

  describe("an excluded passkey", () => {
    it("shows the passkey of the non-active account, named with its account", async () => {
      const excluded = createLogin("cipher-b");
      vaults.set(otherUserId, [excluded]);

      await receive({
        type: BrowserFido2MessageTypes.InformExcludedCredentialRequest,
        existingCipherRefs: [{ userId: otherUserId, cipherId: "cipher-b" }],
        fallbackSupported: false,
      });

      expect(view().displayedCiphers).toEqual([{ userId: otherUserId, cipher: excluded }]);
      expect(view().showAccountLabels).toBe(true);
    });
  });

  describe("saving a new passkey", () => {
    let activeLogin: CipherView;
    let otherLogin: CipherView;

    const confirmRequest = (userIds: UserId[]) => ({
      type: BrowserFido2MessageTypes.ConfirmNewCredentialRequest,
      credentialName: "Example",
      userName: "jane",
      userHandle: "handle",
      userVerification: false,
      fallbackSupported: false,
      rpId: "example.com",
      userIds,
    });

    beforeEach(() => {
      activeLogin = createLogin("login-a");
      otherLogin = createLogin("login-b");
      vaults.set(activeUserId, [activeLogin]);
      vaults.set(otherUserId, [otherLogin]);
    });

    it("saves to the active account by default and lists its logins", async () => {
      await receive(confirmRequest([activeUserId, otherUserId]));

      expect(view().accounts).toEqual([
        { userId: activeUserId, label: "active@example.com" },
        { userId: otherUserId, label: "other@example.com" },
      ]);
      expect(view().targetUserId).toBe(activeUserId);
      expect(view().displayedCiphers).toEqual([{ userId: activeUserId, cipher: activeLogin }]);
      expect(view().canAddCipher).toBe(true);
    });

    it("offers no choice while one account serves", async () => {
      servedUserIds$.next([activeUserId]);

      await receive(confirmRequest([activeUserId]));

      expect(view().accounts).toHaveLength(1);
      expect(view().targetUserId).toBe(activeUserId);
      expect(view().canAddCipher).toBe(true);
    });

    it("lists the logins of the account the user chose", async () => {
      await receive(confirmRequest([activeUserId, otherUserId]));

      await view().selectTargetAccount(otherUserId);

      expect(view().targetUserId).toBe(otherUserId);
      expect(view().displayedCiphers).toEqual([{ userId: otherUserId, cipher: otherLogin }]);
      expect(domainSettingsService.getUrlEquivalentDomains).toHaveBeenLastCalledWith(
        url,
        otherUserId,
      );
      // The item form is opened for the chosen account
      expect(view().canAddCipher).toBe(true);
    });

    it("ignores an account that was not offered", async () => {
      await receive(confirmRequest([activeUserId]));

      await view().selectTargetAccount(otherUserId);

      expect(view().targetUserId).toBe(activeUserId);
    });

    it("answers with the chosen account when a login of it is selected", async () => {
      await receive(confirmRequest([activeUserId, otherUserId]));
      await view().selectTargetAccount(otherUserId);

      await component.handleCipherItemSelect(view().displayedCiphers[0]);

      expect(sent()).toEqual([
        {
          sessionId,
          type: BrowserFido2MessageTypes.ConfirmNewCredentialResponse,
          userId: otherUserId,
          cipherId: "login-b",
          userVerified: false,
        },
      ]);
    });

    it("creates the new login in the chosen account", async () => {
      cipherService.createWithServer.mockResolvedValue({ id: "created" } as CipherView);
      await receive(confirmRequest([activeUserId, otherUserId]));
      await view().selectTargetAccount(otherUserId);

      await view().saveNewLogin();

      expect(cipherService.createWithServer).toHaveBeenCalledTimes(1);
      expect(cipherService.createWithServer.mock.lastCall?.[1]).toBe(otherUserId);
      expect(sent()).toEqual([
        {
          sessionId,
          type: BrowserFido2MessageTypes.ConfirmNewCredentialResponse,
          userId: otherUserId,
          cipherId: "created",
          userVerified: false,
        },
      ]);
    });

    it("aborts instead of saving when the chosen account locked meanwhile", async () => {
      await receive(confirmRequest([activeUserId, otherUserId]));
      await view().selectTargetAccount(otherUserId);
      servedUserIds$.next([activeUserId]);

      await view().saveNewLogin();

      expect(cipherService.createWithServer).not.toHaveBeenCalled();
      expect(sent()).toEqual([
        { sessionId, type: BrowserFido2MessageTypes.AbortResponse, fallbackRequested: false },
      ]);
    });

    it("opens the item form for the active account when it is the one chosen", async () => {
      await receive(confirmRequest([activeUserId, otherUserId]));

      expect(view().canAddCipher).toBe(true);
      await component.addCipher();

      expect(router.navigate).toHaveBeenCalledWith(["/add-cipher"], {
        queryParams: expect.objectContaining({ sessionId, userId: activeUserId }),
      });
    });

    it("opens the item form for the non-active account the user chose", async () => {
      await receive(confirmRequest([activeUserId, otherUserId]));
      await view().selectTargetAccount(otherUserId);

      expect(view().canAddCipher).toBe(true);
      await component.addCipher();

      expect(router.navigate).toHaveBeenCalledTimes(1);
      expect(router.navigate).toHaveBeenCalledWith(["/add-cipher"], {
        queryParams: expect.objectContaining({
          sessionId,
          userId: otherUserId,
          uri: url,
          username: "jane",
          singleActionPopout: `vault_Fido2Popout_${sessionId}`,
        }),
      });
    });

    it("aborts instead of opening the item form when the chosen account locked meanwhile", async () => {
      await receive(confirmRequest([activeUserId, otherUserId]));
      await view().selectTargetAccount(otherUserId);
      servedUserIds$.next([activeUserId]);

      await component.addCipher();

      expect(router.navigate).not.toHaveBeenCalled();
      expect(sent()).toEqual([
        { sessionId, type: BrowserFido2MessageTypes.AbortResponse, fallbackRequested: false },
      ]);
    });

    describe("with the active account locked", () => {
      beforeEach(() => {
        authStatuses.set(activeUserId, AuthenticationStatus.Locked);
        servedUserIds$.next([otherUserId]);
      });

      it("lists the locked account for the user to unlock, next to the one that serves", async () => {
        await receive({ ...confirmRequest([otherUserId]), lockedUserIds: [activeUserId] });

        expect(view().accounts).toEqual([{ userId: otherUserId, label: "other@example.com" }]);
        expect(view().lockedAccounts).toEqual([
          { userId: activeUserId, label: "active@example.com" },
        ]);
        expect(view().targetUserId).toBe(otherUserId);
      });

      it("opens the lock screen when the locked account is chosen, and saves nothing", async () => {
        await receive({ ...confirmRequest([otherUserId]), lockedUserIds: [activeUserId] });

        await view().selectTargetAccount(activeUserId);

        expect(router.navigate).toHaveBeenCalledWith(["/lock"], expect.anything());
        expect(view().targetUserId).toBe(otherUserId);
        expect(sent()).toEqual([]);
      });

      it("saves to the account the user unlocked once the request comes back with it", async () => {
        component.ngOnDestroy();
        sendMessage.mockClear();
        authStatuses.set(activeUserId, AuthenticationStatus.Unlocked);
        servedUserIds$.next([activeUserId, otherUserId]);
        createComponent({ unlockedUserId: otherUserId });

        await receive(confirmRequest([activeUserId, otherUserId]));

        expect(view().targetUserId).toBe(otherUserId);
        expect(view().displayedCiphers).toEqual([{ userId: otherUserId, cipher: otherLogin }]);
      });
    });
  });

  describe("a locked account that could hold a passkey", () => {
    let otherCipher: CipherView;

    const notFoundRequest = (lockedUserIds?: UserId[]) => ({
      type: BrowserFido2MessageTypes.InformCredentialNotFoundRequest,
      fallbackSupported: false,
      ...(lockedUserIds ? { lockedUserIds } : {}),
    });
    const pickRequest = (lockedUserIds?: UserId[]) => ({
      type: BrowserFido2MessageTypes.PickCredentialRequest,
      cipherRefs: [{ userId: otherUserId, cipherId: otherCipher.id }],
      userVerification: false,
      fallbackSupported: false,
      ...(lockedUserIds ? { lockedUserIds } : {}),
    });

    beforeEach(() => {
      otherCipher = createLogin("passkey-b");
      vaults.set(otherUserId, [otherCipher]);
      authStatuses.set(activeUserId, AuthenticationStatus.Locked);
      servedUserIds$.next([otherUserId]);
    });

    it("offers no unlock when the request names no locked account", async () => {
      await receive(notFoundRequest());

      expect(view().lockedAccounts).toEqual([]);
    });

    it("offers to unlock the locked active account when no passkey was found", async () => {
      await receive(notFoundRequest([activeUserId]));

      expect(view().lockedAccounts).toEqual([
        { userId: activeUserId, label: "active@example.com" },
      ]);
    });

    it("offers to unlock it below the passkeys of the account that serves", async () => {
      await receive(pickRequest([activeUserId]));

      expect(view().displayedCiphers).toEqual([{ userId: otherUserId, cipher: otherCipher }]);
      expect(view().lockedAccounts).toEqual([
        { userId: activeUserId, label: "active@example.com" },
      ]);
    });

    it("offers a locked account that is not the active one, and opens the lock screen for that account", async () => {
      authStatuses.set(otherUserId, AuthenticationStatus.Locked);
      authStatuses.set(activeUserId, AuthenticationStatus.Unlocked);
      servedUserIds$.next([activeUserId]);

      await receive(notFoundRequest([otherUserId]));

      expect(view().lockedAccounts).toEqual([{ userId: otherUserId, label: "other@example.com" }]);
      await view().unlockAccount(otherUserId);

      const queryParams = { sessionId, senderTabId: "7", senderUrl: url };
      expect(routerService.setPreviousUrl).toHaveBeenCalledWith(
        `/fido2?${new URLSearchParams({ ...queryParams, unlockedUserId: otherUserId }).toString()}`,
      );
      // The lock screen is told which account to unlock; the active account stays the active one
      expect(router.navigate).toHaveBeenCalledWith(["/lock"], {
        queryParams: { ...queryParams, userId: otherUserId },
      });
      expect(sent()).toEqual([]);
    });

    it("opens the lock screen in the popout and keeps the way back to the request", async () => {
      await receive(notFoundRequest([activeUserId]));

      await view().unlockAccount(activeUserId);

      const queryParams = { sessionId, senderTabId: "7", senderUrl: url };
      expect(routerService.setPreviousUrl).toHaveBeenCalledWith(
        `/fido2?${new URLSearchParams({ ...queryParams, unlockedUserId: activeUserId }).toString()}`,
      );
      expect(router.navigate).toHaveBeenCalledWith(["/lock"], { queryParams });
      // The request is not answered: it waits for the user to come back
      expect(sent()).toEqual([]);
      expect(windowClose).not.toHaveBeenCalled();
    });

    it("does not open the lock screen for an account the request did not offer", async () => {
      await receive(notFoundRequest());

      await view().unlockAccount(activeUserId);

      expect(router.navigate).not.toHaveBeenCalled();
      expect(sent()).toEqual([]);
    });

    it("has the request run again when the account was unlocked elsewhere meanwhile", async () => {
      await receive(notFoundRequest([activeUserId]));
      authStatuses.set(activeUserId, AuthenticationStatus.Unlocked);

      await view().unlockAccount(activeUserId);

      expect(router.navigate).not.toHaveBeenCalled();
      expect(sent()).toEqual([
        {
          sessionId,
          type: BrowserFido2MessageTypes.AccountUnlockedResponse,
          userId: activeUserId,
        },
      ]);
    });

    describe("back from the lock screen", () => {
      let activeCipher: CipherView;

      beforeEach(() => {
        component.ngOnDestroy();
        sendMessage.mockClear();
        activeCipher = createLogin("passkey-a");
        vaults.set(activeUserId, [activeCipher]);
        authStatuses.set(activeUserId, AuthenticationStatus.Unlocked);
        servedUserIds$.next([activeUserId, otherUserId]);
        createComponent({ unlockedUserId: activeUserId });
      });

      it("tells the waiting request which account was unlocked", () => {
        expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
          { sessionId, type: BrowserFido2MessageTypes.ConnectResponse },
          {
            sessionId,
            type: BrowserFido2MessageTypes.AccountUnlockedResponse,
            userId: activeUserId,
          },
        ]);
      });

      it("lists the passkeys the request found with the unlocked account, and answers with the chosen one", async () => {
        sendMessage.mockClear();
        await receive({
          type: BrowserFido2MessageTypes.PickCredentialRequest,
          cipherRefs: [
            { userId: activeUserId, cipherId: activeCipher.id },
            { userId: otherUserId, cipherId: otherCipher.id },
          ],
          userVerification: false,
          fallbackSupported: false,
        });

        expect(view().lockedAccounts).toEqual([]);
        expect(view().displayedCiphers).toEqual([
          { userId: activeUserId, cipher: activeCipher },
          { userId: otherUserId, cipher: otherCipher },
        ]);

        await component.handleCipherItemSelect(view().displayedCiphers[0]);

        expect(sent()).toEqual([
          {
            sessionId,
            type: BrowserFido2MessageTypes.PickCredentialResponse,
            userId: activeUserId,
            cipherId: activeCipher.id,
            userVerified: false,
          },
        ]);
      });
    });
  });

  function createLogin(id: string): CipherView {
    const cipher = new CipherView();
    cipher.id = id;
    cipher.name = id;
    cipher.type = CipherType.Login;
    cipher.login = new LoginView();
    cipher.login.uris = [new LoginUriView()];
    cipher.login.uris[0].uri = url;
    return cipher;
  }
});
