import type { Wallet } from "../../domain/wallet/wallet";

export const WALLET_REPOSITORY = Symbol("WALLET_REPOSITORY");

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined>;
  save(wallet: Wallet): Promise<void>;
}
