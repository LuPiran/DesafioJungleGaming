export const METRICS = Symbol("METRICS");

export interface MetricsPort {
  recordTransaction(status: string, kind: string): void;
  recordDuplicate(source: string): void;
  recordRetry(kind: string): void;
  recordDlq(): void;
  recordLockConflict(): void;
  recordOutboxLag(count: number): void;
  observeProcessingLatency(seconds: number): void;
  recordReconciliation(consistent: boolean): void;
}
