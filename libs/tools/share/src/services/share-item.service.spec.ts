import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { SHARE_ITEM_PRESENTER, ShareItemPresenter } from "../tokens/share-item-presenter.token";
import {
  SHARE_PASSWORD_REPROMPT,
  SharePasswordReprompt,
} from "../tokens/share-password-reprompt.token";

import { ShareItemService } from "./share-item.service";

describe("ShareItemService", () => {
  let service: ShareItemService;
  let presenter: MockProxy<ShareItemPresenter>;
  let passwordReprompt: MockProxy<SharePasswordReprompt>;

  const cipher = Object.assign(new CipherView(), { id: "cipher-id", name: "item" });

  beforeEach(() => {
    presenter = mock<ShareItemPresenter>();
    passwordReprompt = mock<SharePasswordReprompt>();
    passwordReprompt.passwordRepromptCheck.mockResolvedValue(true);

    TestBed.configureTestingModule({
      providers: [
        ShareItemService,
        { provide: SHARE_ITEM_PRESENTER, useValue: presenter },
        { provide: SHARE_PASSWORD_REPROMPT, useValue: passwordReprompt },
      ],
    });

    service = TestBed.inject(ShareItemService);
  });

  it("presents the item once re-prompt passes", async () => {
    await service.share(cipher);

    expect(passwordReprompt.passwordRepromptCheck).toHaveBeenCalledWith(cipher);
    expect(presenter.present).toHaveBeenCalledWith(cipher);
  });

  it("does not present when re-prompt fails", async () => {
    passwordReprompt.passwordRepromptCheck.mockResolvedValue(false);

    await service.share(cipher);

    expect(presenter.present).not.toHaveBeenCalled();
  });

  it("skips re-prompt when the caller has already verified", async () => {
    await service.share(cipher, { alreadyVerified: true });

    expect(passwordReprompt.passwordRepromptCheck).not.toHaveBeenCalled();
    expect(presenter.present).toHaveBeenCalledWith(cipher);
  });

  it("hands the item to the presenter untouched, so a surface that needs only the id pays for no lookup", async () => {
    const listViewRow = { id: "cipher-id", name: "item" } as never;

    await service.share(listViewRow);

    expect(presenter.present).toHaveBeenCalledWith(listViewRow);
  });

  describe("for an item of an account other than the active one", () => {
    const otherUserId = "other-user" as UserId;

    it("re-prompts for that account and presents the item for it", async () => {
      await service.share(cipher, { userId: otherUserId });

      expect(passwordReprompt.passwordRepromptCheck).toHaveBeenCalledWith(cipher, otherUserId);
      expect(presenter.present).toHaveBeenCalledWith(cipher, otherUserId);
    });

    it("does not present when that account's re-prompt fails", async () => {
      passwordReprompt.passwordRepromptCheck.mockResolvedValue(false);

      await service.share(cipher, { userId: otherUserId });

      expect(presenter.present).not.toHaveBeenCalled();
    });

    it("carries the account to the presenter when the caller has already verified", async () => {
      await service.share(cipher, { alreadyVerified: true, userId: otherUserId });

      expect(passwordReprompt.passwordRepromptCheck).not.toHaveBeenCalled();
      expect(presenter.present).toHaveBeenCalledWith(cipher, otherUserId);
    });
  });

  it("fails rather than sharing when the client provided no re-prompt", async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [ShareItemService, { provide: SHARE_ITEM_PRESENTER, useValue: presenter }],
    });

    await expect(TestBed.inject(ShareItemService).share(cipher)).rejects.toThrow();
    expect(presenter.present).not.toHaveBeenCalled();
  });
});
