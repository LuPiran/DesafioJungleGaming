import { Inject, Injectable, Logger } from "@nestjs/common";
import { Money } from "../../domain/money/money";
import { LedgerDirection } from "../../domain/ledger/ledger-direction";
import { FailureCode } from "../../domain/wager-transaction/enums";
import { NotFoundError } from "../errors/application-error";
import { WALLET_REPOSITORY, type WalletRepository } from "../ports/wallet.repository";
import { LEDGER_REPOSITORY, type LedgerRepository } from "../ports/ledger.repository";
import { METRICS, type MetricsPort } from "../ports/metrics.port";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new NotFoundError(FailureCode.WALLET_NOT_FOUND, "Wallet not found");
    }

    const sum = await this.ledger.sumByWallet(walletId);
    const credits = Money.from({ amount: sum.credits, currency: wallet.currency });
    const debits = Money.from({ amount: sum.debits, currency: wallet.currency });
    const calculated = credits.subtract(debits);
    const difference = wallet.balance.subtract(calculated);
    const consistent = difference.isZero();

    this.metrics.recordReconciliation(consistent);

    if (!consistent) {
      this.logger.error({
        msg: "wallet_reconciliation_divergence",
        walletId,
        storedBalance: wallet.balance.toString(),
        calculatedBalance: calculated.toString(),
        difference: difference.toString(),
        checkedEntries: sum.count,
      });
    }

    return {
      walletId: wallet.id,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: sum.count,
    };
  }
}

export { LedgerDirection };
