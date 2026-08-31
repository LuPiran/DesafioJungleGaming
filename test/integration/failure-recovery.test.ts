import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import { RequestContext } from "@mikro-orm/core";
import {
  dlqSize,
  openWallet,
  receiveDlq,
  sendRawSqs,
  sendSqsWager,
  startHarness,
  stopApp,
  submitWager,
  uuid,
  waitFor,
  type Harness,
} from "../helpers/harness";
import { SqsService } from "../../src/infrastructure/messaging/sqs/sqs.service";
import { PublishOutboxUseCase } from "../../src/application/use-cases/publish-outbox.use-case";

describe("failure recovery: pending reference, DLQ, crash and restart", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness({ workers: true });
  }, 120_000);

  afterAll(async () => {
    if (harness) await stopApp(harness.app);
  });

  test("ROLLBACK delivered before the BET is processed after the reference arrives", async () => {
    const wallet = await openWallet(harness.baseUrl, "100.00");
    const betExt = `late-bet-${uuid()}`;
    const rbExt = `${betExt}-rb`;

    const rollback = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "ROLLBACK",
      amount: "25.00",
      externalTransactionId: rbExt,
      referenceExternalTransactionId: betExt,
    });
    expect(rollback.status).toBe(202);
    expect(rollback.body.status).toBe("PENDING_REFERENCE");

    const bet = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "25.00",
      externalTransactionId: betExt,
    });
    expect(bet.status).toBe(200);

    await waitFor(async () => {
      const got = await fetch(
        `${harness.baseUrl}/providers/provider-a/wagering/transactions/${rbExt}`,
      );
      if (!got.ok) return false;
      const body = (await got.json()) as { status: string };
      return body.status === "PROCESSED";
    });

    const after = await fetch(`${harness.baseUrl}/wallets/${wallet.id}`);
    const walletBody = (await after.json()) as { balance: { amount: string } };
    expect(walletBody.balance.amount).toBe("100.00");

    const recon = await fetch(`${harness.baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    expect(((await recon.json()) as { consistent: boolean }).consistent).toBe(true);
  });

  test("poison SQS messages are retried and land on the DLQ", async () => {
    const group = `poison-${uuid()}`;
    await sendRawSqs(
      harness,
      {
        messageId: `poison-${uuid()}`,
        type: "NotAValidType",
        occurredAt: new Date().toISOString(),
        data: {},
      },
      group,
      `poison-${uuid()}`,
    );

    await waitFor(async () => (await dlqSize(harness)) > 0 || (await receiveDlq(harness)) > 0, 30_000);
  });

  test("commit then failed ack still does not duplicate the debit on redelivery", async () => {
    const wallet = await openWallet(harness.baseUrl, "80.00");
    const sqs = harness.app.get(SqsService);
    const originalAck = sqs.ack.bind(sqs);
    (sqs as { ack: (receiptHandle: string) => Promise<void> }).ack = async () => {
      throw new Error("simulated crash before ack");
    };

    const ext = `crash-ack-${uuid()}`;
    await sendSqsWager(
      harness,
      {
        providerId: "provider-a",
        externalTransactionId: ext,
        idempotencyKey: `provider-a:${ext}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "crash",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      },
      `msg-${ext}`,
    );

    await waitFor(async () => {
      const got = await fetch(`${harness.baseUrl}/wallets/${wallet.id}`);
      const body = (await got.json()) as { balance: { amount: string } };
      return body.balance.amount === "70.00";
    });

    (sqs as { ack: (receiptHandle: string) => Promise<void> }).ack = originalAck;

    await waitFor(async () => {
      const recon = await fetch(`${harness.baseUrl}/wallets/${wallet.id}/reconciliation`, {
        method: "POST",
      });
      const body = (await recon.json()) as { consistent: boolean; storedBalance: { amount: string } };
      return recon.ok && body.consistent && body.storedBalance.amount === "70.00";
    }, 20_000);
  });

  test("restarting the process keeps wallet/ledger consistent and drains the outbox", async () => {
    const wallet = await openWallet(harness.baseUrl, "60.00");
    await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "15.00",
      externalTransactionId: `restart-${uuid()}`,
    });

    await stopApp(harness.app);
    harness = await startHarness({ workers: true });

    await waitFor(async () => {
      const recon = await fetch(`${harness.baseUrl}/wallets/${wallet.id}/reconciliation`, {
        method: "POST",
      });
      const body = (await recon.json()) as { consistent: boolean; storedBalance: { amount: string } };
      return recon.ok && body.consistent && body.storedBalance.amount === "45.00";
    });

    const em = harness.app.get(EntityManager);
    await RequestContext.create(em, async () => {
      const publisher = harness.app.get(PublishOutboxUseCase);
      await publisher.execute(100);
    });

    await waitFor(async () => {
      const unpublished = (await em.getConnection().execute(
        `select count(*)::int as c from outbox_messages where published_at is null`,
      )) as Array<{ c: number }>;
      return Number(unpublished[0]?.c ?? -1) === 0;
    });
  });
});
