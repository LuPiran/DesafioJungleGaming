import { Injectable } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/core";
import type { WagerTransaction } from "../../../../domain/wager-transaction/wager-transaction";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../../domain/wager-transaction/enums";
import type { WagerTransactionRepository } from "../../../../application/ports/wager-transaction.repository";
import { WagerTransactionOrmEntity } from "../entities";
import { TransactionMapper } from "../mappers";

@Injectable()
export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionOrmEntity, { id });
    return row ? TransactionMapper.toDomain(row) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionOrmEntity, { idempotencyKey: key });
    return row ? TransactionMapper.toDomain(row) : undefined;
  }

  async findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionOrmEntity, {
      providerId,
      externalTransactionId,
    });
    return row ? TransactionMapper.toDomain(row) : undefined;
  }

  async findProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionOrmEntity, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return row ? TransactionMapper.toDomain(row) : undefined;
  }

  async findAnyProcessedReversal(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionOrmEntity, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return row ? TransactionMapper.toDomain(row) : undefined;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = await this.em.find(
      WagerTransactionOrmEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        nextRetryAt: { $lte: now },
      },
      {
        orderBy: { nextRetryAt: "ASC" },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return rows.map((row) => TransactionMapper.toDomain(row));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const existing = await this.em.findOne(WagerTransactionOrmEntity, { id: transaction.id });
    const row = TransactionMapper.toOrm(transaction, existing ?? new WagerTransactionOrmEntity());
    await this.em.persist(row).flush();
  }
}
