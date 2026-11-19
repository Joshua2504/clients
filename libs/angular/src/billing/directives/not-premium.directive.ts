import { DestroyRef, Directive, Input, OnInit, TemplateRef, ViewContainerRef } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { BehaviorSubject, firstValueFrom, Subscription } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { BillingAccountProfileStateService } from "@bitwarden/common/billing/abstractions/account/billing-account-profile-state.service";
import { UserId } from "@bitwarden/common/types/guid";

/**
 * Hides the element if the user has premium.
 *
 * `*appNotPremium` asks about the active account. `*appNotPremium="userId"` asks about that
 * account instead, for an element that belongs to an item of another account.
 */
@Directive({
  selector: "[appNotPremium]",
})
export class NotPremiumDirective implements OnInit {
  private readonly userId$ = new BehaviorSubject<UserId | undefined>(undefined);

  /** The premium status being followed: the named account's, else the active account's. */
  private premiumSubscription?: Subscription;

  /** The account whose premium decides. Defaults to the active account. */
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input()
  set appNotPremium(userId: UserId | "" | null | undefined) {
    const next = userId == null || userId === "" ? undefined : userId;
    if (next !== this.userId$.value) {
      this.userId$.next(next);
    }
  }

  constructor(
    private templateRef: TemplateRef<any>,
    private viewContainer: ViewContainerRef,
    private billingAccountProfileStateService: BillingAccountProfileStateService,
    private destroyRef: DestroyRef,
    private accountService: AccountService,
  ) {}

  ngOnInit(): void {
    let first = true;
    this.userId$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((userId) => {
      this.premiumSubscription?.unsubscribe();
      if (!first) {
        // The element is now about another account: what the previous one showed goes.
        this.viewContainer.clear();
      }
      first = false;

      if (userId == null) {
        void this.followActiveAccount();
      } else {
        this.followAccount(userId);
      }
    });
  }

  /** Without a named account: the account that is active now, as the directive always did. */
  private async followActiveAccount(): Promise<void> {
    const account = await firstValueFrom(this.accountService.activeAccount$);

    if (this.userId$.value != null) {
      // An account was named in the meantime.
      return;
    }

    if (!account) {
      this.viewContainer.createEmbeddedView(this.templateRef);
      return;
    }

    this.premiumSubscription = this.billingAccountProfileStateService
      .hasPremiumFromAnySource$(account.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((premium) => {
        if (premium) {
          this.viewContainer.clear();
        } else {
          this.viewContainer.createEmbeddedView(this.templateRef);
        }
      });
  }

  /** The premium of the named account, whichever account is active. */
  private followAccount(userId: UserId): void {
    this.premiumSubscription = this.billingAccountProfileStateService
      .hasPremiumFromAnySource$(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((premium) => {
        this.viewContainer.clear();
        if (!premium) {
          this.viewContainer.createEmbeddedView(this.templateRef);
        }
      });
  }
}
