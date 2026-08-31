import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { WalletLedgerEntry } from "../../src/domain/ledger/wallet-ledger-entry";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import { WalletInvariantError } from "../../src/domain/errors/domain-error";
import { OutboxMessage } from "../../src/domain/outbox/outbox-message";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed";
import { Wallet } from "../../src/domain/wallet/wallet";

describe("WalletLedgerEntry", () => {
  test("create verifies arithmetic", () => {
    const money = Money.from({ amount: "10.00", currency: "BRL" });
    const entry = WalletLedgerEntry.create({
      id: "1",
      walletId: "w",
      transactionId: "t",
      direction: LedgerDirection.Debit,
      money,
      balanceBefore: Money.from({ amount: "30.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "20.00", currency: "BRL" }),
      createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test("rejects unbalanced entries", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "1",
        walletId: "w",
        transactionId: "t",
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "10.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "10.00", currency: "BRL" }),
        createdAt: new Date(),
      }),
    ).toThrow(WalletInvariantError);
  });
});

describe("OutboxMessage", () => {
  test("schedules exponential backoff and can be marked published", () => {
    const wallet = Wallet.open({
      id: "11111111-1111-7111-8111-111111111111",
      playerId: "22222222-2222-7222-8222-222222222222",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const entry = WalletLedgerEntry.create({
      id: "e",
      walletId: wallet.id,
      transactionId: "t",
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      balanceBefore: Money.zero("BRL"),
      balanceAfter: Money.from({ amount: "10.00", currency: "BRL" }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: "evt-1",
      correlationId: "c",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.eventType).toBe("WalletBalanceChanged");
    expect(outbox.payload.data).toBeDefined();

    const t1 = new Date("2026-01-01T00:00:01.000Z");
    outbox.scheduleRetry(t1);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt!.getTime()).toBeGreaterThan(t1.getTime());

    const publishedAt = new Date("2026-01-01T00:00:02.000Z");
    outbox.markPublished(publishedAt);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date())).toBe(false);
  });
});
