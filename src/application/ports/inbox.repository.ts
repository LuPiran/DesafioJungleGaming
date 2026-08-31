import type { InboxMessage } from "../../domain/inbox/inbox-message";

export const INBOX_REPOSITORY = Symbol("INBOX_REPOSITORY");

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  save(message: InboxMessage): Promise<void>;
}
