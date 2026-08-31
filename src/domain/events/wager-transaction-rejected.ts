import type { MoneyProps } from "../money/money";
import type { FailureCode, WagerTransactionKind } from "../wager-transaction/enums";
import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import { EventContext, IntegrationEvent } from "./integration-event";

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  failureCode: FailureCode;
  money: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!transaction.failureCode) {
      throw new Error("Rejected event requires a failureCode");
    }
    return new WagerTransactionRejected({
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
        failureCode: transaction.failureCode,
        money: transaction.money.toJSON(),
      },
    });
  }
}
