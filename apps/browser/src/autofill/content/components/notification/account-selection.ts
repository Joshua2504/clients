import { css } from "@emotion/css";
import { html } from "lit";

import { Theme } from "@bitwarden/common/platform/enums";

import { AccountView, I18n, Option } from "../common-types";
import { User } from "../icons";
import { optionSelectionTagName } from "../option-selection/option-selection";

export type NotificationAccountSelectionProps = {
  accounts: AccountView[];
  i18n: I18n;
  theme: Theme;
  handleAccountSelection: (userId: string) => void;
};

/** The account a new login is saved to. Rendered only when more than one account can save it. */
export function NotificationAccountSelection({
  accounts,
  i18n,
  theme,
  handleAccountSelection,
}: NotificationAccountSelectionProps) {
  const options: Option[] = accounts.map(({ id, email, selected }) => ({
    icon: User,
    text: email,
    value: id,
    default: selected,
  }));

  return html`
    <div class=${accountSelectionStyles}>
      <option-selection
        key="account"
        theme=${theme}
        .id=${"account"}
        .label=${i18n.notificationAccount}
        .options=${options}
        .handleSelectionUpdate=${handleAccountSelection}
      ></option-selection>
    </div>
  `;
}

const accountSelectionStyles = css`
  display: flex;
  justify-content: flex-start;
  overflow: hidden;
  white-space: nowrap;

  > ${optionSelectionTagName} {
    min-width: 120px;
    max-width: 100%;
  }
`;
