import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { WagerTransaction } from "../../src/domain/wager-transaction/wager-transaction";
import {
  FailureCode,
  WagerTransactionKind,
} from "../../src/domain/wager-transaction/enums";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import { ReferenceValidator } from "../../src/domain/wager-transaction/reference-validator";
import { Wallet } from "../../src/domain/wallet/wallet";
import {
  InvalidTransactionStateError,
  InvalidMoneyError,
} from "../../src/domain/errors/domain-error";
import { CanonicalSha256Hasher } from "../../src/infrastructure/crypto/support.adapters";

const now = new Date("2026-08-31T12:00:00.000Z");
const walletId = "11111111-1111-7111-8111-111111111111";
const playerId = "22222222-2222-7222-8222-222222222222";

function tx(
  kind: WagerTransactionKind,
  amount: string,
  extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: extra.id ?? "33333333-3333-7333-8333-333333333333",
    providerId: "provider-a",
    externalTransactionId: extra.externalTransactionId ?? "tx-1",
    idempotencyKey: extra.idempotencyKey ?? "provider-a:tx-1",
    payloadHash: extra.payloadHash ?? "hash-1",
    walletId,
    playerId,
    roundId: extra.roundId ?? "round-1",
    gameId: "fortune-chimp",
    kind,
    money: Money.from({ amount, currency: "BRL" }),
    referenceExternalTransactionId: extra.referenceExternalTransactionId,
    createdAt: now,
  });
}

describe("WagerTransaction rules", () => {
  test("OPENING cannot be created via the public factory", () => {
    try {
      tx(WagerTransactionKind.Opening, "10.00");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransactionStateError);
      expect((error as InvalidTransactionStateError).code).toBe(FailureCode.OPENING_NOT_ALLOWED);
    }
  });

  test("zero amount is rejected", () => {
    expect(() => tx(WagerTransactionKind.Bet, "0.00")).toThrow(InvalidMoneyError);
  });

  test("REFUND and ROLLBACK require a reference", () => {
    try {
      tx(WagerTransactionKind.Refund, "10.00");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransactionStateError);
      expect((error as InvalidTransactionStateError).code).toBe(FailureCode.REFERENCE_REQUIRED);
    }
    try {
      tx(WagerTransactionKind.Rollback, "10.00");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransactionStateError);
      expect((error as InvalidTransactionStateError).code).toBe(FailureCode.REFERENCE_REQUIRED);
    }
  });

  test("BET is a debit, WIN and REFUND are credits, LOSS has no ledger", () => {
    expect(tx(WagerTransactionKind.Bet, "10.00").ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx(WagerTransactionKind.Win, "10.00").ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      tx(WagerTransactionKind.Refund, "10.00", { referenceExternalTransactionId: "bet-1" }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    expect(tx(WagerTransactionKind.Loss, "10.00").affectsBalance()).toBe(false);
  });

  test("ROLLBACK inverts the referenced direction", () => {
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    bet.markProcessed(undefined, now, Money.from({ amount: "90.00", currency: "BRL" }));
    const rollback = tx(WagerTransactionKind.Rollback, "10.00", {
      id: "44444444-4444-7444-8444-444444444444",
      externalTransactionId: "rb-1",
      idempotencyKey: "provider-a:rb-1",
      referenceExternalTransactionId: "tx-1",
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test("terminal states cannot transition", () => {
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    bet.markProcessed(undefined, now, Money.zero("BRL"));
    expect(() => bet.reject(FailureCode.INSUFFICIENT_FUNDS, now)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("matchesPayload detects a divergent hash", () => {
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    expect(bet.matchesPayload("hash-1")).toBe(true);
    expect(bet.matchesPayload("hash-2")).toBe(false);
  });
});

describe("ReferenceValidator", () => {
  const opened = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    createdAt: now,
  });

  test("rejects a reference from another round or player", () => {
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    bet.markProcessed(undefined, now, Money.from({ amount: "90.00", currency: "BRL" }));
    const refund = tx(WagerTransactionKind.Refund, "10.00", {
      id: "55555555-5555-7555-8555-555555555555",
      externalTransactionId: "rf-1",
      idempotencyKey: "provider-a:rf-1",
      roundId: "other-round",
      referenceExternalTransactionId: "tx-1",
    });
    expect(ReferenceValidator.validate(refund, opened, bet, undefined)).toBe(
      FailureCode.REFERENCE_SCOPE_MISMATCH,
    );
  });

  test("rejects amount mismatch and already reversed references", () => {
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    bet.markProcessed(undefined, now, Money.from({ amount: "90.00", currency: "BRL" }));
    const refund = tx(WagerTransactionKind.Refund, "9.00", {
      id: "55555555-5555-7555-8555-555555555555",
      externalTransactionId: "rf-1",
      idempotencyKey: "provider-a:rf-1",
      referenceExternalTransactionId: "tx-1",
    });
    expect(ReferenceValidator.validate(refund, opened, bet, undefined)).toBe(
      FailureCode.REFERENCE_AMOUNT_MISMATCH,
    );

    const matching = tx(WagerTransactionKind.Refund, "10.00", {
      id: "66666666-6666-7666-8666-666666666666",
      externalTransactionId: "rf-2",
      idempotencyKey: "provider-a:rf-2",
      referenceExternalTransactionId: "tx-1",
    });
    expect(ReferenceValidator.validate(matching, opened, bet, matching)).toBe(
      FailureCode.REFERENCE_ALREADY_REVERSED,
    );
  });
});

describe("idempotency payload hash", () => {
  test("canonical JSON is order-insensitive and detects a field change", () => {
    const hasher = new CanonicalSha256Hasher();
    const a = hasher.hash({
      providerId: "provider-a",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });
    const b = hasher.hash({
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      providerId: "provider-a",
    });
    const c = hasher.hash({
      providerId: "provider-a",
      kind: "BET",
      money: { amount: "25.01", currency: "BRL" },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
