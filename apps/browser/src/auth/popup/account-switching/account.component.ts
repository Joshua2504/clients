// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { CommonModule } from "@angular/common";
import {
  booleanAttribute,
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  inject,
  input,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormControl, ReactiveFormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { Observable, ReplaySubject, distinctUntilChanged, switchMap } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { AutofillAccountsService } from "@bitwarden/common/autofill/services/autofill-accounts.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { UserId } from "@bitwarden/common/types/guid";
import {
  AvatarModule,
  FormControlModule,
  IconModule,
  ItemModule,
  SwitchComponent,
  type BitwardenIcon,
} from "@bitwarden/components";
import { BiometricsService } from "@bitwarden/key-management";

import { AccountSwitcherService, AvailableAccount } from "./services/account-switcher.service";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "auth-account",
  templateUrl: "account.component.html",
  imports: [
    CommonModule,
    JslibModule,
    ReactiveFormsModule,
    AvatarModule,
    FormControlModule,
    IconModule,
    ItemModule,
    SwitchComponent,
  ],
})
export class AccountComponent implements OnChanges {
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input() account: AvailableAccount;
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output() loading = new EventEmitter<boolean>();
  /**
   * Whether to offer the opt-in to serve autofill while another account is active. The parent
   * offers it only while more than one account is logged in.
   */
  readonly offerAutofillOptIn = input(false, { transform: booleanAttribute });

  private readonly autofillAccountsService = inject(AutofillAccountsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly userId$ = new ReplaySubject<UserId>(1);

  /** Bound to the account's autofill opt-in. Changeable only while the account is unlocked. */
  protected readonly autofillOptIn = new FormControl(false, { nonNullable: true });

  /** Whether autofill currently reads this account's vault. */
  protected readonly servesAutofill$: Observable<boolean> = this.userId$.pipe(
    distinctUntilChanged(),
    switchMap((userId) => this.autofillAccountsService.isAutofillUser$(userId)),
  );

  constructor(
    private accountSwitcherService: AccountSwitcherService,
    private router: Router,
    private i18nService: I18nService,
    private logService: LogService,
    private biometricsService: BiometricsService,
  ) {
    this.userId$
      .pipe(
        distinctUntilChanged(),
        switchMap((userId) => this.autofillAccountsService.enabled$(userId)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((enabled) => this.autofillOptIn.setValue(enabled, { emitEvent: false }));

    this.autofillOptIn.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((enabled) => void this.setAutofillOptIn(enabled));
  }

  ngOnChanges() {
    if (this.account == null || this.account.id === this.specialAccountAddId) {
      return;
    }

    if (this.isUnlocked) {
      this.autofillOptIn.enable({ emitEvent: false });
    } else {
      this.autofillOptIn.disable({ emitEvent: false });
    }
    this.userId$.next(this.account.id as UserId);
  }

  protected get isUnlocked(): boolean {
    return this.account?.status === AuthenticationStatus.Unlocked;
  }

  get specialAccountAddId() {
    return this.accountSwitcherService.SPECIAL_ADD_ACCOUNT_ID;
  }

  async selectAccount(id: string) {
    this.loading.emit(true);
    let result;
    try {
      result = await this.accountSwitcherService.selectAccount(id);
    } catch (e) {
      this.logService.error("Error selecting account", e);
    }

    // Navigate out of account switching for unlocked accounts
    // locked or logged out account statuses are handled by background and app.component
    if (result?.authenticationStatus === AuthenticationStatus.Unlocked) {
      await this.router.navigate(["vault"]);
      await this.biometricsService.setShouldAutopromptNow(false);
    } else {
      await this.biometricsService.setShouldAutopromptNow(true);
    }
    this.loading.emit(false);
  }

  private async setAutofillOptIn(enabled: boolean) {
    const userId = this.account.id as UserId;
    // The opt-in is a preference of the account and may only be changed while it is unlocked.
    if (!this.isUnlocked) {
      this.autofillOptIn.setValue(!enabled, { emitEvent: false });
      return;
    }

    try {
      await this.autofillAccountsService.setEnabled(userId, enabled);
    } catch (e) {
      this.logService.error("Error saving the autofill setting of the account", e);
      this.autofillOptIn.setValue(!enabled, { emitEvent: false });
    }
  }

  get status(): { text: string; icon: BitwardenIcon } {
    if (this.account.isActive) {
      return { text: this.i18nService.t("active"), icon: "bwi-check-circle" };
    }

    if (this.account.status === AuthenticationStatus.Unlocked) {
      return { text: this.i18nService.t("unlocked"), icon: "bwi-unlock" };
    }

    return { text: this.i18nService.t("locked"), icon: "bwi-lock" };
  }
}
