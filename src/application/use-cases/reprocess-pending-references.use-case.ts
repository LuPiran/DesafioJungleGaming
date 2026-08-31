import { Inject, Injectable } from "@nestjs/common";
import { UNIT_OF_WORK, type UnitOfWork } from "../ports/unit-of-work";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "../ports/wager-transaction.repository";
import { CLOCK, type Clock } from "../ports/support";
import { ProcessWagerTransactionUseCase } from "./process-wager-transaction.use-case";
import { METRICS, type MetricsPort } from "../ports/metrics.port";

@Injectable()
export class ReprocessPendingReferencesUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly processor: ProcessWagerTransactionUseCase,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async execute(limit = 20): Promise<number> {
    const due = await this.uow.run(() =>
      this.transactions.findDuePendingReferences(this.clock.now(), limit),
    );

    for (const transaction of due) {
      this.metrics.recordRetry("pending_reference");
      await this.processor.reprocessPending(transaction.id, transaction.id);
    }

    return due.length;
  }
}
