import { Money } from "../../../domain/money/money";
import { Wallet } from "../../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import { LedgerDirection } from "../../../domain/ledger/ledger-direction";
import { InboxMessage } from "../../../domain/inbox/inbox-message";
import { OutboxMessage } from "../../../domain/outbox/outbox-message";
import { WagerTransaction } from "../../../domain/wager-transaction/wager-transaction";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction/enums";
import {
  InboxOrmEntity,
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from "./entities";

export class WalletMapper {
  static toDomain(row: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: Money.from({ amount: normalizeDecimal(row.balanceAmount), currency: row.currency }),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  static toOrm(wallet: Wallet, row = new WalletOrmEntity()): WalletOrmEntity {
    row.id = wallet.id;
    row.playerId = wallet.playerId;
    row.currency = wallet.currency;
    row.balanceAmount = wallet.balance.toString();
    row.version = wallet.version;
    row.createdAt = wallet.createdAt;
    row.updatedAt = wallet.updatedAt;
    return row;
  }
}

export class TransactionMapper {
  static toDomain(row: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money: Money.from({ amount: normalizeDecimal(row.amount), currency: row.currency }),
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      createdAt: row.createdAt,
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.referenceTransactionId,
      failureCode: row.failureCode as FailureCode | undefined,
      processedAt: row.processedAt,
      attemptCount: row.attemptCount,
      nextRetryAt: row.nextRetryAt,
      observedBalance:
        row.observedBalanceAmount && row.observedBalanceCurrency
          ? Money.from({
              amount: normalizeDecimal(row.observedBalanceAmount),
              currency: row.observedBalanceCurrency,
            })
          : undefined,
    });
  }

  static toOrm(
    tx: WagerTransaction,
    row = new WagerTransactionOrmEntity(),
  ): WagerTransactionOrmEntity {
    row.id = tx.id;
    row.providerId = tx.providerId;
    row.externalTransactionId = tx.externalTransactionId;
    row.idempotencyKey = tx.idempotencyKey;
    row.payloadHash = tx.payloadHash;
    row.walletId = tx.walletId;
    row.playerId = tx.playerId;
    row.roundId = tx.roundId;
    row.gameId = tx.gameId;
    row.kind = tx.kind;
    row.amount = tx.money.toString();
    row.currency = tx.money.currency;
    row.referenceExternalTransactionId = tx.referenceExternalTransactionId;
    row.createdAt = tx.createdAt;
    row.status = tx.status;
    row.referenceTransactionId = tx.referenceTransactionId;
    row.failureCode = tx.failureCode;
    row.processedAt = tx.processedAt;
    row.attemptCount = tx.attemptCount;
    row.nextRetryAt = tx.nextRetryAt;
    row.observedBalanceAmount = tx.observedBalance?.toString();
    row.observedBalanceCurrency = tx.observedBalance?.currency;
    return row;
  }
}

export class LedgerMapper {
  static toDomain(row: LedgerOrmEntity): WalletLedgerEntry {
    const currency = row.currency;
    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: row.direction as LedgerDirection,
      money: Money.from({ amount: normalizeDecimal(row.amount), currency }),
      balanceBefore: Money.from({
        amount: normalizeDecimal(row.balanceBeforeAmount),
        currency,
      }),
      balanceAfter: Money.from({
        amount: normalizeDecimal(row.balanceAfterAmount),
        currency,
      }),
      createdAt: row.createdAt,
    });
  }

  static toOrm(entry: WalletLedgerEntry, row = new LedgerOrmEntity()): LedgerOrmEntity {
    row.id = entry.id;
    row.walletId = entry.walletId;
    row.transactionId = entry.transactionId;
    row.direction = entry.direction;
    row.amount = entry.money.toString();
    row.currency = entry.money.currency;
    row.balanceBeforeAmount = entry.balanceBefore.toString();
    row.balanceAfterAmount = entry.balanceAfter.toString();
    row.createdAt = entry.createdAt;
    return row;
  }
}

export class InboxMapper {
  static toDomain(row: InboxOrmEntity): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: row.messageId,
      consumerName: row.consumerName,
      payloadHash: row.payloadHash,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
    });
  }

  static toOrm(message: InboxMessage, row = new InboxOrmEntity()): InboxOrmEntity {
    row.messageId = message.messageId;
    row.consumerName = message.consumerName;
    row.payloadHash = message.payloadHash;
    row.receivedAt = message.receivedAt;
    row.processedAt = message.processedAt;
    return row;
  }
}

export class OutboxMapper {
  static toDomain(row: OutboxOrmEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      publishedAt: row.publishedAt,
    });
  }

  static toOrm(message: OutboxMessage, row = new OutboxOrmEntity()): OutboxOrmEntity {
    row.id = message.id;
    row.aggregateId = message.aggregateId;
    row.eventType = message.eventType;
    row.payload = { ...message.payload };
    row.occurredAt = message.occurredAt;
    row.attempts = message.attempts;
    row.nextAttemptAt = message.nextAttemptAt;
    row.publishedAt = message.publishedAt;
    return row;
  }
}

export function normalizeDecimal(value: string): string {
  const [whole, fraction = "00"] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}
