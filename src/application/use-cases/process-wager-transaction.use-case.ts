import { Injectable, Inject, Logger } from "@nestjs/common";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction/enums";
import { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { Money, type MoneyProps } from "../../domain/money/money";
import { OutboxMessage } from "../../domain/outbox/outbox-message";
import { InboxMessage } from "../../domain/inbox/inbox-message";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference";
import { ReferenceValidator } from "../../domain/wager-transaction/reference-validator";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  ReversalWouldOverdrawError,
} from "../../domain/errors/domain-error";
import {
  BusinessRejectionError,
  ConflictError,
  NotFoundError,
} from "../errors/application-error";
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
} from "../ports/ledger.repository";
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from "../ports/wallet.repository";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "../ports/wager-transaction.repository";
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from "../ports/outbox.repository";
import {
  INBOX_REPOSITORY,
  type InboxRepository,
} from "../ports/inbox.repository";
import { UNIT_OF_WORK, type UnitOfWork } from "../ports/unit-of-work";
import {
  APP_CONFIG,
  CLOCK,
  ID_GENERATOR,
  PAYLOAD_HASHER,
  type AppConfig,
  type Clock,
  type IdGenerator,
  type PayloadHasher,
} from "../ports/support";
import { UniqueConstraintError } from "../errors/unique-constraint-error";
import { METRICS, type MetricsPort } from "../ports/metrics.port";

export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  inbox?: { consumerName: string; messageId: string };
  correlationId: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

const BUSINESS_HASH_FIELDS = [
  "providerId",
  "externalTransactionId",
  "playerId",
  "walletId",
  "roundId",
  "gameId",
  "kind",
  "money",
  "referenceExternalTransactionId",
] as const;

@Injectable()
export class ProcessWagerTransactionUseCase {
  private readonly logger = new Logger(ProcessWagerTransactionUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(INBOX_REPOSITORY) private readonly inbox: InboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PAYLOAD_HASHER) private readonly hasher: PayloadHasher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    if (command.kind === WagerTransactionKind.Opening) {
      throw new BusinessRejectionError(
        FailureCode.OPENING_NOT_ALLOWED,
        "OPENING is an internal operation and cannot be submitted",
      );
    }

    const payloadHash = this.hasher.hash(this.businessPayload(command));

    try {
      return await this.uow.run(() => this.processInsideTransaction(command, payloadHash));
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        return this.uow.run(() => this.recoverFromUnique(command, payloadHash));
      }
      throw error;
    }
  }

  private async processInsideTransaction(
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const now = this.clock.now();

    if (command.inbox) {
      const existingInbox = await this.inbox.find(
        command.inbox.consumerName,
        command.inbox.messageId,
      );
      if (existingInbox?.isProcessed()) {
        this.metrics.recordDuplicate("inbox");
        const replayed = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
        if (replayed) {
          return this.toResult(replayed, true);
        }
      }
      if (!existingInbox) {
        await this.inbox.save(
          InboxMessage.receive({
            messageId: command.inbox.messageId,
            consumerName: command.inbox.consumerName,
            payloadHash,
            receivedAt: now,
          }),
        );
      }
    }

    const existing = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        this.metrics.recordDuplicate("idempotency_conflict");
        throw ConflictError.idempotency();
      }
      this.metrics.recordDuplicate("idempotency_replay");
      return this.toResult(existing, true);
    }

    const wallet = await this.wallets.findByIdForUpdate(command.walletId);
    if (!wallet) {
      throw new NotFoundError(FailureCode.WALLET_NOT_FOUND, "Wallet not found");
    }
    if (wallet.playerId !== command.playerId) {
      throw new BusinessRejectionError(
        FailureCode.REFERENCE_SCOPE_MISMATCH,
        "playerId does not match the target wallet",
      );
    }

    let money: Money;
    try {
      money = Money.from(command.money);
    } catch (error) {
      if (error instanceof InvalidMoneyError) {
        throw new BusinessRejectionError(FailureCode.INVALID_MONEY, error.message);
      }
      throw error;
    }

    if (money.currency !== wallet.currency) {
      throw new BusinessRejectionError(
        FailureCode.CURRENCY_MISMATCH,
        "Operation currency does not match wallet currency",
      );
    }
    if (money.isNegative() || money.isZero()) {
      throw new BusinessRejectionError(
        FailureCode.INVALID_MONEY,
        "Transaction amount must be greater than zero",
      );
    }

    let transaction: WagerTransaction;
    try {
      transaction = WagerTransaction.create({
        id: this.ids.uuid(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof InvalidTransactionStateError || error instanceof InvalidMoneyError) {
        throw new BusinessRejectionError(error.code, error.message);
      }
      throw error;
    }

    await this.transactions.save(transaction);

    const outcome = await this.applyTransaction(transaction, wallet, now, command.correlationId);

    if (command.inbox) {
      const inboxMessage = await this.inbox.find(
        command.inbox.consumerName,
        command.inbox.messageId,
      );
      if (inboxMessage && !inboxMessage.isProcessed()) {
        inboxMessage.markProcessed(now);
        await this.inbox.save(inboxMessage);
      }
    }

    this.metrics.recordTransaction(outcome.status, transaction.kind);
    this.logger.log({
      msg: "wager_processed",
      correlationId: command.correlationId,
      messageId: command.inbox?.messageId,
      transactionId: outcome.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      status: outcome.status,
      idempotentReplay: outcome.idempotentReplay,
    });
    return outcome;
  }

  async reprocessPending(transactionId: string, correlationId: string): Promise<ProcessWagerResult> {
    return this.uow.run(async () => {
      const now = this.clock.now();
      const transaction = await this.transactions.findById(transactionId);
      if (!transaction) {
        throw new NotFoundError(FailureCode.TRANSACTION_NOT_FOUND, "Transaction not found");
      }
      if (transaction.status !== WagerTransactionStatus.PendingReference) {
        return this.toResult(transaction, false);
      }

      const wallet = await this.wallets.findByIdForUpdate(transaction.walletId);
      if (!wallet) {
        throw new NotFoundError(FailureCode.WALLET_NOT_FOUND, "Wallet not found");
      }

      const outcome = await this.applyTransaction(transaction, wallet, now, correlationId);
      this.logger.log({
        msg: "wager_reprocessed_pending_reference",
        correlationId,
        transactionId: outcome.transactionId,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        status: outcome.status,
      });
      return outcome;
    });
  }

  private async applyTransaction(
    transaction: WagerTransaction,
    wallet: import("../../domain/wallet/wallet").Wallet,
    now: Date,
    correlationId: string,
  ): Promise<ProcessWagerResult> {
    let reference: WagerTransaction | undefined;

    if (transaction.requiresReference()) {
      const refExt = transaction.referenceExternalTransactionId;
      if (!refExt) {
        await this.rejectAndPersist(
          transaction,
          wallet,
          FailureCode.REFERENCE_REQUIRED,
          now,
          correlationId,
        );
        return this.toResult(transaction, false, wallet.balance);
      }

      reference = await this.transactions.findByProviderExternal(
        transaction.providerId,
        refExt,
      );

      if (!reference) {
        if (transaction.attemptCount + 1 >= this.config.maxPendingReferenceAttempts) {
          await this.rejectAndPersist(
            transaction,
            wallet,
            FailureCode.REFERENCE_NOT_FOUND,
            now,
            correlationId,
          );
          return this.toResult(transaction, false, wallet.balance);
        }

        const backoff =
          this.config.pendingReferenceBaseBackoffMs * 2 ** transaction.attemptCount;
        transaction.markPendingReference(now, backoff);
        await this.transactions.save(transaction);
        if (transaction.attemptCount === 1) {
          await this.enqueue(
            WagerTransactionPendingReference.from(transaction, {
              eventId: this.ids.uuid(),
              correlationId,
              causationId: transaction.id,
              occurredAt: now,
            }),
          );
        }
        return this.toResult(transaction, false, wallet.balance);
      }

      const alreadyReversed = await this.findConflictingReversal(transaction, reference);
      const failure = ReferenceValidator.validate(
        transaction,
        wallet,
        reference,
        alreadyReversed,
      );
      if (failure) {
        await this.rejectAndPersist(transaction, wallet, failure, now, correlationId);
        return this.toResult(transaction, false);
      }
    }

    try {
      const entry = wallet.apply(transaction, this.ids.uuid(), now, reference);
      transaction.markProcessed(reference?.id, now, wallet.balance);
      await this.transactions.save(transaction);
      if (entry) {
        await this.wallets.save(wallet);
        await this.ledger.save(entry);
        await this.enqueue(
          WalletBalanceChanged.from(wallet, entry, {
            eventId: this.ids.uuid(),
            correlationId,
            causationId: transaction.id,
            occurredAt: now,
          }),
        );
      }
      await this.enqueue(
        WagerTransactionProcessed.from(transaction, {
          eventId: this.ids.uuid(),
          correlationId,
          causationId: transaction.id,
          occurredAt: now,
        }),
      );
      return this.toResult(transaction, false);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        await this.rejectAndPersist(
          transaction,
          wallet,
          FailureCode.INSUFFICIENT_FUNDS,
          now,
          correlationId,
        );
        return this.toResult(transaction, false);
      }
      if (error instanceof ReversalWouldOverdrawError) {
        await this.rejectAndPersist(
          transaction,
          wallet,
          FailureCode.REVERSAL_WOULD_OVERDRAW,
          now,
          correlationId,
        );
        return this.toResult(transaction, false);
      }
      if (error instanceof CurrencyMismatchError) {
        await this.rejectAndPersist(
          transaction,
          wallet,
          FailureCode.CURRENCY_MISMATCH,
          now,
          correlationId,
        );
        return this.toResult(transaction, false);
      }
      throw error;
    }
  }

  private async findConflictingReversal(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): Promise<WagerTransaction | undefined> {
    const sameKind = await this.transactions.findProcessedReversal(
      reference.id,
      transaction.kind,
    );
    if (sameKind) {
      return sameKind;
    }
    if (
      transaction.kind === WagerTransactionKind.Refund ||
      (transaction.kind === WagerTransactionKind.Rollback &&
        reference.kind === WagerTransactionKind.Bet)
    ) {
      return this.transactions.findAnyProcessedReversal(reference.id);
    }
    return undefined;
  }

  private async rejectAndPersist(
    transaction: WagerTransaction,
    wallet: import("../../domain/wallet/wallet").Wallet,
    code: FailureCode,
    now: Date,
    correlationId: string,
  ): Promise<void> {
    transaction.reject(code, now, wallet.balance);
    await this.transactions.save(transaction);
    await this.enqueue(
      WagerTransactionRejected.from(transaction, {
        eventId: this.ids.uuid(),
        correlationId,
        causationId: transaction.id,
        occurredAt: now,
      }),
    );
  }

  private async enqueue(event: import("../../domain/events/integration-event").IntegrationEvent<unknown>): Promise<void> {
    await this.outbox.save(OutboxMessage.enqueue(event));
  }

  private async recoverFromUnique(
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const existing = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        throw ConflictError.idempotency();
      }
      this.metrics.recordDuplicate("unique_constraint");
      return this.toResult(existing, true);
    }
    throw ConflictError.idempotency();
  }

  private businessPayload(command: ProcessWagerCommand): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const key of BUSINESS_HASH_FIELDS) {
      payload[key] = command[key] ?? null;
    }
    return payload;
  }

  private toResult(
    transaction: WagerTransaction,
    replay: boolean,
    fallbackBalance?: Money,
  ): ProcessWagerResult {
    const balance = transaction.observedBalance ?? fallbackBalance ?? Money.zero(transaction.money.currency);
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: balance.toJSON(),
      idempotentReplay: replay,
      failureCode: transaction.failureCode,
    };
  }
}
