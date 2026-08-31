import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import {
  openWallet,
  startHarness,
  stopApp,
  submitWager,
  uuid,
  type Harness,
} from "../helpers/harness";

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness({ workers: false });
}, 120_000);

afterAll(async () => {
  if (harness) {
    await stopApp(harness.app);
  }
});

describe("HTTP API and financial invariants", () => {
  test("opens a wallet with OPENING ledger and version 1", async () => {
    const wallet = await openWallet(harness.baseUrl, "1000.00");
    expect(wallet.balance.amount).toBe("1000.00");
    expect(wallet.version).toBe(1);

    const got = await fetch(`${harness.baseUrl}/wallets/${wallet.id}`);
    expect(got.status).toBe(200);

    const ledger = await fetch(`${harness.baseUrl}/wallets/${wallet.id}/ledger`);
    const page = (await ledger.json()) as { items: Array<{ direction: string }> };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.direction).toBe("CREDIT");
  });

  test("duplicate wallet for the same player+currency is a 409", async () => {
    const playerId = uuid();
    const first = await fetch(`${harness.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "10.00", currency: "BRL" },
      }),
    });
    const second = await fetch(`${harness.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "10.00", currency: "BRL" },
      }),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  test("BET debits, LOSS is a no-op, WIN credits", async () => {
    const wallet = await openWallet(harness.baseUrl, "100.00");
    const bet = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "25.00",
      externalTransactionId: "bet-1",
    });
    expect(bet.status).toBe(200);
    expect(bet.body.status).toBe("PROCESSED");
    expect((bet.body.balance as { amount: string }).amount).toBe("75.00");

    const loss = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "LOSS",
      amount: "25.00",
      externalTransactionId: "loss-1",
      roundId: "round-1",
    });
    expect(loss.status).toBe(200);
    expect((loss.body.balance as { amount: string }).amount).toBe("75.00");

    const win = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "WIN",
      amount: "40.00",
      externalTransactionId: "win-1",
      roundId: "round-1",
    });
    expect(win.status).toBe(200);
    expect((win.body.balance as { amount: string }).amount).toBe("115.00");
  });

  test("idempotent replay returns the original result; divergent payload is 409", async () => {
    const wallet = await openWallet(harness.baseUrl, "100.00");
    const first = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "10.00",
      externalTransactionId: "same-tx",
      idempotencyKey: "provider-a:same-tx",
    });
    const replay = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "10.00",
      externalTransactionId: "same-tx",
      idempotencyKey: "provider-a:same-tx",
    });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);

    const conflict = await fetch(`${harness.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "provider-a:same-tx",
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "same-tx",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "11.00", currency: "BRL" },
      }),
    });
    expect(conflict.status).toBe(409);
  });

  test("insufficient funds is 422 with a stable failureCode", async () => {
    const wallet = await openWallet(harness.baseUrl, "10.00");
    const result = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "50.00",
    });
    expect(result.status).toBe(422);
    expect(result.body.status).toBe("REJECTED");
    expect(result.body.failureCode).toBe("INSUFFICIENT_FUNDS");
  });

  test("REFUND credits a processed BET once; second refund is rejected", async () => {
    const wallet = await openWallet(harness.baseUrl, "100.00");
    await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "30.00",
      externalTransactionId: "bet-ref",
    });
    const refund = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "REFUND",
      amount: "30.00",
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-ref",
    });
    expect(refund.status).toBe(200);
    expect((refund.body.balance as { amount: string }).amount).toBe("100.00");

    const second = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "REFUND",
      amount: "30.00",
      externalTransactionId: "refund-2",
      referenceExternalTransactionId: "bet-ref",
    });
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
  });

  test("ROLLBACK before the reference is accepted as PENDING_REFERENCE", async () => {
    const wallet = await openWallet(harness.baseUrl, "100.00");
    const rollback = await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "ROLLBACK",
      amount: "20.00",
      externalTransactionId: "rb-early",
      referenceExternalTransactionId: "bet-later",
    });
    expect(rollback.status).toBe(202);
    expect(rollback.body.status).toBe("PENDING_REFERENCE");
  });

  test("reconciliation matches stored balance to the ledger", async () => {
    const wallet = await openWallet(harness.baseUrl, "80.00");
    await submitWager(harness.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "30.00",
    });
    const response = await fetch(`${harness.baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    const body = (await response.json()) as { consistent: boolean; difference: { amount: string } };
    expect(response.status).toBe(200);
    expect(body.consistent).toBe(true);
    expect(body.difference.amount).toBe("0.00");
  });

  test("schema rejects a negative wallet balance", async () => {
    const em = harness.app.get(EntityManager).fork();
    try {
      await em.getConnection().execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES ('00000000-0000-7000-8000-000000000099', '00000000-0000-7000-8000-000000000098', 'BRL', -1.00, 1, now(), now())`,
      );
      throw new Error("expected check constraint to reject negative balance");
    } catch (error) {
      expect(String(error)).toMatch(/chk_wallets_balance_non_negative|violates check constraint/i);
    }
  });

  test("health endpoints are open", async () => {
    const live = await fetch(`${harness.baseUrl}/health/live`);
    expect(live.status).toBe(200);
    const ready = await fetch(`${harness.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
  });
});
