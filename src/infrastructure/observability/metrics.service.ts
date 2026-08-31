import { Injectable, Logger } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { MetricsPort } from "../../application/ports/metrics.port";

@Injectable()
export class PrometheusMetrics implements MetricsPort {
  readonly registry = new Registry();

  private readonly transactionsTotal: Counter;
  private readonly duplicatesTotal: Counter;
  private readonly retriesTotal: Counter;
  private readonly dlqTotal: Counter;
  private readonly lockConflictsTotal: Counter;
  private readonly outboxLag: Gauge;
  private readonly processingLatency: Histogram;
  private readonly reconciliationTotal: Counter;

  constructor() {
    this.registry.setDefaultLabels({ service: "wagering-processor" });
    collectDefaultMetrics({ register: this.registry });

    this.transactionsTotal = new Counter({
      name: "wagering_transactions_total",
      help: "Wager transactions by status and kind",
      labelNames: ["status", "kind"],
      registers: [this.registry],
    });
    this.duplicatesTotal = new Counter({
      name: "wagering_duplicates_total",
      help: "Detected duplicate deliveries or idempotent replays",
      labelNames: ["source"],
      registers: [this.registry],
    });
    this.retriesTotal = new Counter({
      name: "wagering_retries_total",
      help: "Retry attempts",
      labelNames: ["kind"],
      registers: [this.registry],
    });
    this.dlqTotal = new Counter({
      name: "wagering_dlq_messages_total",
      help: "Messages sent to or observed in the DLQ",
      registers: [this.registry],
    });
    this.lockConflictsTotal = new Counter({
      name: "wagering_lock_conflicts_total",
      help: "Database lock/serialization conflicts",
      registers: [this.registry],
    });
    this.outboxLag = new Gauge({
      name: "wagering_outbox_lag",
      help: "Unpublished outbox messages claimed in the last poll",
      registers: [this.registry],
    });
    this.processingLatency = new Histogram({
      name: "wagering_processing_latency_seconds",
      help: "End-to-end processing latency",
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.reconciliationTotal = new Counter({
      name: "wagering_reconciliation_total",
      help: "Wallet reconciliation checks",
      labelNames: ["consistent"],
      registers: [this.registry],
    });
  }

  recordTransaction(status: string, kind: string): void {
    this.transactionsTotal.inc({ status, kind });
  }

  recordDuplicate(source: string): void {
    this.duplicatesTotal.inc({ source });
  }

  recordRetry(kind: string): void {
    this.retriesTotal.inc({ kind });
  }

  recordDlq(): void {
    this.dlqTotal.inc();
  }

  recordLockConflict(): void {
    this.lockConflictsTotal.inc();
  }

  recordOutboxLag(count: number): void {
    this.outboxLag.set(count);
  }

  observeProcessingLatency(seconds: number): void {
    this.processingLatency.observe(seconds);
  }

  recordReconciliation(consistent: boolean): void {
    this.reconciliationTotal.inc({ consistent: String(consistent) });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}

export const metricsLogger = new Logger("Metrics");
