import { mock, MockProxy } from "jest-mock-extended";
import { firstValueFrom, of } from "rxjs";

import { FakeAccountService, FakeStateProvider, mockAccountServiceWith } from "../../../../spec";
import { OrganizationService } from "../../../admin-console/abstractions/organization/organization.service.abstraction";
import { Organization } from "../../../admin-console/models/domain/organization";
import { AuthService } from "../../../auth/abstractions/auth.service";
import { AuthenticationStatus } from "../../../auth/enums/authentication-status";
import { UserId } from "../../../types/guid";
import { CipherService } from "../../../vault/abstractions/cipher.service";
import { Cipher } from "../../../vault/models/domain/cipher";
import { EventUploadService } from "../abstractions/event-upload.service";
import { EventType } from "../enums/event-type.enum";

import { EventCollectionService } from "./event-collection.service";
import { EVENT_COLLECTION } from "./key-definitions";

describe("EventCollectionService", () => {
  const activeUserId = "00000000-0000-0000-0000-000000000001" as UserId;
  const otherUserId = "00000000-0000-0000-0000-000000000002" as UserId;
  const cipherId = "cipher-id";
  const organizationId = "org-id";

  let accountService: FakeAccountService;
  let stateProvider: FakeStateProvider;
  let cipherService: MockProxy<CipherService>;
  let organizationService: MockProxy<OrganizationService>;
  let eventUploadService: MockProxy<EventUploadService>;
  let authService: MockProxy<AuthService>;
  let eventCollectionService: EventCollectionService;

  const storedEvents = (userId: UserId) =>
    firstValueFrom(stateProvider.getUser(userId, EVENT_COLLECTION).state$);

  beforeEach(() => {
    accountService = mockAccountServiceWith(activeUserId);
    stateProvider = new FakeStateProvider(accountService);
    cipherService = mock();
    organizationService = mock();
    eventUploadService = mock();
    authService = mock();

    cipherService.get.mockResolvedValue({ id: cipherId, organizationId } as Cipher);
    organizationService.organizations$.mockReturnValue(
      of([{ id: organizationId, useEvents: true } as Organization]),
    );
    authService.authStatusFor$.mockReturnValue(of(AuthenticationStatus.Unlocked));

    eventCollectionService = new EventCollectionService(
      cipherService,
      stateProvider,
      organizationService,
      eventUploadService,
      authService,
      accountService,
    );
  });

  describe("collect", () => {
    it("records for the active user when no user is given", async () => {
      await eventCollectionService.collect(EventType.Cipher_ClientAutofilled, cipherId, true);

      expect(await storedEvents(activeUserId)).toEqual([
        expect.objectContaining({ type: EventType.Cipher_ClientAutofilled, cipherId }),
      ]);
      expect(await storedEvents(otherUserId)).toBeNull();
      expect(cipherService.get).toHaveBeenCalledWith(cipherId, activeUserId);
      expect(authService.authStatusFor$).toHaveBeenCalledWith(activeUserId);
      expect(eventUploadService.uploadEvents).toHaveBeenCalledWith(activeUserId);
    });

    it("records for the given user: their cipher, organizations, lock state and upload", async () => {
      await eventCollectionService.collect(
        EventType.Cipher_ClientAutofilled,
        cipherId,
        true,
        undefined,
        otherUserId,
      );

      expect(await storedEvents(otherUserId)).toEqual([
        expect.objectContaining({ type: EventType.Cipher_ClientAutofilled, cipherId }),
      ]);
      expect(await storedEvents(activeUserId)).toBeNull();
      expect(cipherService.get).toHaveBeenCalledWith(cipherId, otherUserId);
      expect(organizationService.organizations$).toHaveBeenCalledWith(otherUserId);
      expect(authService.authStatusFor$).toHaveBeenCalledWith(otherUserId);
      expect(eventUploadService.uploadEvents).toHaveBeenCalledWith(otherUserId);
    });

    it("records nothing for a given user who is locked", async () => {
      authService.authStatusFor$.mockImplementation((userId) =>
        of(userId === otherUserId ? AuthenticationStatus.Locked : AuthenticationStatus.Unlocked),
      );

      await eventCollectionService.collect(
        EventType.Cipher_ClientAutofilled,
        cipherId,
        false,
        undefined,
        otherUserId,
      );

      expect(await storedEvents(otherUserId)).toBeNull();
    });
  });
});
