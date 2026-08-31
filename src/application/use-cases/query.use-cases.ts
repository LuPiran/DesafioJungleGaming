import { Inject, Injectable } from "@nestjs/common";
import { NotFoundError } from "../errors/application-error";
import { FailureCode } from "../../domain/wager-transaction/enums";
import { WALLET_REPOSITORY, type WalletRepository } from "../ports/wallet.repository";
import { LEDGER_REPOSITORY, type LedgerRepository } from "../ports/ledger.repository";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "../ports/wager-transaction.repository";

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository) {}

  async execute(walletId: string) {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new NotFoundError(FailureCode.WALLET_NOT_FOUND, "Wallet not found");
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      currency: wallet.currency,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}

@Injectable()
export class GetLedgerUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  async execute(walletId: string, cursor: string | undefined, limit: number) {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new NotFoundError(FailureCode.WALLET_NOT_FOUND, "Wallet not found");
    }
    const page = await this.ledger.listByWallet(walletId, cursor, Math.min(limit, 100));
    return {
      items: page.items.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}

@Injectable()
export class GetTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
  ) {}

  async byId(transactionId: string) {
    const tx = await this.transactions.findById(transactionId);
    if (!tx) {
      throw new NotFoundError(FailureCode.TRANSACTION_NOT_FOUND, "Transaction not found");
    }
    return this.serialize(tx);
  }

  async byProviderExternal(providerId: string, externalTransactionId: string) {
    const tx = await this.transactions.findByProviderExternal(providerId, externalTransactionId);
    if (!tx) {
      throw new NotFoundError(FailureCode.TRANSACTION_NOT_FOUND, "Transaction not found");
    }
    return this.serialize(tx);
  }

  private serialize(tx: import("../../domain/wager-transaction/wager-transaction").WagerTransaction) {
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      failureCode: tx.failureCode,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      processedAt: tx.processedAt?.toISOString(),
      createdAt: tx.createdAt.toISOString(),
      observedBalance: tx.observedBalance?.toJSON(),
    };
  }
}
