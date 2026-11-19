import { Observable } from "rxjs";

// This import has been flagged as unallowed for this class. It may be involved in a circular dependency loop.
// eslint-disable-next-line no-restricted-imports
import { UserKeyRotationDataProvider } from "@bitwarden/key-management";
// eslint-disable-next-line no-restricted-imports
import { EncArrayBuffer, SymmetricCryptoKey } from "@bitwarden/legacy-crypto";

import { UserId } from "../../../types/guid";
import { UserKey } from "../../../types/key";
import { SendData } from "../models/data/send.data";
import { Send } from "../models/domain/send";
import { SendWithIdRequest } from "../models/request/send-with-id.request";
import { SendView } from "../models/view/send.view";

export abstract class SendService implements UserKeyRotationDataProvider<SendWithIdRequest> {
  abstract sends$: Observable<Send[]>;
  abstract sendViews$: Observable<SendView[]>;
  /**
   * The decrypted sends of the given user, whether or not that user is the active account,
   * sorted by name like {@link sendViews$}.
   * @param userId The user whose sends to read. It must be unlocked.
   */
  abstract sendViewsFor$(userId: UserId): Observable<SendView[]>;

  /**
   * @param file The plaintext file bytes for a file send create, or `null` for text sends and
   *   edits.
   * @param password The plaintext password, when the user set or changed one. `null`/`undefined`
   *   means no password. Protected Data — never log it.
   */
  abstract encrypt(
    model: SendView,
    file: File | ArrayBuffer | null,
    password?: string,
    key?: SymmetricCryptoKey,
  ): Promise<[Send, EncArrayBuffer]>;
  /**
   * Provides a send for a determined id
   * updates after a change occurs to the send that matches the id
   * @param id The id of the desired send
   * @param userId The user whose send to read. Defaults to the active account.
   * @returns An observable that listens to the value of the desired send
   */
  abstract get$(id: string, userId?: UserId): Observable<Send | undefined>;
  /**
   * Provides re-encrypted user sends for the key rotation process
   * @param newUserKey The new user key to use for re-encryption
   * @throws Error if the new user key is null or undefined
   * @returns A list of user sends that have been re-encrypted with the new user key
   */
  abstract getRotatedData(
    originalUserKey: UserKey,
    newUserKey: UserKey,
    userId: UserId,
  ): Promise<SendWithIdRequest[]>;
  /**
   * @deprecated Do not call this, use the sends$ observable collection
   */
  abstract getAll(): Promise<Send[]>;
  /**
   * Reads from the active account, or from `userId` when it is given.
   * @deprecated Only use in CLI
   */
  abstract getFromState(id: string, userId?: UserId): Promise<Send>;
  /**
   * @deprecated Only use in CLI
   */
  abstract getAllDecryptedFromState(userId: UserId): Promise<SendView[]>;
}

export abstract class InternalSendService extends SendService {
  /**
   * Adds or replaces sends of the active account, or of `userId` when it is given.
   */
  abstract upsert(send: SendData | SendData[], userId?: UserId): Promise<any>;
  abstract replace(sends: { [id: string]: SendData }, userId: UserId): Promise<void>;
  /**
   * Deletes sends from the active account, or from `userId` when it is given.
   */
  abstract delete(id: string | string[], userId?: UserId): Promise<any>;
}
