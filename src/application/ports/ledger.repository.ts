import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";

export const LEDGER_REPOSITORY = Symbol("LEDGER_REPOSITORY");

export interface LedgerPage {
  items: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface LedgerRepository {
  save(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPage>;
  sumByWallet(walletId: string): Promise<{
    credits: string;
    debits: string;
    count: number;
    currency: string;
  }>;
}
