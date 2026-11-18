import createEmotion from "@emotion/css/create-instance";
import { html, nothing } from "lit";

import { Theme } from "@bitwarden/common/platform/enums";

import { spacing, themes } from "../../constants/styles";

import { AtRiskNotificationMessage } from "./message";

export const componentClassPrefix = "at-risk-notification-body";

const { css } = createEmotion({
  key: componentClassPrefix,
});

export type AtRiskNotificationBodyProps = {
  /** The account the at-risk login belongs to, shown when it is not plain which one it is. */
  accountLabel?: string;
  riskMessage: string;
  theme: Theme;
};

export function AtRiskNotificationBody({
  accountLabel,
  riskMessage,
  theme,
}: AtRiskNotificationBodyProps) {
  return html`
    <div class=${atRiskNotificationBodyStyles({ theme })}>
      ${
        riskMessage
          ? AtRiskNotificationMessage({
              accountLabel,
              message: riskMessage,
              theme,
            })
          : nothing
      }
    </div>
  `;
}

const atRiskNotificationBodyStyles = ({ theme }: { theme: Theme }) => css`
  gap: ${spacing[4]};
  display: flex;
  align-items: center;
  justify-content: flex-start;
  background-color: ${themes[theme].background.alt};
  padding: 12px;
`;
