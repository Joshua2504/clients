import { UserId } from "../../../types/guid";
import { CipherView } from "../../../vault/models/view/cipher.view";
import { EventType } from "../enums/event-type.enum";

export abstract class EventCollectionService {
  abstract collectMany(
    eventType: EventType,
    ciphers: CipherView[],
    uploadImmediately?: boolean,
    /** The account to record for. Defaults to the active account. */
    userId?: UserId,
  ): Promise<any>;
  abstract collect(
    eventType: EventType,
    cipherId?: string,
    uploadImmediately?: boolean,
    organizationId?: string,
    /** The account to record for. Defaults to the active account. */
    userId?: UserId,
  ): Promise<any>;
}
