// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { Observable } from "rxjs";
import type { Simplify } from "type-fest";

import { CombinedState } from "../../../platform/state";
import { UserId } from "../../../types/guid";
import { SendData } from "../models/data/send.data";
import { SendView } from "../models/view/send.view";

type EncryptedSendState = Simplify<CombinedState<Record<string, SendData>>>;
export abstract class SendStateProvider {
  encryptedState$: Observable<EncryptedSendState>;
  decryptedState$: Observable<SendView[]>;

  /**
   * The encrypted sends of the given user, whether or not that user is the active account.
   * @param userId The user whose sends to read.
   */
  encryptedStateFor$: (userId: UserId) => Observable<EncryptedSendState>;

  /**
   * Gets the encrypted sends of the active account, or of `userId` when it is given.
   */
  getEncryptedSends: (userId?: UserId) => Promise<EncryptedSendState>;

  setEncryptedSends: (value: { [id: string]: SendData }, userId: UserId) => Promise<void>;

  getDecryptedSends: () => Promise<SendView[]>;

  setDecryptedSends: (value: SendView[]) => Promise<void>;
}
