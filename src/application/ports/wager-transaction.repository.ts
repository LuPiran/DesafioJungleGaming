import type { WagerTransactionKind } from "../../domain/wager-transaction/enums";
import type { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";

export const WAGER_TRANSACTION_REPOSITORY = Symbol("WAGER_TRANSACTION_REPOSITORY");

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | undefined>;
  findAnyProcessedReversal(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;
  save(transaction: WagerTransaction): Promise<void>;
}
