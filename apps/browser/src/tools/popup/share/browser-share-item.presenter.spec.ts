import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { mock, MockProxy } from "jest-mock-extended";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";

import { BrowserShareItemPresenter } from "./browser-share-item.presenter";

describe("BrowserShareItemPresenter", () => {
  let router: MockProxy<Router>;
  let presenter: BrowserShareItemPresenter;

  const cipher = Object.assign(new CipherView(), { id: "cipher-id" });

  beforeEach(() => {
    router = mock<Router>();

    TestBed.configureTestingModule({
      providers: [BrowserShareItemPresenter, { provide: Router, useValue: router }],
    });

    presenter = TestBed.inject(BrowserShareItemPresenter);
  });

  it("opens the share page for the active account's item without an account", async () => {
    await presenter.present(cipher);

    expect(router.navigate).toHaveBeenCalledWith(["/share-item"], {
      queryParams: { cipherId: "cipher-id" },
    });
  });

  it("opens the share page for the account that owns the item", async () => {
    await presenter.present(cipher, "other-user" as UserId);

    expect(router.navigate).toHaveBeenCalledWith(["/share-item"], {
      queryParams: { cipherId: "cipher-id", userId: "other-user" },
    });
  });
});
