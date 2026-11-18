import { css } from "@emotion/css";
import { html, nothing } from "lit";

import { Theme } from "@bitwarden/common/platform/enums";

import { themes } from "../../constants/styles";

export type AtRiskNotificationMessageProps = {
  /** The account the at-risk login belongs to. */
  accountLabel?: string;
  message?: string;
  theme: Theme;
};

export function AtRiskNotificationMessage({
  accountLabel,
  message,
  theme,
}: AtRiskNotificationMessageProps) {
  return html`
    <div>
      ${
        message
          ? html`
              <span title=${message} class=${atRiskNotificationMessageStyles(theme)}>
                ${message}
              </span>
            `
          : nothing
      }
      ${
        accountLabel
          ? html`
              <div
                title=${accountLabel}
                data-testid="at-risk-notification-account"
                class=${atRiskNotificationAccountStyles(theme)}
              >
                ${accountLabel}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

const baseTextStyles = css`
  overflow-x: hidden;
  text-align: left;
  text-overflow: ellipsis;
  line-height: 24px;
  font-family: Inter, sans-serif;
  font-size: 16px;
`;

const atRiskNotificationMessageStyles = (theme: Theme) => css`
  ${baseTextStyles}

  color: ${themes[theme].text.main};
  font-weight: 400;
  white-space: normal;
  word-break: break-word;
  display: inline;
`;

const atRiskNotificationAccountStyles = (theme: Theme) => css`
  overflow-x: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 20px;
  font-family: Inter, sans-serif;
  font-size: 14px;
  font-weight: 400;
  color: ${themes[theme].text.muted};
`;
