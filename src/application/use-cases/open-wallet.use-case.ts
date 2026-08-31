import { Inject, Injectable } from "@nestjs/common";
import { Money, type MoneyProps } from "../../domain/money/money";
import { Wallet } from "../../domain/wallet/wallet";
import { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { WagerTransactionKind } from "../../domain/wager-transaction/enums";
import { OutboxMessage } from "../../domain/outbox/outbox-message";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed";
import { ConflictError } from "../errors/application-error";
import { UniqueConstraintError } from "../errors/unique-constraint-error";
import { UNIT_OF_WORK, type UnitOfWork } from "../ports/unit-of-work";
import { WALLET_REPOSITORY, type WalletRepository } from "../ports/wallet.repository";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "../ports/wager-transaction.repository";
import { LEDGER_REPOSITORY, type LedgerRepository } from "../ports/ledger.repository";
import { OUTBOX_REPOSITORY, type OutboxRepository } from "../ports/outbox.repository";
import {
  CLOCK,
  ID_GENERATOR,
  PAYLOAD_HASHER,
  type Clock,
  type IdGenerator,
  type PayloadHasher,
} from "../ports/support";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const INTERNAL_PROVIDER = "internal";

@Injectable()
export class OpenWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PAYLOAD_HASHER) private readonly hasher: PayloadHasher,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    try {
      return await this.uow.run(() => this.open(command));
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw ConflictError.duplicateWallet();
      }
      throw error;
    }
  }

  private async open(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const now = this.clock.now();
    const initial = Money.from(command.initialBalance);
    const existing = await this.wallets.findByPlayerAndCurrency(
      command.playerId,
      initial.currency,
    );
    if (existing) {
      throw ConflictError.duplicateWallet();
    }

    const wallet = Wallet.open({
      id: this.ids.uuid(),
      playerId: command.playerId,
      initialBalance: initial,
      createdAt: now,
    });
    await this.wallets.save(wallet);

    if (initial.isPositive()) {
      const opening = WagerTransaction.openWalletCredit({
        id: this.ids.uuid(),
        providerId: INTERNAL_PROVIDER,
        externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `opening:${wallet.id}`,
        payloadHash: this.hasher.hash({
          kind: WagerTransactionKind.Opening,
          walletId: wallet.id,
          amount: initial.toJSON(),
        }),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "opening",
        gameId: "internal",
        kind: WagerTransactionKind.Opening,
        money: initial,
        createdAt: now,
      });
      const entry = wallet.openingEntry(opening, this.ids.uuid(), now);
      await this.transactions.save(opening);
      await this.ledger.save(entry);
      await this.outbox.save(
        OutboxMessage.enqueue(
          WagerTransactionProcessed.from(opening, {
            eventId: this.ids.uuid(),
            correlationId: command.correlationId,
            causationId: opening.id,
            occurredAt: now,
          }),
        ),
      );
      await this.outbox.save(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, {
            eventId: this.ids.uuid(),
            correlationId: command.correlationId,
            causationId: opening.id,
            occurredAt: now,
          }),
        ),
      );
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
