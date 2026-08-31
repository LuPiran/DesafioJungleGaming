import type { WagerTransactionKind } from "../wager-transaction/enums";
import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import { EventContext, IntegrationEvent } from "./integration-event";

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  attemptCount: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId) {
      throw new Error("Pending-reference event requires a reference id");
    }
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        attemptCount: transaction.attemptCount,
      },
    });
  }
}
