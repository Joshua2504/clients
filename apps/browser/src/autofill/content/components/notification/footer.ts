import { css } from "@emotion/css";
import { html, nothing } from "lit";

import { Theme } from "@bitwarden/common/platform/enums";

import {
  NotificationType,
  NotificationTypes,
} from "../../../notification/abstractions/notification-bar";
import { AccountView, OrgView, FolderView, I18n, CollectionView } from "../common-types";
import { spacing } from "../constants/styles";

import { NotificationAccountSelection } from "./account-selection";
import { NotificationButtonRow } from "./button-row";

export type NotificationFooterProps = {
  /** The accounts the login can be saved to. The selector shows only for more than one. */
  accounts?: AccountView[];
  collections?: CollectionView[];
  folders?: FolderView[];
  i18n: I18n;
  isLoading?: boolean;
  notificationType?: NotificationType;
  organizations?: OrgView[];
  personalVaultIsAllowed: boolean;
  theme: Theme;
  handleAccountSelection?: (userId: string) => void;
  handleSaveAction: (e: Event) => void;
};

export function NotificationFooter({
  accounts,
  collections,
  folders,
  i18n,
  isLoading,
  notificationType,
  organizations,
  personalVaultIsAllowed,
  theme,
  handleAccountSelection,
  handleSaveAction,
}: NotificationFooterProps) {
  const isChangeNotification = notificationType === NotificationTypes.Change;
  const isUnlockNotification = notificationType === NotificationTypes.Unlock;
  // An account is chosen only for a new login, and only among several.
  const accountSelection =
    notificationType === NotificationTypes.Add &&
    handleAccountSelection != null &&
    accounts != null &&
    accounts.length > 1
      ? NotificationAccountSelection({ accounts, i18n, theme, handleAccountSelection })
      : nothing;
  const showAccountSelection = accountSelection !== nothing;

  let primaryButtonText = i18n.saveAction;

  if (isUnlockNotification) {
    primaryButtonText = i18n.notificationUnlock;
  }

  return html`
    <div class=${notificationFooterStyles({ isChangeNotification, showAccountSelection })}>
      ${accountSelection}
      ${
        !isChangeNotification
          ? NotificationButtonRow({
              collections,
              folders,
              organizations,
              i18n,
              primaryButton: {
                handlePrimaryButtonClick: handleSaveAction,
                isLoading,
                text: primaryButtonText,
              },
              personalVaultIsAllowed,
              theme,
            })
          : nothing
      }
    </div>
  `;
}

const notificationFooterStyles = ({
  isChangeNotification,
  showAccountSelection,
}: {
  isChangeNotification: boolean;
  showAccountSelection: boolean;
}) => css`
  display: flex;
  ${showAccountSelection ? `flex-direction: column; gap: ${spacing[2]};` : ""}
  padding: ${spacing[2]} ${spacing[4]} ${isChangeNotification ? spacing[1] : spacing[4]}
    ${spacing[4]};

  :last-child {
    border-radius: 0 0 ${spacing["4"]} ${spacing["4"]};
  }
`;
