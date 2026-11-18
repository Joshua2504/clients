import {
  BehaviorSubject,
  EmptyError,
  filter,
  firstValueFrom,
  fromEvent,
  map,
  merge,
  Observable,
  Subject,
  switchMap,
  take,
  takeUntil,
  throwError,
} from "rxjs";

import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { AccountCipherRef } from "@bitwarden/common/autofill/types/account-cipher";
import { UserRequestedFallbackAbortReason } from "@bitwarden/common/platform/abstractions/fido2/fido2-client.service.abstraction";
import {
  Fido2UserInterfaceService as Fido2UserInterfaceServiceAbstraction,
  Fido2UserInterfaceSession,
  NewCredentialParams,
  PickCredentialParams,
} from "@bitwarden/common/platform/abstractions/fido2/fido2-user-interface.service.abstraction";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { UserId } from "@bitwarden/common/types/guid";

import { BrowserApi } from "../../../platform/browser/browser-api";
import { fromChromeEvent } from "../../../platform/browser/from-chrome-event";
// FIXME (PM-22628): Popup imports are forbidden in background
// eslint-disable-next-line no-restricted-imports
import { closeFido2Popout, openFido2Popout } from "../../../vault/popup/utils/vault-popout-window";

const BrowserFido2MessageName = "BrowserFido2UserInterfaceServiceMessage";

export const BrowserFido2MessageTypes = {
  ConnectResponse: "ConnectResponse",
  NewSessionCreatedRequest: "NewSessionCreatedRequest",
  PickCredentialRequest: "PickCredentialRequest",
  PickCredentialResponse: "PickCredentialResponse",
  ConfirmNewCredentialRequest: "ConfirmNewCredentialRequest",
  ConfirmNewCredentialResponse: "ConfirmNewCredentialResponse",
  InformExcludedCredentialRequest: "InformExcludedCredentialRequest",
  InformCredentialNotFoundRequest: "InformCredentialNotFoundRequest",
  AbortRequest: "AbortRequest",
  AbortResponse: "AbortResponse",
} as const;

export type BrowserFido2MessageTypeValue =
  (typeof BrowserFido2MessageTypes)[keyof typeof BrowserFido2MessageTypes];

export class SessionClosedError extends Error {
  constructor() {
    super("Fido2UserInterfaceSession was closed");
  }
}

export type BrowserFido2Message = { sessionId: string } & (
  | /**
     * This message is used by popouts to announce that they are ready
     * to receive messages.
     **/ {
      type: typeof BrowserFido2MessageTypes.ConnectResponse;
    }
    /**
     * This message is used to announce the creation of a new session.
     * It is used by popouts to know when to close.
     **/
  | {
      type: typeof BrowserFido2MessageTypes.NewSessionCreatedRequest;
    }
  | {
      type: typeof BrowserFido2MessageTypes.PickCredentialRequest;
      /** The credentials to pick from, each with the account whose vault holds it. */
      cipherRefs: AccountCipherRef[];
      userVerification: boolean;
      fallbackSupported: boolean;
    }
  | {
      type: typeof BrowserFido2MessageTypes.PickCredentialResponse;
      /** The account of the picked cipher, as named in the request. */
      userId: UserId;
      cipherId: string;
      /** The result of verifying the user of `userId`. */
      userVerified: boolean;
    }
  | {
      type: typeof BrowserFido2MessageTypes.ConfirmNewCredentialRequest;
      credentialName: string;
      userName: string;
      userHandle: string;
      userVerification: boolean;
      fallbackSupported: boolean;
      rpId: string;
      /** The accounts the passkey may be saved to, the default first. */
      userIds: UserId[];
    }
  | {
      type: typeof BrowserFido2MessageTypes.ConfirmNewCredentialResponse;
      /**
       * The account whose vault holds the cipher. Left out by a sender that only ever saves to
       * the active account; the cipher is then looked up there.
       */
      userId?: UserId;
      cipherId: string;
      /** The result of verifying the user of that account. */
      userVerified: boolean;
    }
  | {
      type: typeof BrowserFido2MessageTypes.InformExcludedCredentialRequest;
      /** The excluded credentials, each with the account whose vault holds it. */
      existingCipherRefs: AccountCipherRef[];
      fallbackSupported: boolean;
    }
  | {
      type: typeof BrowserFido2MessageTypes.InformCredentialNotFoundRequest;
      fallbackSupported: boolean;
    }
  | {
      type: typeof BrowserFido2MessageTypes.AbortRequest;
    }
  | {
      type: typeof BrowserFido2MessageTypes.AbortResponse;
      fallbackRequested: boolean;
    }
);

/**
 * The tab hosting a WebAuthn request, along with the URL of the frame within it that made the
 * request. Anything scoped to the requesting site uses the frame URL, because a sub-frame's origin
 * is not the tab's.
 */
export type BrowserFido2ParentWindowReference = chrome.tabs.Tab & {
  requestFrameUrl: string | undefined;
};

/**
 * Browser implementation of the {@link Fido2UserInterfaceService}.
 * The user interface is implemented as a popout and the service uses the browser's messaging API to communicate with it.
 */
export class BrowserFido2UserInterfaceService implements Fido2UserInterfaceServiceAbstraction<BrowserFido2ParentWindowReference> {
  /**
   * @param servedUserIds$ The accounts whose vaults serve passkeys, as from
   * `AutofillAccountsService.autofillUserIds$`. While any of them serves, the user is not asked
   * to unlock the active account. Without it, the active account must be unlocked.
   */
  constructor(
    private authService: AuthService,
    private servedUserIds$?: Observable<UserId[]>,
  ) {}

  async newSession(
    fallbackSupported: boolean,
    tab: BrowserFido2ParentWindowReference,
    abortController?: AbortController,
  ): Promise<Fido2UserInterfaceSession> {
    return await BrowserFido2UserInterfaceSession.create(
      this.authService,
      fallbackSupported,
      tab,
      abortController,
      this.servedUserIds$,
    );
  }
}

export class BrowserFido2UserInterfaceSession implements Fido2UserInterfaceSession {
  static async create(
    authService: AuthService,
    fallbackSupported: boolean,
    tab: BrowserFido2ParentWindowReference,
    abortController?: AbortController,
    servedUserIds$?: Observable<UserId[]>,
  ): Promise<BrowserFido2UserInterfaceSession> {
    return new BrowserFido2UserInterfaceSession(
      authService,
      fallbackSupported,
      tab,
      abortController,
      undefined,
      servedUserIds$,
    );
  }

  static sendMessage(msg: BrowserFido2Message) {
    void BrowserApi.sendMessage(BrowserFido2MessageName, msg);
  }

  static abortPopout(sessionId: string, fallbackRequested = false) {
    this.sendMessage({
      sessionId: sessionId,
      type: BrowserFido2MessageTypes.AbortResponse,
      fallbackRequested: fallbackRequested,
    });
  }

  /**
   * @param userId The account whose vault holds the cipher. Without it the cipher is looked up
   * in the active account.
   */
  static confirmNewCredentialResponse(
    sessionId: string,
    cipherId: string,
    userVerified: boolean,
    userId?: UserId,
  ) {
    this.sendMessage({
      sessionId: sessionId,
      type: BrowserFido2MessageTypes.ConfirmNewCredentialResponse,
      cipherId,
      userVerified,
      ...(userId != undefined ? { userId } : {}),
    });
  }

  private closed = false;
  private messages$ = (BrowserApi.messageListener$() as Observable<BrowserFido2Message>).pipe(
    filter((msg) => msg.sessionId === this.sessionId),
  );
  private connected$ = new BehaviorSubject(false);
  private windowClosed$: Observable<number>;
  private destroy$ = new Subject<void>();

  private constructor(
    private readonly authService: AuthService,
    private readonly fallbackSupported: boolean,
    private readonly tab: BrowserFido2ParentWindowReference,
    readonly abortController = new AbortController(),
    readonly sessionId = Utils.newGuid(),
    private readonly servedUserIds$?: Observable<UserId[]>,
  ) {
    this.messages$
      .pipe(
        filter((msg) => msg.type === BrowserFido2MessageTypes.ConnectResponse),
        take(1),
        takeUntil(this.destroy$),
      )
      .subscribe(() => {
        this.connected$.next(true);
      });

    // Handle session aborted by RP
    fromEvent(abortController.signal, "abort")
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        void this.close();
        BrowserFido2UserInterfaceSession.sendMessage({
          type: BrowserFido2MessageTypes.AbortRequest,
          sessionId: this.sessionId,
        });
      });

    // Handle session aborted by user
    this.messages$
      .pipe(
        filter((msg) => msg.type === BrowserFido2MessageTypes.AbortResponse),
        take(1),
        takeUntil(this.destroy$),
      )
      .subscribe((msg) => {
        if (msg.type === BrowserFido2MessageTypes.AbortResponse) {
          void this.close();
          void this.abort(msg.fallbackRequested);
        }
      });

    this.windowClosed$ = fromChromeEvent(chrome.windows.onRemoved).pipe(
      map(([windowId]) => windowId),
    );

    BrowserFido2UserInterfaceSession.sendMessage({
      type: BrowserFido2MessageTypes.NewSessionCreatedRequest,
      sessionId,
    });
  }

  async pickCredential({
    cipherRefs,
    userVerification,
    assumeUserPresence,
    masterPasswordRepromptRequired,
  }: PickCredentialParams): Promise<{ cipherId: string; userVerified: boolean; userId: UserId }> {
    if (cipherRefs == undefined) {
      // A cipher id does not say which account's credential would be shown to the user.
      throw new Error("Cannot pick a credential without knowing the account of each cipher");
    }

    // NOTE: For now, we are defaulting to a userVerified status of `true` when the request
    // is for a conditionally mediated authentication. This will allow for mediated conditional
    // authentication to function without requiring user interaction. This is a product
    // decision, rather than a decision based on the expected technical specifications.
    if (assumeUserPresence && cipherRefs.length === 1 && !masterPasswordRepromptRequired) {
      return { ...cipherRefs[0], userVerified: userVerification };
    }

    const data: BrowserFido2Message = {
      type: BrowserFido2MessageTypes.PickCredentialRequest,
      cipherRefs,
      sessionId: this.sessionId,
      userVerification,
      fallbackSupported: this.fallbackSupported,
    };

    await this.send(data);
    const response = await this.receive(BrowserFido2MessageTypes.PickCredentialResponse);

    return {
      cipherId: response.cipherId,
      userId: response.userId,
      userVerified: response.userVerified,
    };
  }

  async confirmNewCredential({
    credentialName,
    userName,
    userHandle,
    userVerification,
    rpId,
    userIds,
  }: NewCredentialParams): Promise<{ cipherId: string; userVerified: boolean; userId?: UserId }> {
    const data: BrowserFido2Message = {
      type: BrowserFido2MessageTypes.ConfirmNewCredentialRequest,
      sessionId: this.sessionId,
      credentialName,
      userName,
      userHandle,
      userVerification,
      fallbackSupported: this.fallbackSupported,
      rpId,
      userIds: userIds ?? [],
    };

    await this.send(data);
    const response = await this.receive(BrowserFido2MessageTypes.ConfirmNewCredentialResponse);

    return {
      cipherId: response.cipherId,
      userId: response.userId,
      userVerified: response.userVerified,
    };
  }

  async informExcludedCredential(
    existingCipherIds: string[],
    existingCipherRefs?: AccountCipherRef[],
  ): Promise<void> {
    if (existingCipherRefs == undefined) {
      throw new Error("Cannot show an excluded credential without knowing its account");
    }

    const data: BrowserFido2Message = {
      type: BrowserFido2MessageTypes.InformExcludedCredentialRequest,
      sessionId: this.sessionId,
      existingCipherRefs,
      fallbackSupported: this.fallbackSupported,
    };

    await this.send(data);
    await this.receive(BrowserFido2MessageTypes.AbortResponse);
  }

  /**
   * Opens the popout for the user to unlock when no vault can answer the request. An account
   * that serves passkeys can, so the user is then not asked to unlock the active account: its
   * passkeys are not found until it is unlocked.
   */
  async ensureUnlockedVault(): Promise<void> {
    if (
      this.servedUserIds$ != undefined &&
      (await firstValueFrom(this.servedUserIds$)).length > 0
    ) {
      return;
    }
    if ((await this.authService.getAuthStatus()) !== AuthenticationStatus.Unlocked) {
      await this.connect();
    }
  }

  async informCredentialNotFound(): Promise<void> {
    const data: BrowserFido2Message = {
      type: BrowserFido2MessageTypes.InformCredentialNotFoundRequest,
      sessionId: this.sessionId,
      fallbackSupported: this.fallbackSupported,
    };

    await this.send(data);
    await this.receive(BrowserFido2MessageTypes.AbortResponse);
  }

  async close() {
    await closeFido2Popout(this.sessionId);
    this.closed = true;
    this.destroy$.next();
    this.destroy$.complete();
  }

  private async abort(fallback = false) {
    this.abortController.abort(fallback ? UserRequestedFallbackAbortReason : undefined);
  }

  private async send(msg: BrowserFido2Message): Promise<void> {
    if (!this.connected$.value) {
      await this.connect();
    }
    BrowserFido2UserInterfaceSession.sendMessage(msg);
  }

  private async receive<T extends BrowserFido2Message["type"]>(
    type: T,
  ): Promise<BrowserFido2Message & { type: T }> {
    try {
      const response = await firstValueFrom(
        this.messages$.pipe(
          filter((msg) => msg.sessionId === this.sessionId && msg.type === type),
          takeUntil(this.destroy$),
        ),
      );
      return response as BrowserFido2Message & { type: T };
    } catch (error) {
      if (error instanceof EmptyError) {
        throw new SessionClosedError();
      }
      throw error;
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot re-open closed session");
    }

    const connectPromise = firstValueFrom(
      merge(
        this.connected$.pipe(filter((connected) => connected === true)),
        fromEvent(this.abortController.signal, "abort").pipe(
          switchMap(() => throwError(() => new SessionClosedError())),
        ),
      ),
    );

    // Defensive measure in case an existing notification appeared before the passkey popout
    await BrowserApi.tabSendMessageData(this.tab, "closeNotificationBar");

    const popoutId = await openFido2Popout(this.tab, {
      sessionId: this.sessionId,
      fallbackSupported: this.fallbackSupported,
      senderUrl: this.tab.requestFrameUrl,
    });

    this.windowClosed$
      .pipe(
        filter((windowId) => {
          return popoutId === windowId;
        }),
        takeUntil(this.destroy$),
      )
      .subscribe(() => {
        void this.close();
        void this.abort(true);
      });

    await connectPromise;
  }
}
