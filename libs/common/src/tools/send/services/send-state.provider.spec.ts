import { firstValueFrom } from "rxjs";

import {
  FakeAccountService,
  FakeStateProvider,
  awaitAsync,
  mockAccountServiceWith,
} from "../../../../spec";
import { Utils } from "../../../platform/misc/utils";
import { UserId } from "../../../types/guid";

import { SendStateProvider } from "./send-state.provider";
import { testSendData, testSendViewData } from "./test-data/send-tests.data";

describe("Send State Provider", () => {
  let stateProvider: FakeStateProvider;
  let accountService: FakeAccountService;
  let sendStateProvider: SendStateProvider;

  const mockUserId = Utils.newGuid() as UserId;

  beforeEach(() => {
    accountService = mockAccountServiceWith(mockUserId);
    stateProvider = new FakeStateProvider(accountService);

    sendStateProvider = new SendStateProvider(stateProvider);
  });

  describe("Encrypted Sends", () => {
    it("should return SendData", async () => {
      const sendData = { "1": testSendData("1", "Test Send Data") };
      await sendStateProvider.setEncryptedSends(sendData, mockUserId);
      await awaitAsync();

      const actual = await sendStateProvider.getEncryptedSends();
      expect(actual).toStrictEqual([mockUserId, sendData]);
    });

    it("returns the SendData of the given user", async () => {
      const otherUserId = Utils.newGuid() as UserId;
      const sendData = { "1": testSendData("1", "Active Send") };
      const otherSendData = { "2": testSendData("2", "Other Send") };
      await sendStateProvider.setEncryptedSends(sendData, mockUserId);
      await sendStateProvider.setEncryptedSends(otherSendData, otherUserId);
      await awaitAsync();

      expect(await sendStateProvider.getEncryptedSends(otherUserId)).toStrictEqual([
        otherUserId,
        otherSendData,
      ]);
      expect(await firstValueFrom(sendStateProvider.encryptedStateFor$(otherUserId))).toStrictEqual(
        [otherUserId, otherSendData],
      );
      expect(await sendStateProvider.getEncryptedSends()).toStrictEqual([mockUserId, sendData]);
    });
  });

  describe("Decrypted Sends", () => {
    it("should return SendView", async () => {
      const state = [testSendViewData("1", "Test")];
      await sendStateProvider.setDecryptedSends(state);
      await awaitAsync();

      const actual = await sendStateProvider.getDecryptedSends();
      expect(actual).toStrictEqual(state);
    });
  });
});
