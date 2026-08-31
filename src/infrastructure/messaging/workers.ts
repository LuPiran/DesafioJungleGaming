import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { RequestContext } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { PublishOutboxUseCase } from "../../application/use-cases/publish-outbox.use-case";
import { ReprocessPendingReferencesUseCase } from "../../application/use-cases/reprocess-pending-references.use-case";

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private loop?: Promise<void>;
  private readonly intervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500);

  constructor(
    private readonly publisher: PublishOutboxUseCase,
    private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED === "false") {
      return;
    }
    this.running = true;
    this.loop = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const published = await RequestContext.create(this.em, () => this.publisher.execute(50));
        if (published === 0) {
          await sleep(this.intervalMs);
        }
      } catch (error) {
        this.logger.error({
          msg: "outbox_poll_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(this.intervalMs);
      }
    }
  }
}

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private loop?: Promise<void>;
  private readonly intervalMs = Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 1000);

  constructor(
    private readonly reprocessor: ReprocessPendingReferencesUseCase,
    private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED === "false") {
      return;
    }
    this.running = true;
    this.loop = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        await RequestContext.create(this.em, () => this.reprocessor.execute(20));
      } catch (error) {
        this.logger.error({
          msg: "pending_reference_poll_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(this.intervalMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
