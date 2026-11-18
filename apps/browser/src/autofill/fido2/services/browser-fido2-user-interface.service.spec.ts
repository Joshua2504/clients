import { mock } from "jest-mock-extended";
import { of, Subject } from "rxjs";

import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { UserId } from "@bitwarden/common/types/guid";

import { BrowserApi } from "../../../platform/browser/browser-api";

import {
  BrowserFido2Message,
  BrowserFido2MessageTypes,
  BrowserFido2ParentWindowReference,
  BrowserFido2UserInterfaceSession,
} from "./browser-fido2-user-interface.service";

const openFido2Popout = jest.fn();
const closeFido2Popout = jest.fn();
jest.mock("../../../vault/popup/utils/vault-popout-window", () => ({
  closeFido2Popout: (...args: unknown[]) => closeFido2Popout(...args),
  openFido2Popout: (...args: unknown[]) => openFido2Popout(...args),
}));

describe("BrowserFido2UserInterfaceSession", () => {
  const activeUserId = "active-user" as UserId;
  const otherUserId = "other-user" as UserId;
  const tab = mock<BrowserFido2ParentWindowReference>({ id: 7 });

  let messages$: Subject<BrowserFido2Message>;
  let sendMessage: jest.SpyInstance;
  let authService: ReturnType<typeof mock<AuthService>>;
  let session: BrowserFido2UserInterfaceSession;

  /** The messages the session sent to the popout, without the session announcement. */
  const sent = () =>
    sendMessage.mock.calls
      .map(([, message]) => message as BrowserFido2Message)
      .filter((message) => message.type !== BrowserFido2MessageTypes.NewSessionCreatedRequest);

  /** Answers as the popout does, once the session has sent its request. */
  const answer = (message: Record<string, unknown>) =>
    setTimeout(() => messages$.next({ sessionId: session.sessionId, ...message } as any));

  beforeEach(async () => {
    openFido2Popout.mockReset().mockResolvedValue(1);
    closeFido2Popout.mockReset().mockResolvedValue(undefined);
    messages$ = new Subject();
    jest.spyOn(BrowserApi, "messageListener$").mockReturnValue(messages$ as any);
    jest.spyOn(BrowserApi, "tabSendMessageData").mockResolvedValue(undefined);
    sendMessage = jest.spyOn(BrowserApi, "sendMessage").mockResolvedValue(undefined);
    authService = mock<AuthService>();
    authService.getAuthStatus.mockResolvedValue(AuthenticationStatus.Unlocked);

    session = await BrowserFido2UserInterfaceSession.create(authService, false, tab);
    // The popout is open and has announced itself
    messages$.next({
      sessionId: session.sessionId,
      type: BrowserFido2MessageTypes.ConnectResponse,
    });
  });

  afterEach(async () => {
    await session.close();
    jest.restoreAllMocks();
  });

  describe("pickCredential", () => {
    const cipherRefs = [
      { userId: activeUserId, cipherId: "cipher-a" },
      { userId: otherUserId, cipherId: "cipher-b" },
    ];

    it("sends each credential with its account and returns the account of the picked one", async () => {
      answer({
        type: BrowserFido2MessageTypes.PickCredentialResponse,
        userId: otherUserId,
        cipherId: "cipher-b",
        userVerified: true,
      });

      const result = await session.pickCredential({
        cipherIds: ["cipher-a", "cipher-b"],
        cipherRefs,
        userVerification: true,
      });

      expect(sent()).toEqual([
        {
          type: BrowserFido2MessageTypes.PickCredentialRequest,
          sessionId: session.sessionId,
          cipherRefs,
          userVerification: true,
          fallbackSupported: false,
        },
      ]);
      expect(result).toEqual({ userId: otherUserId, cipherId: "cipher-b", userVerified: true });
    });

    it("answers for the only credential with its account when the user is assumed present", async () => {
      const result = await session.pickCredential({
        cipherIds: ["cipher-b"],
        cipherRefs: [cipherRefs[1]],
        userVerification: false,
        assumeUserPresence: true,
      });

      expect(sent()).toEqual([]);
      expect(result).toEqual({ userId: otherUserId, cipherId: "cipher-b", userVerified: false });
    });

    it("asks the user when the same shared item is offered for two accounts", async () => {
      const shared = [
        { userId: activeUserId, cipherId: "shared" },
        { userId: otherUserId, cipherId: "shared" },
      ];
      answer({
        type: BrowserFido2MessageTypes.PickCredentialResponse,
        userId: otherUserId,
        cipherId: "shared",
        userVerified: false,
      });

      const result = await session.pickCredential({
        cipherIds: ["shared", "shared"],
        cipherRefs: shared,
        userVerification: false,
        assumeUserPresence: true,
      });

      expect(sent()).toHaveLength(1);
      expect(result.userId).toBe(otherUserId);
    });

    it("refuses credentials that come without their accounts", async () => {
      await expect(
        session.pickCredential({ cipherIds: ["cipher-a"], userVerification: false }),
      ).rejects.toThrow();
      expect(sent()).toEqual([]);
    });
  });

  describe("confirmNewCredential", () => {
    const params = {
      credentialName: "Example",
      userName: "jane",
      userHandle: "handle",
      userVerification: false,
      rpId: "example.com",
    };

    it("offers the accounts and returns the chosen one", async () => {
      answer({
        type: BrowserFido2MessageTypes.ConfirmNewCredentialResponse,
        userId: otherUserId,
        cipherId: "cipher-b",
        userVerified: false,
      });

      const result = await session.confirmNewCredential({
        ...params,
        userIds: [activeUserId, otherUserId],
      });

      expect(sent()).toEqual([
        {
          type: BrowserFido2MessageTypes.ConfirmNewCredentialRequest,
          sessionId: session.sessionId,
          ...params,
          fallbackSupported: false,
          userIds: [activeUserId, otherUserId],
        },
      ]);
      expect(result).toEqual({ userId: otherUserId, cipherId: "cipher-b", userVerified: false });
    });

    it("returns no account for an answer that names none", async () => {
      setTimeout(() =>
        BrowserFido2UserInterfaceSession.confirmNewCredentialResponse(
          session.sessionId,
          "cipher-a",
          true,
        ),
      );
      sendMessage.mockImplementation(async (_name, message: BrowserFido2Message) => {
        if (message.type === BrowserFido2MessageTypes.ConfirmNewCredentialResponse) {
          messages$.next(message);
        }
      });

      const result = await session.confirmNewCredential({ ...params, userIds: [activeUserId] });

      expect(result).toEqual({ userId: undefined, cipherId: "cipher-a", userVerified: true });
    });
  });

  describe("informExcludedCredential", () => {
    it("names the excluded credential with its account", async () => {
      const existingCipherRefs = [{ userId: otherUserId, cipherId: "cipher-b" }];
      answer({ type: BrowserFido2MessageTypes.AbortResponse, fallbackRequested: false });

      await session.informExcludedCredential(["cipher-b"], existingCipherRefs);

      expect(sent()[0]).toEqual({
        type: BrowserFido2MessageTypes.InformExcludedCredentialRequest,
        sessionId: session.sessionId,
        existingCipherRefs,
        fallbackSupported: false,
      });
    });
  });

  describe("ensureUnlockedVault", () => {
    it("does not open the popout while the active account is unlocked", async () => {
      await session.ensureUnlockedVault();

      expect(openFido2Popout).not.toHaveBeenCalled();
    });

    describe("with the active account locked", () => {
      const lockedSession = async (servedUserIds: UserId[]) => {
        authService.getAuthStatus.mockResolvedValue(AuthenticationStatus.Locked);
        await session.close();
        session = await BrowserFido2UserInterfaceSession.create(
          authService,
          false,
          tab,
          undefined,
          of(servedUserIds),
        );
      };

      it("does not ask to unlock while another account serves passkeys", async () => {
        await lockedSession([otherUserId]);

        await session.ensureUnlockedVault();

        expect(openFido2Popout).not.toHaveBeenCalled();
      });

      it("opens the popout to unlock when no account serves passkeys", async () => {
        await lockedSession([]);

        const ensured = session.ensureUnlockedVault();
        await new Promise((resolve) => setTimeout(resolve));
        messages$.next({
          sessionId: session.sessionId,
          type: BrowserFido2MessageTypes.ConnectResponse,
        });
        await ensured;

        expect(openFido2Popout).toHaveBeenCalledTimes(1);
      });
    });
  });
});
