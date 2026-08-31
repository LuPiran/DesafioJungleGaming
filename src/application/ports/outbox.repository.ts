import type { OutboxMessage } from "../../domain/outbox/outbox-message";

export const OUTBOX_REPOSITORY = Symbol("OUTBOX_REPOSITORY");

export interface OutboxRepository {
  save(message: OutboxMessage): Promise<void>;
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  saveAll(messages: OutboxMessage[]): Promise<void>;
}
