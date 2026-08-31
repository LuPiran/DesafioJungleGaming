import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { WagerTransaction } from "../../src/domain/wager-transaction/wager-transaction";
import { WagerTransactionKind } from "../../src/domain/wager-transaction/enums";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
} from "../../src/domain/errors/domain-error";

const now = new Date("2026-08-31T12:00:00.000Z");

function wallet(balance = "100.00"): Wallet {
  return Wallet.open({
    id: "11111111-1111-7111-8111-111111111111",
    playerId: "22222222-2222-7222-8222-222222222222",
    initialBalance: Money.from({ amount: balance, currency: "BRL" }),
    createdAt: now,
  });
}

function bet(amount: string, id = "33333333-3333-7333-8333-333333333333"): WagerTransaction {
  return WagerTransaction.create({
    id,
    providerId: "provider-a",
    externalTransactionId: id,
    idempotencyKey: `provider-a:${id}`,
    payloadHash: "hash",
    walletId: "11111111-1111-7111-8111-111111111111",
    playerId: "22222222-2222-7222-8222-222222222222",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount, currency: "BRL" }),
    createdAt: now,
  });
}

describe("Wallet", () => {
  test("opens with version 1 and the initial balance", () => {
    const opened = wallet("1000.00");
    expect(opened.version).toBe(1);
    expect(opened.balance.toString()).toBe("1000.00");
  });

  test("debit decreases balance, increments version and writes a balanced ledger entry", () => {
    const opened = wallet("100.00");
    const entry = opened.apply(bet("80.00"), "entry-1", now);
    expect(entry).toBeDefined();
    expect(entry!.direction).toBe(LedgerDirection.Debit);
    expect(entry!.isBalanced()).toBe(true);
    expect(opened.balance.toString()).toBe("20.00");
    expect(opened.version).toBe(2);
  });

  test("rejects a debit that would go negative", () => {
    const opened = wallet("50.00");
    expect(() => opened.apply(bet("80.00"), "entry-1", now)).toThrow(InsufficientFundsError);
    expect(opened.balance.toString()).toBe("50.00");
    expect(opened.version).toBe(1);
  });

  test("rejects a currency mismatch", () => {
    const opened = wallet("100.00");
    const usdBet = WagerTransaction.create({
      id: "33333333-3333-7333-8333-333333333399",
      providerId: "provider-a",
      externalTransactionId: "usd-1",
      idempotencyKey: "provider-a:usd-1",
      payloadHash: "hash",
      walletId: opened.id,
      playerId: opened.playerId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "10.00", currency: "USD" }),
      createdAt: now,
    });
    expect(() => opened.apply(usdBet, "entry-1", now)).toThrow(CurrencyMismatchError);
  });

  test("LOSS does not move the balance or version", () => {
    const opened = wallet("100.00");
    const loss = WagerTransaction.create({
      id: "44444444-4444-7444-8444-444444444444",
      providerId: "provider-a",
      externalTransactionId: "loss-1",
      idempotencyKey: "provider-a:loss-1",
      payloadHash: "hash",
      walletId: opened.id,
      playerId: opened.playerId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      createdAt: now,
    });
    expect(opened.apply(loss, "entry-1", now)).toBeUndefined();
    expect(opened.balance.toString()).toBe("100.00");
    expect(opened.version).toBe(1);
  });

  test("debit and credit are public and keep the ledger balanced", () => {
    const opened = wallet("100.00");
    const debitEntry = opened.debit(bet("30.00", "33333333-3333-7333-8333-333333333301"), "e-debit", now);
    expect(debitEntry.direction).toBe(LedgerDirection.Debit);
    expect(debitEntry.isBalanced()).toBe(true);
    expect(opened.balance.toString()).toBe("70.00");
    expect(opened.version).toBe(2);

    const win = WagerTransaction.create({
      id: "66666666-6666-7666-8666-666666666666",
      providerId: "provider-a",
      externalTransactionId: "win-public",
      idempotencyKey: "provider-a:win-public",
      payloadHash: "hash",
      walletId: opened.id,
      playerId: opened.playerId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: "15.00", currency: "BRL" }),
      createdAt: now,
    });
    const creditEntry = opened.credit(win, "e-credit", now);
    expect(creditEntry.direction).toBe(LedgerDirection.Credit);
    expect(creditEntry.isBalanced()).toBe(true);
    expect(opened.balance.toString()).toBe("85.00");
    expect(opened.version).toBe(3);
  });

  test("opening ledger goes from zero to the initial balance without bumping version", () => {
    const opened = wallet("1000.00");
    const opening = WagerTransaction.openWalletCredit({
      id: "55555555-5555-7555-8555-555555555555",
      providerId: "internal",
      externalTransactionId: "opening",
      idempotencyKey: "opening",
      payloadHash: "hash",
      walletId: opened.id,
      playerId: opened.playerId,
      roundId: "opening",
      gameId: "internal",
      kind: WagerTransactionKind.Opening,
      money: Money.from({ amount: "1000.00", currency: "BRL" }),
      createdAt: now,
    });
    const entry = opened.openingEntry(opening, "entry-open", now);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe("0.00");
    expect(entry.balanceAfter.toString()).toBe("1000.00");
    expect(opened.version).toBe(1);
  });
});
