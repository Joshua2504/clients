import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { toObservable, toSignal } from "@angular/core/rxjs-interop";
import { combineLatest, of, switchMap } from "rxjs";

import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { UserId } from "@bitwarden/common/types/guid";
import {
  CipherViewLike,
  CipherViewLikeUtils,
} from "@bitwarden/common/vault/utils/cipher-view-like-utils";

import { VAULT_ROW_SUBTITLE, VaultRowSubtitle } from "./vault-row-subtitle.token";

/** A popup row's subtitle: the {@link VAULT_ROW_SUBTITLE} provider's text, else the cipher's own. */
@Component({
  selector: "app-vault-row-subtitle",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ text() }}`,
})
export class VaultRowSubtitleComponent {
  readonly cipher = input<CipherViewLike | null>(null);

  /** The account whose vault holds the cipher, for a row of an account other than the active one. */
  readonly userId = input<UserId | undefined>(undefined);

  private readonly i18nService = inject(I18nService);
  private readonly provider: VaultRowSubtitle | null = inject(VAULT_ROW_SUBTITLE, {
    optional: true,
  });

  private readonly contributed = toSignal(
    combineLatest([toObservable(this.cipher), toObservable(this.userId)]).pipe(
      switchMap(([cipher, userId]) => {
        if (cipher == null || this.provider == null) {
          return of(null);
        }
        return userId == null
          ? this.provider.subtitle$(cipher)
          : this.provider.subtitle$(cipher, userId);
      }),
    ),
    { initialValue: null },
  );

  protected readonly text = computed(() => {
    const cipher = this.cipher();
    if (cipher == null) {
      return "";
    }
    return this.contributed() ?? CipherViewLikeUtils.subtitle(cipher, this.i18nService) ?? "";
  });
}
