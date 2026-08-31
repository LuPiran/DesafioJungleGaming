import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import type { InboxMessage } from "../../../../domain/inbox/inbox-message";
import type { InboxRepository } from "../../../../application/ports/inbox.repository";
import { InboxOrmEntity } from "../entities";
import { InboxMapper } from "../mappers";

@Injectable()
export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(InboxOrmEntity, { consumerName, messageId });
    return row ? InboxMapper.toDomain(row) : undefined;
  }

  async save(message: InboxMessage): Promise<void> {
    const existing = await this.em.findOne(InboxOrmEntity, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    const row = InboxMapper.toOrm(message, existing ?? new InboxOrmEntity());
    await this.em.persist(row).flush();
  }
}
