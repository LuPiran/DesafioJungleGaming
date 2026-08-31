import { Inject, Injectable, Logger } from "@nestjs/common";
import { UNIT_OF_WORK, type UnitOfWork } from "../ports/unit-of-work";
import { OUTBOX_REPOSITORY, type OutboxRepository } from "../ports/outbox.repository";
import {
  CLOCK,
  MESSAGE_PUBLISHER,
  type Clock,
  type MessagePublisher,
} from "../ports/support";
import { METRICS, type MetricsPort } from "../ports/metrics.port";

@Injectable()
export class PublishOutboxUseCase {
  private readonly logger = new Logger(PublishOutboxUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(MESSAGE_PUBLISHER) private readonly publisher: MessagePublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async execute(batchSize = 50): Promise<number> {
    const claimed = await this.uow.run(async () => {
      const now = this.clock.now();
      return this.outbox.claimDue(now, batchSize);
    });

    this.metrics.recordOutboxLag(claimed.length);

    let published = 0;
    for (const message of claimed) {
      try {
        await this.publisher.publish({
          eventType: message.eventType,
          payload: message.payload,
          groupId: message.aggregateId,
          deduplicationId: message.id,
        });
        message.markPublished(this.clock.now());
        await this.uow.run(() => this.outbox.save(message));
        published += 1;
      } catch (error) {
        this.logger.warn({
          msg: "outbox_publish_failed",
          outboxId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
        });
        this.metrics.recordRetry("outbox");
        message.scheduleRetry(this.clock.now());
        await this.uow.run(() => this.outbox.save(message));
      }
    }

    return published;
  }
}
