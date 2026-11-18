import { ThemeTypes } from "@bitwarden/common/platform/enums";

import { NotificationTypes } from "../../../notification/abstractions/notification-bar";
import { BadgeButton } from "../buttons/badge-button";
import { mockI18n } from "../lit-stories/mock-data";
import { selectedCipher } from "../signals/selected-cipher";
import { selectedCipherAccount } from "../signals/selected-cipher-account";

import { CipherAction } from "./cipher-action";

jest.mock("../buttons/badge-button", () => ({ BadgeButton: jest.fn() }));
jest.mock("../buttons/edit-button", () => ({ EditButton: jest.fn() }));
jest.mock("@lit-labs/signals", () => ({
  signal: jest.fn((initial) => {
    let value = initial;
    return { get: () => value, set: (next: unknown) => (value = next) };
  }),
}));

describe("CipherAction", () => {
  const defaultProps = {
    cipherId: "cipher-id",
    i18n: mockI18n,
    itemName: "Example",
    notificationType: NotificationTypes.Change,
    theme: ThemeTypes.Light,
  };

  const clickUpdate = () =>
    (BadgeButton as jest.Mock).mock.calls[0][0].buttonAction(new Event("click"));

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("names the cipher's account along with the cipher while the update action runs", () => {
    const selected: unknown[] = [];
    const handleAction = jest.fn(() =>
      selected.push([selectedCipher.get(), selectedCipherAccount.get()]),
    );
    CipherAction({ ...defaultProps, userId: "other-id", handleAction });

    clickUpdate();

    expect(selected).toEqual([["cipher-id", "other-id"]]);
    expect(selectedCipher.get()).toBeNull();
    expect(selectedCipherAccount.get()).toBeNull();
  });

  it("names no account for a cipher that carries none", () => {
    const selected: unknown[] = [];
    const handleAction = jest.fn(() =>
      selected.push([selectedCipher.get(), selectedCipherAccount.get()]),
    );
    CipherAction({ ...defaultProps, handleAction });

    clickUpdate();

    expect(selected).toEqual([["cipher-id", null]]);
  });
});
