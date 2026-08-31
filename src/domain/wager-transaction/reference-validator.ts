import { FailureCode } from "../wager-transaction/enums";
import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import type { Wallet } from "../wallet/wallet";

export class ReferenceValidator {
  static validate(
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction,
    alreadyReversedBy: WagerTransaction | undefined,
  ): FailureCode | undefined {
    if (reference.providerId !== transaction.providerId) {
      return FailureCode.REFERENCE_SCOPE_MISMATCH;
    }
    if (reference.playerId !== transaction.playerId) {
      return FailureCode.REFERENCE_SCOPE_MISMATCH;
    }
    if (reference.walletId !== wallet.id || reference.walletId !== transaction.walletId) {
      return FailureCode.REFERENCE_SCOPE_MISMATCH;
    }
    if (reference.roundId !== transaction.roundId) {
      return FailureCode.REFERENCE_SCOPE_MISMATCH;
    }
    if (reference.money.currency !== transaction.money.currency) {
      return FailureCode.CURRENCY_MISMATCH;
    }
    if (reference.status !== "PROCESSED") {
      return FailureCode.REFERENCE_NOT_PROCESSED;
    }
    if (!transaction.allowedReferenceKinds().has(reference.kind)) {
      return FailureCode.REFERENCE_KIND_NOT_ALLOWED;
    }
    if (!reference.money.equals(transaction.money)) {
      return FailureCode.REFERENCE_AMOUNT_MISMATCH;
    }
    if (alreadyReversedBy) {
      return FailureCode.REFERENCE_ALREADY_REVERSED;
    }
    return undefined;
  }
}
