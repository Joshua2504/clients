import { computed, inject, Injectable, Injector, Signal, signal } from "@angular/core";
import { toObservable } from "@angular/core/rxjs-interop";
import { defer, firstValueFrom, Observable, of, switchMap } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getOptionalUserId } from "@bitwarden/common/auth/services/account.service";
import { UserId } from "@bitwarden/common/types/guid";

/**
 * Names the account whose vault holds the cipher that a view or form shows.
 *
 * The vault item components resolve "the user" through this context instead of reading the active
 * account. The root instance is never bound and always resolves to the active account, which is
 * the behaviour of every host that does not name an account. A host that shows a cipher of another
 * account provides its own instance and binds it to that account:
 *
 * ```ts
 * @Component({ providers: [CipherAccountContext] })
 * class HostComponent {
 *   readonly userId = input<UserId>();
 *   private readonly account = inject(CipherAccountContext, { self: true }).bind(this.userId);
 * }
 * ```
 *
 * `CipherViewComponent` does this for its `userId` input, so everything it renders follows it.
 * A component opened through `DialogService` does not inherit the instance; pass it the account
 * in its dialog data.
 */
@Injectable({ providedIn: "root" })
export class CipherAccountContext {
  private readonly injector = inject(Injector);
  private readonly source = signal<Signal<UserId | null | undefined> | undefined>(undefined);
  private bound$: Observable<UserId | undefined> | undefined;

  /**
   * The account the host named, `undefined` when it named none. Pass it as the trailing `userId`
   * of an account-scoped call, which then defaults to the active account.
   */
  readonly explicitUserId: Signal<UserId | undefined> = computed(
    () => this.source()?.() ?? undefined,
  );

  /** The account the host named, else the active account. `null` while there is neither. */
  readonly userId$: Observable<UserId | null> = defer(() =>
    (this.bound$ ?? of(undefined)).pipe(
      switchMap((userId) =>
        userId != null
          ? of(userId)
          : this.injector.get(AccountService).activeAccount$.pipe(getOptionalUserId),
      ),
    ),
  );

  /**
   * Makes the context follow `userId`. Call it while the component that provides the context is
   * constructed, before anything reads the context. While `userId` holds no account, the context
   * resolves to the active account.
   * @returns The context.
   */
  bind(userId: Signal<UserId | null | undefined>): this {
    this.source.set(userId);
    this.bound$ = toObservable(this.explicitUserId, { injector: this.injector });
    return this;
  }

  /** {@link userId$} once. */
  userId(): Promise<UserId | null> {
    const explicit = this.explicitUserId();
    return explicit != null ? Promise.resolve(explicit) : firstValueFrom(this.userId$);
  }
}
