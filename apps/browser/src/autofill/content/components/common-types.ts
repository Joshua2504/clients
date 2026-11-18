import { TemplateResult } from "lit";

import { ProductTierType } from "@bitwarden/common/billing/enums";
import { Theme } from "@bitwarden/common/platform/enums";

export type I18n = {
  [key: string]: string;
};

export type IconProps = {
  color?: string;
  disabled?: boolean;
  theme: Theme;
  ariaHidden?: boolean;
};

export type Option = {
  default?: boolean;
  icon?: (props: IconProps) => TemplateResult;
  text?: string;
  value: any;
};

export type FolderView = {
  id: string;
  name: string;
};

export type OrgView = {
  id: string;
  name: string;
  productTierType?: ProductTierType;
};

export type CollectionView = {
  id: string;
  name: string;
  organizationId: string;
};

/** An account the save prompt can save to. */
export type AccountView = {
  id: string;
  email: string;
  /** The account the save currently goes to. */
  selected: boolean;
  /** Whether a policy keeps this account from saving to its individual vault. */
  removeIndividualVault: boolean;
};
