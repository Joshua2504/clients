import { ThemeTypes } from "@bitwarden/common/platform/enums";

import { NotificationTypes } from "../../../notification/abstractions/notification-bar";
import { AccountView } from "../common-types";
import { mockI18n } from "../lit-stories/mock-data";

import { NotificationAccountSelection } from "./account-selection";
import { NotificationFooter } from "./footer";

jest.mock("lit", () => ({
  html: jest.fn((_strings: TemplateStringsArray, ...values: any[]) => values),
  nothing: Symbol("nothing"),
}));
jest.mock("./account-selection", () => ({ NotificationAccountSelection: jest.fn() }));
jest.mock("./button-row", () => ({ NotificationButtonRow: jest.fn() }));

describe("NotificationFooter", () => {
  const accounts: AccountView[] = [
    { id: "active-id", email: "active@example.com", selected: true, removeIndividualVault: false },
    { id: "other-id", email: "other@example.com", selected: false, removeIndividualVault: false },
  ];
  const defaultProps = {
    i18n: mockI18n,
    notificationType: NotificationTypes.Add,
    personalVaultIsAllowed: true,
    theme: ThemeTypes.Light,
    handleAccountSelection: jest.fn(),
    handleSaveAction: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders no account selector without accounts to choose from", () => {
    NotificationFooter({ ...defaultProps });
    NotificationFooter({ ...defaultProps, accounts: [] });
    NotificationFooter({ ...defaultProps, accounts: [accounts[0]] });

    expect(NotificationAccountSelection).not.toHaveBeenCalled();
  });

  it("renders the account selector when more than one account can save the login", () => {
    NotificationFooter({ ...defaultProps, accounts });

    expect(NotificationAccountSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts,
        handleAccountSelection: defaultProps.handleAccountSelection,
      }),
    );
  });

  it.each([NotificationTypes.Change, NotificationTypes.Unlock])(
    "renders no account selector for the %s notification",
    (notificationType) => {
      NotificationFooter({ ...defaultProps, accounts, notificationType });

      expect(NotificationAccountSelection).not.toHaveBeenCalled();
    },
  );
});
