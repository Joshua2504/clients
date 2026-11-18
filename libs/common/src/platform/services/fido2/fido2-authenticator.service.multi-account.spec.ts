import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, of } from "rxjs";

import { SdkRandomNumberClient } from "@bitwarden/sdk-internal";

import { mockAccountServiceWith } from "../../../../spec";
import { CipherId, UserId } from "../../../types/guid";
import { CipherService } from "../../../vault/abstractions/cipher.service";
import { SyncService } from "../../../vault/abstractions/sync/sync.service.abstraction";
import { CipherRepromptType } from "../../../vault/enums/cipher-reprompt-type";
import { CipherType } from "../../../vault/enums/cipher-type";
import { CipherData } from "../../../vault/models/data/cipher.data";
import { CipherView } from "../../../vault/models/view/cipher.view";
import { Fido2CredentialView } from "../../../vault/models/view/fido2-credential.view";
import { LoginView } from "../../../vault/models/view/login.view";
import {
  Fido2AuthenticatorErrorCode,
  Fido2AuthenticatorGetAssertionParams,
  Fido2AuthenticatorMakeCredentialsParams,
} from "../../abstractions/fido2/fido2-authenticator.service.abstraction";
import {
  Fido2UserInterfaceService,
  Fido2UserInterfaceSession,
} from "../../abstractions/fido2/fido2-user-interface.service.abstraction";
import { SdkLoadService } from "../../abstractions/sdk/sdk-load.service";
import { Utils } from "../../misc/utils";

import { parseCredentialId } from "./credential-id-utils";
import { Fido2AuthenticatorService } from "./fido2-authenticator.service";

type ParentWindowReference = string;

const RpId = "bitwarden.com";
const KeyValue =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTC-7XDZipXbaVBlnkjlBgO16ZmqBZWejK2iYo6lV0dehRANCAASOcM2WduNq1DriRYN7ZekvZz-bRhA-qNT4v0fbp5suUFJyWmgOQ0bybZcLXHaerK5Ep1JiSrQcewtQNgLtry7f";

describe("Fido2AuthenticatorService serving several accounts", () => {
  const activeUserId = "active-user" as UserId;
  const otherUserId = "other-user" as UserId;

  let vaults: Map<UserId, CipherView[]>;
  let candidateUserIds$: BehaviorSubject<UserId[]>;
  let cipherService: MockProxy<CipherService>;
  let userInterface: MockProxy<Fido2UserInterfaceService<ParentWindowReference>>;
  let userInterfaceSession: MockProxy<Fido2UserInterfaceSession>;
  let syncService: MockProxy<SyncService>;
  let authenticator: Fido2AuthenticatorService<ParentWindowReference>;

  beforeEach(() => {
    vaults = new Map([
      [activeUserId, []],
      [otherUserId, []],
    ]);
    candidateUserIds$ = new BehaviorSubject([activeUserId, otherUserId]);

    cipherService = mock<CipherService>();
    cipherService.cipherListViews$.mockImplementation((userId) => of(vaults.get(userId) ?? []));
    cipherService.getAllDecryptedForIds.mockImplementation(async (userId, ids) =>
      (vaults.get(userId) ?? []).filter((cipher) => ids.includes(cipher.id)),
    );
    cipherService.ciphers$.mockImplementation((userId) =>
      of(
        Object.fromEntries(
          (vaults.get(userId) ?? []).map((cipher) => [cipher.id, { id: cipher.id } as CipherData]),
        ) as Record<CipherId, CipherData>,
      ),
    );
    cipherService.decrypt.mockImplementation(
      async (cipher, userId) =>
        (vaults.get(userId) ?? []).find((view) => view.id === cipher.id) as CipherView,
    );

    userInterface = mock<Fido2UserInterfaceService<ParentWindowReference>>();
    userInterfaceSession = mock<Fido2UserInterfaceSession>();
    userInterface.newSession.mockResolvedValue(userInterfaceSession);
    syncService = mock<SyncService>();
    syncService.lastSync$.mockReturnValue(of(new Date()));

    authenticator = new Fido2AuthenticatorService(
      cipherService,
      userInterface,
      syncService,
      mockAccountServiceWith(activeUserId),
      undefined,
      candidateUserIds$,
    );

    (SdkLoadService as any).Ready = jest.fn().mockResolvedValue(true);
    jest
      .spyOn(SdkRandomNumberClient.prototype, "gen_uuid")
      .mockImplementation(() => Utils.newGuid());
  });

  describe("getAssertion", () => {
    let activeCipher: CipherView;
    let otherCipher: CipherView;

    beforeEach(() => {
      activeCipher = createCipherView({ counter: 9000 });
      otherCipher = createCipherView({ counter: 9000 });
      vaults.set(activeUserId, [activeCipher]);
      vaults.set(otherUserId, [otherCipher]);
    });

    it("offers the credentials of every account, each with its account", async () => {
      userInterfaceSession.pickCredential.mockResolvedValue({
        cipherId: activeCipher.id,
        userId: activeUserId,
        userVerified: false,
      });

      await authenticator.getAssertion(assertionParams(), "window");

      expect(userInterfaceSession.pickCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          cipherIds: [activeCipher.id, otherCipher.id],
          cipherRefs: [
            { userId: activeUserId, cipherId: activeCipher.id },
            { userId: otherUserId, cipherId: otherCipher.id },
          ],
        }),
      );
    });

    it("signs with the chosen credential and saves it to its own account", async () => {
      userInterfaceSession.pickCredential.mockResolvedValue({
        cipherId: otherCipher.id,
        userId: otherUserId,
        userVerified: false,
      });

      const result = await authenticator.getAssertion(assertionParams(), "window");

      expect(result.selectedCredential.id).toEqual(
        parseCredentialId(otherCipher.login.fido2Credentials[0].credentialId),
      );
      expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
      expect(cipherService.updateWithServer).toHaveBeenCalledWith(otherCipher, otherUserId);
      expect(otherCipher.login.fido2Credentials[0].counter).toBe(9001);
      expect(activeCipher.login.fido2Credentials[0].counter).toBe(9000);
    });

    it("syncs every account before the credentials are offered", async () => {
      userInterfaceSession.pickCredential.mockResolvedValue({
        cipherId: otherCipher.id,
        userId: otherUserId,
        userVerified: false,
      });

      await authenticator.getAssertion(assertionParams(), "window");

      expect(syncService.fullSync.mock.calls).toEqual([
        [false, { userId: activeUserId }],
        [false, { userId: otherUserId }],
      ]);
    });

    it("rejects an answer that names a credential under another account", async () => {
      userInterfaceSession.pickCredential.mockResolvedValue({
        cipherId: otherCipher.id,
        userId: activeUserId,
        userVerified: false,
      });

      await expect(authenticator.getAssertion(assertionParams(), "window")).rejects.toThrow(
        Fido2AuthenticatorErrorCode.NotAllowed,
      );
      expect(cipherService.updateWithServer).not.toHaveBeenCalled();
    });

    it("rejects an answer without an account when several accounts were offered", async () => {
      userInterfaceSession.pickCredential.mockResolvedValue({
        cipherId: otherCipher.id,
        userVerified: false,
      });

      await expect(authenticator.getAssertion(assertionParams(), "window")).rejects.toThrow(
        Fido2AuthenticatorErrorCode.NotAllowed,
      );
      expect(cipherService.updateWithServer).not.toHaveBeenCalled();
    });

    it("aborts when the chosen account locks before the user confirms", async () => {
      userInterfaceSession.pickCredential.mockImplementation(async () => {
        candidateUserIds$.next([activeUserId]);
        return { cipherId: otherCipher.id, userId: otherUserId, userVerified: false };
      });

      await expect(authenticator.getAssertion(assertionParams(), "window")).rejects.toThrow(
        Fido2AuthenticatorErrorCode.NotAllowed,
      );
      expect(cipherService.updateWithServer).not.toHaveBeenCalled();
      expect(otherCipher.login.fido2Credentials[0].counter).toBe(9000);
    });

    it("requires verification of the user when the chosen cipher asks for a reprompt", async () => {
      otherCipher.reprompt = CipherRepromptType.Password;
      userInterfaceSession.pickCredential.mockResolvedValue({
        cipherId: otherCipher.id,
        userId: otherUserId,
        userVerified: false,
      });

      await expect(authenticator.getAssertion(assertionParams(), "window")).rejects.toThrow(
        Fido2AuthenticatorErrorCode.NotAllowed,
      );
      expect(userInterfaceSession.pickCredential).toHaveBeenCalledWith(
        expect.objectContaining({ masterPasswordRepromptRequired: true }),
      );
    });

    it("searches only the account named by the request", async () => {
      const result = await authenticator.getAssertion(
        assertionParams({ userId: otherUserId, assumeUserPresence: true }),
        "window",
      );

      expect(userInterfaceSession.pickCredential).not.toHaveBeenCalled();
      expect(cipherService.cipherListViews$).not.toHaveBeenCalledWith(activeUserId);
      expect(result.selectedCredential.id).toEqual(
        parseCredentialId(otherCipher.login.fido2Credentials[0].credentialId),
      );
      expect(cipherService.updateWithServer).toHaveBeenCalledWith(otherCipher, otherUserId);
    });

    it("finds nothing for an account named by the request that is not served", async () => {
      candidateUserIds$.next([activeUserId]);

      await expect(
        authenticator.getAssertion(
          assertionParams({ userId: otherUserId, assumeUserPresence: true }),
          "window",
        ),
      ).rejects.toThrow(Fido2AuthenticatorErrorCode.NotAllowed);
      expect(userInterfaceSession.informCredentialNotFound).toHaveBeenCalled();
      expect(cipherService.updateWithServer).not.toHaveBeenCalled();
    });

    describe("the same shared item in both accounts", () => {
      let sharedInActive: CipherView;
      let sharedInOther: CipherView;

      beforeEach(() => {
        sharedInActive = createCipherView({ counter: 9000 });
        sharedInActive.organizationId = "org";
        sharedInOther = createCipherView({
          counter: 9000,
          credentialId: sharedInActive.login.fido2Credentials[0].credentialId,
        });
        sharedInOther.id = sharedInActive.id;
        sharedInOther.organizationId = "org";
        vaults.set(activeUserId, [sharedInActive]);
        vaults.set(otherUserId, [sharedInOther]);
      });

      it("offers the item once per account", async () => {
        userInterfaceSession.pickCredential.mockResolvedValue({
          cipherId: sharedInOther.id,
          userId: otherUserId,
          userVerified: false,
        });

        await authenticator.getAssertion(assertionParams(), "window");

        expect(userInterfaceSession.pickCredential).toHaveBeenCalledWith(
          expect.objectContaining({
            cipherRefs: [
              { userId: activeUserId, cipherId: sharedInActive.id },
              { userId: otherUserId, cipherId: sharedInOther.id },
            ],
          }),
        );
      });

      it("uses the item as the chosen account holds it", async () => {
        userInterfaceSession.pickCredential.mockResolvedValue({
          cipherId: sharedInOther.id,
          userId: otherUserId,
          userVerified: false,
        });

        await authenticator.getAssertion(assertionParams(), "window");

        expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
        expect(cipherService.updateWithServer.mock.lastCall?.[0]).toBe(sharedInOther);
        expect(cipherService.updateWithServer.mock.lastCall?.[1]).toBe(otherUserId);
        expect(sharedInActive.login.fido2Credentials[0].counter).toBe(9000);
      });

      it("asks which account to use even when the user is assumed present", async () => {
        userInterfaceSession.pickCredential.mockResolvedValue({
          cipherId: sharedInActive.id,
          userId: activeUserId,
          userVerified: false,
        });

        await authenticator.getAssertion(assertionParams({ assumeUserPresence: true }), "window");

        expect(userInterfaceSession.pickCredential).toHaveBeenCalled();
        expect(cipherService.updateWithServer.mock.lastCall?.[0]).toBe(sharedInActive);
        expect(cipherService.updateWithServer.mock.lastCall?.[1]).toBe(activeUserId);
      });

      it("rejects an answer without an account", async () => {
        userInterfaceSession.pickCredential.mockResolvedValue({
          cipherId: sharedInOther.id,
          userVerified: false,
        });

        await expect(authenticator.getAssertion(assertionParams(), "window")).rejects.toThrow(
          Fido2AuthenticatorErrorCode.NotAllowed,
        );
        expect(cipherService.updateWithServer).not.toHaveBeenCalled();
      });
    });

    it("informs the user when no account is served", async () => {
      candidateUserIds$.next([]);

      await expect(authenticator.getAssertion(assertionParams(), "window")).rejects.toThrow(
        Fido2AuthenticatorErrorCode.NotAllowed,
      );
      expect(userInterfaceSession.informCredentialNotFound).toHaveBeenCalled();
    });
  });

  describe("silentCredentialDiscovery", () => {
    it("returns the credentials of every account", async () => {
      const activeCipher = createCipherView();
      const otherCipher = createCipherView();
      vaults.set(activeUserId, [activeCipher]);
      vaults.set(otherUserId, [otherCipher]);

      const result = await authenticator.silentCredentialDiscovery(RpId);

      expect(result).toEqual([
        activeCipher.login.fido2Credentials[0],
        otherCipher.login.fido2Credentials[0],
      ]);
    });

    it("returns nothing when no account is served", async () => {
      candidateUserIds$.next([]);

      expect(await authenticator.silentCredentialDiscovery(RpId)).toEqual([]);
    });
  });

  describe("makeCredential", () => {
    let activeLogin: CipherView;
    let otherLogin: CipherView;

    beforeEach(() => {
      activeLogin = createLoginView();
      otherLogin = createLoginView();
      vaults.set(activeUserId, [activeLogin]);
      vaults.set(otherUserId, [otherLogin]);
    });

    it("informs the user of an excluded credential that lives in the non-active account", async () => {
      const excludedCipher = createCipherView();
      vaults.set(otherUserId, [excludedCipher]);
      userInterfaceSession.informExcludedCredential.mockResolvedValue();

      await expect(
        authenticator.makeCredential(
          makeCredentialParams({
            excludeCredentialDescriptorList: [
              {
                id: parseCredentialId(excludedCipher.login.fido2Credentials[0].credentialId),
                type: "public-key",
              },
            ],
          }),
          "window",
        ),
      ).rejects.toThrow(Fido2AuthenticatorErrorCode.NotAllowed);

      expect(userInterfaceSession.informExcludedCredential).toHaveBeenCalledWith(
        [excludedCipher.id],
        [{ userId: otherUserId, cipherId: excludedCipher.id }],
      );
      expect(userInterfaceSession.confirmNewCredential).not.toHaveBeenCalled();
    });

    it("offers every account, the active one first", async () => {
      userInterfaceSession.confirmNewCredential.mockResolvedValue({
        cipherId: activeLogin.id,
        userId: activeUserId,
        userVerified: false,
      });

      await authenticator.makeCredential(makeCredentialParams(), "window");

      expect(userInterfaceSession.confirmNewCredential).toHaveBeenCalledWith(
        expect.objectContaining({ userIds: [activeUserId, otherUserId] }),
      );
    });

    it("saves the credential to the non-active account when the user chose it", async () => {
      userInterfaceSession.confirmNewCredential.mockResolvedValue({
        cipherId: otherLogin.id,
        userId: otherUserId,
        userVerified: false,
      });

      await authenticator.makeCredential(makeCredentialParams(), "window");

      expect(cipherService.ciphers$).toHaveBeenCalledWith(otherUserId);
      expect(cipherService.ciphers$).not.toHaveBeenCalledWith(activeUserId);
      expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
      expect(cipherService.updateWithServer).toHaveBeenCalledWith(otherLogin, otherUserId);
      expect(otherLogin.login.fido2Credentials).toHaveLength(1);
      expect(activeLogin.login.fido2Credentials).toHaveLength(0);
    });

    it("saves the credential to the active account when the answer names no account", async () => {
      userInterfaceSession.confirmNewCredential.mockResolvedValue({
        cipherId: activeLogin.id,
        userVerified: false,
      });

      await authenticator.makeCredential(makeCredentialParams(), "window");

      expect(cipherService.updateWithServer).toHaveBeenCalledWith(activeLogin, activeUserId);
    });

    it("aborts when the chosen account locks before the user confirms", async () => {
      userInterfaceSession.confirmNewCredential.mockImplementation(async () => {
        candidateUserIds$.next([activeUserId]);
        return { cipherId: otherLogin.id, userId: otherUserId, userVerified: false };
      });

      await expect(authenticator.makeCredential(makeCredentialParams(), "window")).rejects.toThrow(
        Fido2AuthenticatorErrorCode.NotAllowed,
      );
      expect(cipherService.updateWithServer).not.toHaveBeenCalled();
    });

    it("does not look for the chosen cipher in another account", async () => {
      // The user interface names a cipher of the other account under the active account.
      cipherService.ciphers$.mockImplementation((userId) =>
        of(
          userId === otherUserId
            ? ({ [otherLogin.id]: { id: otherLogin.id } } as Record<CipherId, CipherData>)
            : {},
        ),
      );
      userInterfaceSession.confirmNewCredential.mockResolvedValue({
        cipherId: otherLogin.id,
        userId: activeUserId,
        userVerified: false,
      });
      jest.useFakeTimers();

      const result = authenticator.makeCredential(makeCredentialParams(), "window");
      const expectation = expect(result).rejects.toThrow(Fido2AuthenticatorErrorCode.Unknown);
      await jest.advanceTimersByTimeAsync(5000);
      await expectation;

      jest.useRealTimers();
      expect(cipherService.updateWithServer).not.toHaveBeenCalled();
    });

    it("aborts when no account is served", async () => {
      candidateUserIds$.next([]);

      await expect(authenticator.makeCredential(makeCredentialParams(), "window")).rejects.toThrow(
        Fido2AuthenticatorErrorCode.NotAllowed,
      );
      expect(userInterfaceSession.confirmNewCredential).not.toHaveBeenCalled();
    });

    it("syncs an account that was not synced recently", async () => {
      syncService.lastSync$.mockImplementation((userId) =>
        of(userId === otherUserId ? null : new Date()),
      );
      userInterfaceSession.confirmNewCredential.mockResolvedValue({
        cipherId: activeLogin.id,
        userId: activeUserId,
        userVerified: false,
      });

      await authenticator.makeCredential(makeCredentialParams(), "window");

      expect(syncService.fullSync.mock.calls).toEqual([[false, { userId: otherUserId }]]);
    });
  });
});

function assertionParams(
  params: Partial<Fido2AuthenticatorGetAssertionParams> = {},
): Fido2AuthenticatorGetAssertionParams {
  return {
    rpId: RpId,
    hash: new Uint8Array(32),
    allowCredentialDescriptorList: [],
    requireUserVerification: false,
    extensions: {},
    fallbackSupported: false,
    ...params,
  };
}

function makeCredentialParams(
  params: Partial<Fido2AuthenticatorMakeCredentialsParams> = {},
): Fido2AuthenticatorMakeCredentialsParams {
  return {
    hash: new Uint8Array(32),
    rpEntity: { name: "Bitwarden", id: RpId },
    userEntity: { id: new Uint8Array(16), name: "jane.doe@bitwarden.com", displayName: "Jane" },
    credTypesAndPubKeyAlgs: [{ alg: -7, type: "public-key" }],
    excludeCredentialDescriptorList: [],
    requireResidentKey: false,
    requireUserVerification: false,
    fallbackSupported: false,
    ...params,
  };
}

/** A login that holds a passkey for {@link RpId}. */
function createCipherView(fido2Credential: Partial<Fido2CredentialView> = {}): CipherView {
  const cipher = createLoginView();

  const fido2CredentialView = new Fido2CredentialView();
  fido2CredentialView.credentialId = fido2Credential.credentialId ?? Utils.newGuid();
  fido2CredentialView.rpId = RpId;
  fido2CredentialView.counter = fido2Credential.counter ?? 0;
  fido2CredentialView.userHandle = "dXNlcg";
  fido2CredentialView.keyAlgorithm = "ECDSA";
  fido2CredentialView.keyCurve = "P-256";
  fido2CredentialView.discoverable = true;
  fido2CredentialView.keyValue = KeyValue;
  cipher.login.fido2Credentials = [fido2CredentialView];

  return cipher;
}

/** A login without a passkey. */
function createLoginView(): CipherView {
  const cipher = new CipherView();
  cipher.id = Utils.newGuid();
  cipher.type = CipherType.Login;
  cipher.localData = {};
  cipher.login = new LoginView();

  return cipher;
}
