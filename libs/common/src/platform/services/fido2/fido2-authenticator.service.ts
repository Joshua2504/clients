// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { filter, firstValueFrom, map, Observable, timeout } from "rxjs";

import { SdkRandomNumberClient } from "@bitwarden/sdk-internal";

import { AccountService } from "../../../auth/abstractions/account.service";
import { getUserId } from "../../../auth/services/account.service";
import {
  AccountCipher,
  AccountCipherRef,
  accountCipherRef,
} from "../../../autofill/types/account-cipher";
import { CipherId, UserId } from "../../../types/guid";
import { CipherService } from "../../../vault/abstractions/cipher.service";
import { SyncService } from "../../../vault/abstractions/sync/sync.service.abstraction";
import { CipherRepromptType } from "../../../vault/enums/cipher-reprompt-type";
import { CipherType } from "../../../vault/enums/cipher-type";
import { Cipher } from "../../../vault/models/domain/cipher";
import { CipherView } from "../../../vault/models/view/cipher.view";
import { Fido2CredentialView } from "../../../vault/models/view/fido2-credential.view";
import { CipherViewLikeUtils } from "../../../vault/utils/cipher-view-like-utils";
import { filterOutNullish } from "../../../vault/utils/observable-utilities";
import {
  Fido2AlgorithmIdentifier,
  Fido2AuthenticatorError,
  Fido2AuthenticatorErrorCode,
  Fido2AuthenticatorGetAssertionParams,
  Fido2AuthenticatorGetAssertionResult,
  Fido2AuthenticatorMakeCredentialResult,
  Fido2AuthenticatorMakeCredentialsParams,
  Fido2AuthenticatorService as Fido2AuthenticatorServiceAbstraction,
  PublicKeyCredentialDescriptor,
} from "../../abstractions/fido2/fido2-authenticator.service.abstraction";
import { Fido2UserInterfaceService } from "../../abstractions/fido2/fido2-user-interface.service.abstraction";
import { LogService } from "../../abstractions/log.service";
import { SdkLoadService } from "../../abstractions/sdk/sdk-load.service";
import { Utils } from "../../misc/utils";

import { CBOR } from "./cbor";
import { compareCredentialIds, parseCredentialId } from "./credential-id-utils";
import { p1363ToDer } from "./ecdsa-utils";
import { Fido2Utils } from "./fido2-utils";
import { guidToStandardFormat } from "./guid-utils";

// AAGUID: d548826e-79b4-db40-a3d8-11116f7e8349
export const AAGUID = new Uint8Array([
  0xd5, 0x48, 0x82, 0x6e, 0x79, 0xb4, 0xdb, 0x40, 0xa3, 0xd8, 0x11, 0x11, 0x6f, 0x7e, 0x83, 0x49,
]);

const KeyUsages: KeyUsage[] = ["sign"];

/**
 * Bitwarden implementation of the WebAuthn Authenticator Model as described by W3C
 * https://www.w3.org/TR/webauthn-3/#sctn-authenticator-model
 *
 * It is highly recommended that the W3C specification is used a reference when reading this code.
 */
export class Fido2AuthenticatorService<
  ParentWindowReference,
> implements Fido2AuthenticatorServiceAbstraction<ParentWindowReference> {
  /**
   * @param candidateUserIds$ The accounts whose vaults the authenticator serves, in order of
   * precedence. Credentials are searched in all of them, excluded credentials are checked in all
   * of them, and a new credential is saved to one of them. An account that is not listed when
   * the user confirms is not used. Without it, the authenticator serves the active account.
   */
  constructor(
    private cipherService: CipherService,
    private userInterface: Fido2UserInterfaceService<ParentWindowReference>,
    private syncService: SyncService,
    private accountService: AccountService,
    private logService?: LogService,
    private candidateUserIds$?: Observable<UserId[]>,
  ) {}

  async makeCredential(
    params: Fido2AuthenticatorMakeCredentialsParams,
    window: ParentWindowReference,
    abortController?: AbortController,
  ): Promise<Fido2AuthenticatorMakeCredentialResult> {
    const userInterfaceSession = await this.userInterface.newSession(
      params.fallbackSupported,
      window,
      abortController,
    );

    try {
      if (params.credTypesAndPubKeyAlgs.every((p) => p.alg !== Fido2AlgorithmIdentifier.ES256)) {
        const requestedAlgorithms = params.credTypesAndPubKeyAlgs.map((p) => p.alg).join(", ");
        this.logService?.warning(
          `[Fido2Authenticator] No compatible algorithms found, RP requested: ${requestedAlgorithms}`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotSupported);
      }

      if (
        params.requireResidentKey != undefined &&
        typeof params.requireResidentKey !== "boolean"
      ) {
        this.logService?.error(
          `[Fido2Authenticator] Invalid 'requireResidentKey' value: ${String(
            params.requireResidentKey,
          )}`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.Unknown);
      }

      if (
        params.requireUserVerification != undefined &&
        typeof params.requireUserVerification !== "boolean"
      ) {
        this.logService?.error(
          `[Fido2Authenticator] Invalid 'requireUserVerification' value: ${String(
            params.requireUserVerification,
          )}`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.Unknown);
      }

      await userInterfaceSession.ensureUnlockedVault();

      const userIds = await this.candidateUserIds();
      if (userIds.length === 0) {
        this.logService?.warning(
          `[Fido2Authenticator] Aborting because no account can receive the credential.`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotAllowed);
      }

      // Avoid syncing if we did it reasonably soon as the only reason for syncing is to validate excludeCredentials
      const threshold = new Date().getTime() - 1000 * 60 * 30; // 30 minutes ago
      for (const userId of userIds) {
        const lastSync = await firstValueFrom(this.lastSync$(userId));

        if (!lastSync || lastSync.getTime() < threshold) {
          await this.sync(userId);
        }
      }

      // A credential in the vault of any account counts as excluded
      const existingCiphers = await this.findExcludedCredentials(
        params.excludeCredentialDescriptorList,
        userIds,
      );
      if (existingCiphers.length > 0) {
        this.logService?.info(
          `[Fido2Authenticator] Aborting due to excluded credential found in vault.`,
        );
        await userInterfaceSession.informExcludedCredential(
          existingCiphers.map((ref) => ref.cipherId),
          existingCiphers,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotAllowed);
      }

      let cipher: CipherView;
      let fido2Credential: Fido2CredentialView;
      let keyPair: CryptoKeyPair;
      let userVerified = false;
      let credentialId: string;
      let pubKeyDer: Uint8Array<ArrayBuffer>;
      const response = await userInterfaceSession.confirmNewCredential({
        credentialName: params.rpEntity.name,
        userName: params.userEntity.name,
        userHandle: Fido2Utils.arrayToString(params.userEntity.id),
        userVerification: params.requireUserVerification,
        rpId: params.rpEntity.id,
        userIds,
      });
      const cipherId = response.cipherId;
      userVerified = response.userVerified;

      if (cipherId === undefined) {
        this.logService?.warning(
          `[Fido2Authenticator] Aborting because user confirmation was not received.`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotAllowed);
      }

      // The credential is saved to the account the user confirmed, and to no other. That account
      // must still be served now: it may have locked or logged out while the user was asked.
      const targetUserId =
        response.userId ??
        (await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId)));
      if (!(await this.candidateUserIds()).includes(targetUserId)) {
        this.logService?.warning(
          `[Fido2Authenticator] Aborting because the account chosen for the credential is not available.`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotAllowed);
      }

      try {
        keyPair = await createKeyPair();
        pubKeyDer = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));

        const encrypted = await firstValueFrom(
          this.cipherService.ciphers$(targetUserId).pipe(
            map((ciphers) => ciphers[cipherId as CipherId]),
            filter((c) => c !== undefined),
            timeout({
              first: 5000,
              with: () => {
                this.logService?.error(
                  `[Fido2Authenticator] Aborting because cipher with ID ${cipherId} could not be found within timeout.`,
                );
                throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.Unknown);
              },
            }),
            map((c) => new Cipher(c, null)),
          ),
        );

        cipher = await this.cipherService.decrypt(encrypted, targetUserId);

        if (
          !userVerified &&
          (params.requireUserVerification || cipher.reprompt !== CipherRepromptType.None)
        ) {
          this.logService?.warning(
            `[Fido2Authenticator] Aborting because user verification was unsuccessful.`,
          );
          throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotAllowed);
        }

        fido2Credential = await createKeyView(params, keyPair.privateKey);
        cipher.login.fido2Credentials = [fido2Credential];
        // update username if username is missing
        if (Utils.isNullOrEmpty(cipher.login.username)) {
          cipher.login.username = fido2Credential.userName;
        }
        await this.cipherService.updateWithServer(cipher, targetUserId);
        credentialId = fido2Credential.credentialId;
      } catch (error) {
        this.logService?.error(
          `[Fido2Authenticator] Aborting because of unknown error when creating credential: ${error}`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.Unknown);
      }

      const authData = await generateAuthData({
        rpId: params.rpEntity.id,
        credentialId: parseCredentialId(credentialId),
        counter: fido2Credential.counter,
        userPresence: true,
        userVerification: userVerified,
        keyPair,
      });
      const attestationObject = new Uint8Array(
        CBOR.encode({
          fmt: "none",
          attStmt: {},
          authData,
        }),
      );

      return {
        credentialId: parseCredentialId(credentialId),
        attestationObject,
        authData,
        publicKey: pubKeyDer,
        publicKeyAlgorithm: -7,
      };
    } finally {
      userInterfaceSession.close();
    }
  }

  async getAssertion(
    params: Fido2AuthenticatorGetAssertionParams,
    window: ParentWindowReference,
    abortController?: AbortController,
  ): Promise<Fido2AuthenticatorGetAssertionResult> {
    const userInterfaceSession = await this.userInterface.newSession(
      params.fallbackSupported,
      window,
      abortController,
    );
    try {
      if (
        params.requireUserVerification != undefined &&
        typeof params.requireUserVerification !== "boolean"
      ) {
        this.logService?.error(
          `[Fido2Authenticator] Invalid 'requireUserVerification' value: ${String(
            params.requireUserVerification,
          )}`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.Unknown);
      }

      let cipherOptions: AccountCipher[];

      await userInterfaceSession.ensureUnlockedVault();

      const userIds = (await this.candidateUserIds()).filter(
        (userId) => params.userId == undefined || userId === params.userId,
      );

      // Try to find the passkey locally before causing a sync to speed things up
      // only skip syncing if we found credentials AND all of them have a counter = 0
      cipherOptions = await this.findCredential(params, userIds);
      if (
        cipherOptions.length === 0 ||
        cipherOptions.some((c) => c.cipher.login.fido2Credentials.some((p) => p.counter > 0))
      ) {
        // If no passkey is found, or any had a non-zero counter, sync to get the latest data
        for (const userId of userIds) {
          await this.sync(userId);
        }
        cipherOptions = await this.findCredential(params, userIds);
      }

      if (cipherOptions.length === 0) {
        this.logService?.info(
          `[Fido2Authenticator] Aborting because no matching credentials were found in the vault.`,
        );

        await userInterfaceSession.informCredentialNotFound();
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotAllowed);
      }

      let response: { cipherId: string | undefined; userVerified: boolean; userId?: UserId } = {
        cipherId: cipherOptions[0].cipher.id,
        userId: cipherOptions[0].userId,
        userVerified: false,
      };
      const masterPasswordRepromptRequired = cipherOptions.some(
        ({ cipher }) => cipher.reprompt !== CipherRepromptType.None,
      );

      if (
        this.requiresUserVerificationPrompt(params, cipherOptions, masterPasswordRepromptRequired)
      ) {
        response = await userInterfaceSession.pickCredential({
          cipherIds: cipherOptions.map(({ cipher }) => cipher.id),
          cipherRefs: cipherOptions.map(accountCipherRef),
          userVerification: params.requireUserVerification,
          assumeUserPresence: params.assumeUserPresence,
          masterPasswordRepromptRequired,
        });
      }

      const userVerified = response.userVerified;
      const selected = this.selectedOption(cipherOptions, response);

      if (selected === undefined) {
        this.logService?.error(
          `[Fido2Authenticator] Aborting because the selected credential could not be found.`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotAllowed);
      }

      // The options were decrypted before the user was asked. The account of the selected one may
      // have locked or logged out since, and its credential must not be used then.
      if (
        this.candidateUserIds$ != undefined &&
        !(await this.candidateUserIds()).includes(selected.userId)
      ) {
        this.logService?.warning(
          `[Fido2Authenticator] Aborting because the account of the selected credential is not available.`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotAllowed);
      }

      const selectedCipher = selected.cipher;

      if (
        !userVerified &&
        (params.requireUserVerification || selectedCipher.reprompt !== CipherRepromptType.None)
      ) {
        this.logService?.warning(
          `[Fido2Authenticator] Aborting because user verification was unsuccessful.`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.NotAllowed);
      }

      try {
        const selectedFido2Credential = selectedCipher.login.fido2Credentials[0];
        const selectedCredentialId = selectedFido2Credential.credentialId;

        if (selectedFido2Credential.counter > 0) {
          ++selectedFido2Credential.counter;
        }

        selectedCipher.localData = {
          ...selectedCipher.localData,
          lastUsedDate: new Date().getTime(),
        };

        if (selectedFido2Credential.counter > 0) {
          await this.cipherService.updateWithServer(selectedCipher, selected.userId);
        }

        const authenticatorData = await generateAuthData({
          rpId: selectedFido2Credential.rpId,
          credentialId: parseCredentialId(selectedCredentialId),
          counter: selectedFido2Credential.counter,
          userPresence: true,
          userVerification: userVerified,
        });

        const signature = await generateSignature({
          authData: authenticatorData,
          clientDataHash: params.hash,
          privateKey: await getPrivateKeyFromFido2Credential(selectedFido2Credential),
        });

        return {
          authenticatorData,
          selectedCredential: {
            id: parseCredentialId(selectedCredentialId),
            userHandle: Fido2Utils.stringToArray(selectedFido2Credential.userHandle),
          },
          signature,
        };
      } catch (error) {
        this.logService?.error(
          `[Fido2Authenticator] Aborting because of unknown error when asserting credential: ${error}`,
        );
        throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.Unknown);
      }
    } finally {
      userInterfaceSession.close();
    }
  }

  /** The matching credentials of `userIds`, grouped by account in the order of `userIds`. */
  private async findCredential(
    params: Fido2AuthenticatorGetAssertionParams,
    userIds: UserId[],
  ): Promise<AccountCipher[]> {
    const cipherOptions: AccountCipher[] = [];
    for (const userId of userIds) {
      const ciphers =
        params.allowCredentialDescriptorList?.length > 0
          ? await this.findCredentialsById(
              params.allowCredentialDescriptorList,
              params.rpId,
              userId,
            )
          : await this.findCredentialsByRp(params.rpId, userId);
      cipherOptions.push(...ciphers.map((cipher) => ({ userId, cipher })));
    }
    return cipherOptions;
  }

  /**
   * The option the user interface answered with. An answer that names no account is accepted
   * only when all options belong to one account, since a cipher id alone does not say whose
   * credential was shown to the user.
   */
  private selectedOption(
    cipherOptions: AccountCipher[],
    response: { cipherId: string | undefined; userId?: UserId },
  ): AccountCipher | undefined {
    if (
      response.userId == undefined &&
      cipherOptions.some((o) => o.userId !== cipherOptions[0].userId)
    ) {
      return undefined;
    }

    return cipherOptions.find(
      (option) =>
        option.cipher.id === response.cipherId &&
        (response.userId == undefined || option.userId === response.userId),
    );
  }

  /** The accounts served, read when it is called. */
  private async candidateUserIds(): Promise<UserId[]> {
    if (this.candidateUserIds$ == undefined) {
      return [await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId))];
    }

    return await firstValueFrom(this.candidateUserIds$);
  }

  private lastSync$(userId: UserId): Observable<Date | null> {
    return this.candidateUserIds$ == undefined
      ? this.syncService.activeUserLastSync$()
      : this.syncService.lastSync$(userId);
  }

  private async sync(userId: UserId): Promise<void> {
    if (this.candidateUserIds$ == undefined) {
      await this.syncService.fullSync(false);
      return;
    }

    await this.syncService.fullSync(false, { userId });
  }

  private requiresUserVerificationPrompt(
    params: Fido2AuthenticatorGetAssertionParams,
    cipherOptions: AccountCipher[],
    masterPasswordRepromptRequired: boolean,
  ): boolean {
    return (
      params.requireUserVerification ||
      !params.assumeUserPresence ||
      cipherOptions.length > 1 ||
      cipherOptions.length === 0 ||
      masterPasswordRepromptRequired
    );
  }

  async silentCredentialDiscovery(rpId: string): Promise<Fido2CredentialView[]> {
    const credentials: CipherView[] = [];
    for (const userId of await this.candidateUserIds()) {
      credentials.push(...(await this.findCredentialsByRp(rpId, userId)));
    }
    return credentials.map((c) => c.login.fido2Credentials[0]);
  }

  /** Finds existing credentials in the vaults of `userIds` and returns a reference to each one */
  private async findExcludedCredentials(
    credentials: PublicKeyCredentialDescriptor[],
    userIds: UserId[],
  ): Promise<AccountCipherRef[]> {
    const ids: string[] = [];

    for (const credential of credentials) {
      try {
        ids.push(guidToStandardFormat(credential.id));
        // eslint-disable-next-line no-empty
      } catch {}
    }

    if (ids.length === 0) {
      return [];
    }

    const existing: AccountCipherRef[] = [];
    for (const userId of userIds) {
      const ciphers = await this.passkeyCiphers(userId);
      existing.push(
        ...ciphers
          .filter(
            (cipher) =>
              cipher.organizationId == undefined &&
              ids.includes(cipher.login.fido2Credentials[0].credentialId),
          )
          .map((cipher) => ({ userId, cipherId: cipher.id })),
      );
    }
    return existing;
  }

  private async findCredentialsById(
    credentials: PublicKeyCredentialDescriptor[],
    rpId: string,
    userId: UserId,
  ): Promise<CipherView[]> {
    if (credentials.length === 0) {
      return [];
    }

    const ciphers = await this.passkeyCiphers(userId);
    return ciphers.filter(
      (cipher) =>
        cipher.login.fido2Credentials[0].rpId === rpId &&
        credentials.some((credential) =>
          compareCredentialIds(
            credential.id,
            parseCredentialId(cipher.login.fido2Credentials[0].credentialId),
          ),
        ),
    );
  }

  /**
   * Non-deleted login ciphers holding a passkey, fully decrypted. Picked on list views first,
   * so a passkey lookup never decrypts the whole vault.
   */
  private async passkeyCiphers(userId: UserId): Promise<CipherView[]> {
    const listViews = await firstValueFrom(
      this.cipherService.cipherListViews$(userId).pipe(filterOutNullish()),
    );
    const ids = listViews
      .filter(
        (cipher) =>
          CipherViewLikeUtils.getType(cipher) === CipherType.Login &&
          CipherViewLikeUtils.hasFido2Credentials(cipher) &&
          !CipherViewLikeUtils.isDeleted(cipher),
      )
      .map((cipher) => CipherViewLikeUtils.getId(cipher))
      .filter((id) => id != null);

    return this.cipherService.getAllDecryptedForIds(userId, ids);
  }

  private async findCredentialsByRp(rpId: string, userId: UserId): Promise<CipherView[]> {
    const ciphers = await this.passkeyCiphers(userId);
    return ciphers.filter(
      (cipher) =>
        cipher.login.fido2Credentials[0].rpId === rpId &&
        cipher.login.fido2Credentials[0].discoverable,
    );
  }
}

async function createKeyPair() {
  return await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    KeyUsages,
  );
}

async function createKeyView(
  params: Fido2AuthenticatorMakeCredentialsParams,
  keyValue: CryptoKey,
): Promise<Fido2CredentialView> {
  if (keyValue.algorithm.name !== "ECDSA" && (keyValue.algorithm as any).namedCurve !== "P-256") {
    throw new Fido2AuthenticatorError(Fido2AuthenticatorErrorCode.Unknown);
  }

  await SdkLoadService.Ready; // Required for SdkRandomNumberClient

  const pkcs8Key = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyValue));
  const fido2Credential = new Fido2CredentialView();
  fido2Credential.credentialId = new SdkRandomNumberClient().gen_uuid();
  fido2Credential.keyType = "public-key";
  fido2Credential.keyAlgorithm = "ECDSA";
  fido2Credential.keyCurve = "P-256";
  fido2Credential.keyValue = Fido2Utils.arrayToString(pkcs8Key);
  fido2Credential.rpId = params.rpEntity.id;
  fido2Credential.userHandle = Fido2Utils.arrayToString(params.userEntity.id);
  fido2Credential.userName = params.userEntity.name;
  fido2Credential.counter = 0;
  fido2Credential.rpName = params.rpEntity.name;
  fido2Credential.userDisplayName = params.userEntity.displayName;
  fido2Credential.discoverable = params.requireResidentKey;
  fido2Credential.creationDate = new Date();

  return fido2Credential;
}

async function getPrivateKeyFromFido2Credential(
  fido2Credential: Fido2CredentialView,
): Promise<CryptoKey> {
  const keyBuffer = Fido2Utils.stringToArray(fido2Credential.keyValue);
  return await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(keyBuffer),
    {
      name: fido2Credential.keyAlgorithm,
      namedCurve: fido2Credential.keyCurve,
    } as EcKeyImportParams,
    true,
    KeyUsages,
  );
}

interface AuthDataParams {
  rpId: string;
  credentialId: BufferSource;
  userPresence: boolean;
  userVerification: boolean;
  counter: number;
  keyPair?: CryptoKeyPair;
}

async function generateAuthData(params: AuthDataParams) {
  const authData: Array<number> = [];

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest(
      { name: "SHA-256" },
      Utils.fromByteStringToArray(params.rpId) as BufferSource,
    ),
  );
  authData.push(...rpIdHash);

  const flags = authDataFlags({
    extensionData: false,
    attestationData: params.keyPair != undefined,
    backupEligibility: true,
    backupState: true, // Credentials are always synced
    userVerification: params.userVerification,
    userPresence: params.userPresence,
  });
  authData.push(flags);

  // add 4 bytes of counter - we use time in epoch seconds as monotonic counter
  // TODO: Consider changing this to a cryptographically safe random number
  const counter = params.counter;
  authData.push(
    ((counter & 0xff000000) >> 24) & 0xff,
    ((counter & 0x00ff0000) >> 16) & 0xff,
    ((counter & 0x0000ff00) >> 8) & 0xff,
    counter & 0x000000ff,
  );

  if (params.keyPair) {
    // attestedCredentialData
    const attestedCredentialData: Array<number> = [];

    attestedCredentialData.push(...AAGUID);

    // credentialIdLength (2 bytes) and credential Id
    const rawId = Fido2Utils.bufferSourceToUint8Array(params.credentialId);
    const credentialIdLength = [(rawId.length - (rawId.length & 0xff)) / 256, rawId.length & 0xff];
    attestedCredentialData.push(...credentialIdLength);
    attestedCredentialData.push(...rawId);

    const publicKeyJwk = await crypto.subtle.exportKey("jwk", params.keyPair.publicKey);
    // COSE format of the EC256 key
    const keyX = Utils.fromUrlB64ToArray(publicKeyJwk.x);
    const keyY = Utils.fromUrlB64ToArray(publicKeyJwk.y);

    // Can't get `cbor-redux` to encode in CTAP2 canonical CBOR. So we do it manually:
    const coseBytes = new Uint8Array(77);
    coseBytes.set([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20], 0);
    coseBytes.set(keyX, 10);
    coseBytes.set([0x22, 0x58, 0x20], 10 + 32);
    coseBytes.set(keyY, 10 + 32 + 3);

    // credential public key - convert to array from CBOR encoded COSE key
    attestedCredentialData.push(...coseBytes);

    authData.push(...attestedCredentialData);
  }

  return new Uint8Array(authData);
}

interface SignatureParams {
  authData: Uint8Array;
  clientDataHash: BufferSource;
  privateKey: CryptoKey;
}

async function generateSignature(params: SignatureParams) {
  const sigBase = new Uint8Array([
    ...params.authData,
    ...Fido2Utils.bufferSourceToUint8Array(params.clientDataHash),
  ]);
  const p1363_signature = new Uint8Array(
    await crypto.subtle.sign(
      {
        name: "ECDSA",
        hash: { name: "SHA-256" },
      },
      params.privateKey,
      sigBase,
    ),
  );

  const asn1Der_signature = p1363ToDer(p1363_signature);

  return asn1Der_signature;
}

interface Flags {
  extensionData: boolean;
  attestationData: boolean;
  backupEligibility: boolean;
  backupState: boolean;
  userVerification: boolean;
  userPresence: boolean;
}

function authDataFlags(options: Flags): number {
  let flags = 0;

  if (options.extensionData) {
    flags |= 0b1000000;
  }

  if (options.attestationData) {
    flags |= 0b01000000;
  }

  if (options.backupEligibility) {
    flags |= 0b00001000;
  }

  if (options.backupState) {
    flags |= 0b00010000;
  }

  if (options.userVerification) {
    flags |= 0b00000100;
  }

  if (options.userPresence) {
    flags |= 0b00000001;
  }

  return flags;
}
