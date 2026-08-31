import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import {
  openWallet,
  sendSqsWager,
  startHarness,
  stopApp,
  submitWager,
  waitFor,
  type Harness,
} from "../helpers/harness";
import { PublishOutboxUseCase } from "../../src/application/use-cases/publish-outbox.use-case";
import { RequestContext } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness({ workers: true });
}, 120_000);

afterAll(async () => {
  if (harness) {
    await stopApp(harness.app);
  }
});

describe("SQS inbox, outbox and recovery", () => {
  test("SQS delivery uses the same use case and is idempotent on redelivery", async () => {
    const wallet = await openWallet(harness.baseUrl, "100.00");
    const payload = {
      providerId: "provider-a",
      externalTransactionId: "sqs-bet-1",
      idempotencyKey: "provider-a:sqs-bet-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-sqs",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "15.00", currency: "BRL" },
    };

    await sendSqsWager(harness, payload, "msg-sqs-bet-1");
    await sendSqsWager(harness, payload, "msg-sqs-bet-1-redelivery");

    await waitFor(async () => {
      const got = await fetch(`${harness.baseUrl}/wallets/${wallet.id}`);
      const body = (await got.json()) as { balance: { amount: string } };
      return body.balance.amount === "85.00";
    });

    const recon = await fetch(`${harness.baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    const reconBody = (await recon.json()) as { consistent: boolean; checkedEntries: number };
    expect(reconBody.consistent).toBe(true);
  });

  test("outbox is written in the same commit and can be published by a later worker", async () => {
    const wallet = await openWallet(harness.baseUrl, "50.00");
    await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "10.00",
      externalTransactionId: "outbox-bet",
    });

    const publisher = harness.app.get(PublishOutboxUseCase);
    const em = harness.app.get(EntityManager);
    await RequestContext.create(em, () => publisher.execute(50));

    const received = await harness.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: harness.eventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      }),
    );
    expect((received.Messages ?? []).length).toBeGreaterThan(0);
  });
});
