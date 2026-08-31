import { Injectable } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/core";
import type { OutboxMessage } from "../../../../domain/outbox/outbox-message";
import type { OutboxRepository } from "../../../../application/ports/outbox.repository";
import { OutboxOrmEntity } from "../entities";
import { OutboxMapper } from "../mappers";

@Injectable()
export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async save(message: OutboxMessage): Promise<void> {
    const existing = await this.em.findOne(OutboxOrmEntity, { id: message.id });
    const row = OutboxMapper.toOrm(message, existing ?? new OutboxOrmEntity());
    await this.em.persist(row).flush();
  }

  async saveAll(messages: OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      await this.save(message);
    }
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxOrmEntity,
      {
        publishedAt: null,
        nextAttemptAt: { $lte: now },
      },
      {
        orderBy: { occurredAt: "ASC" },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return rows.map((row) => OutboxMapper.toDomain(row));
  }
}
