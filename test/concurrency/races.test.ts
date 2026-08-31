import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import {
  openWallet,
  startHarness,
  stopApp,
  submitWager,
  type Harness,
} from "../helpers/harness";

let primary: Harness;
let secondary: Harness;
let tertiary: Harness;

beforeAll(async () => {
  primary = await startHarness({ workers: true });
  secondary = await startHarness({ workers: true });
  tertiary = await startHarness({ workers: true });
}, 180_000);

afterAll(async () => {
  if (primary) await stopApp(primary.app);
  if (secondary) await stopApp(secondary.app);
  if (tertiary) await stopApp(tertiary.app);
});

describe("concurrency", () => {
  test("the same BET sent 50 times in parallel produces a single debit", async () => {
    const wallet = await openWallet(primary.baseUrl, "100.00");
    const requests = Array.from({ length: 50 }, (_, i) =>
      submitWager([primary, secondary, tertiary][i % 3]!.baseUrl, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "BET",
        amount: "40.00",
        externalTransactionId: "parallel-same",
        idempotencyKey: "provider-a:parallel-same",
      }),
    );
    const results = await Promise.all(requests);
    const processed = results.filter((r) => r.body.status === "PROCESSED");
    expect(processed).toHaveLength(50);
    expect(processed.every((r) => r.body.transactionId === processed[0]?.body.transactionId)).toBe(
      true,
    );

    const got = await fetch(`${primary.baseUrl}/wallets/${wallet.id}`);
    const body = (await got.json()) as { balance: { amount: string } };
    expect(body.balance.amount).toBe("60.00");

    const recon = await fetch(`${primary.baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    const reconBody = (await recon.json()) as { consistent: boolean };
    expect(reconBody.consistent).toBe(true);
  });

  test("two concurrent 80.00 BETs against 100.00: one processed, one rejected, balance 20.00", async () => {
    const wallet = await openWallet(primary.baseUrl, "100.00");
    const [a, b] = await Promise.all([
      submitWager(primary.baseUrl, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "BET",
        amount: "80.00",
        externalTransactionId: "race-a",
      }),
      submitWager(secondary.baseUrl, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "BET",
        amount: "80.00",
        externalTransactionId: "race-b",
      }),
    ]);

    const statuses = [a, b].map((r) => r.body.status).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    const rejected = [a, b].find((r) => r.body.status === "REJECTED");
    expect(rejected?.body.failureCode).toBe("INSUFFICIENT_FUNDS");

    const got = await fetch(`${tertiary.baseUrl}/wallets/${wallet.id}`);
    const body = (await got.json()) as { balance: { amount: string } };
    expect(body.balance.amount).toBe("20.00");

    const ledger = await fetch(`${primary.baseUrl}/wallets/${wallet.id}/ledger?limit=50`);
    const page = (await ledger.json()) as { items: Array<{ direction: string }> };
    const debits = page.items.filter((item) => item.direction === "DEBIT");
    expect(debits).toHaveLength(1);

    const recon = await fetch(`${primary.baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    expect(((await recon.json()) as { consistent: boolean }).consistent).toBe(true);
  });

  test("distinct wallets are processed in parallel", async () => {
    const w1 = await openWallet(primary.baseUrl, "50.00");
    const w2 = await openWallet(secondary.baseUrl, "50.00");
    await Promise.all([
      submitWager(primary.baseUrl, {
        walletId: w1.id,
        playerId: w1.playerId,
        kind: "BET",
        amount: "10.00",
      }),
      submitWager(secondary.baseUrl, {
        walletId: w2.id,
        playerId: w2.playerId,
        kind: "BET",
        amount: "10.00",
      }),
    ]);
    const [g1, g2] = await Promise.all([
      fetch(`${primary.baseUrl}/wallets/${w1.id}`),
      fetch(`${secondary.baseUrl}/wallets/${w2.id}`),
    ]);
    expect(((await g1.json()) as { balance: { amount: string } }).balance.amount).toBe("40.00");
    expect(((await g2.json()) as { balance: { amount: string } }).balance.amount).toBe("40.00");
  });
});
