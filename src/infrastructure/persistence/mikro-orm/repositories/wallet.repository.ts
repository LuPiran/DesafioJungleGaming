import { Injectable } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/core";
import type { Wallet } from "../../../../domain/wallet/wallet";
import type { WalletRepository } from "../../../../application/ports/wallet.repository";
import { WalletOrmEntity } from "../entities";
import { WalletMapper } from "../mappers";

@Injectable()
export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletOrmEntity, { id });
    return row ? WalletMapper.toDomain(row) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletOrmEntity, { id }, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });
    return row ? WalletMapper.toDomain(row) : undefined;
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletOrmEntity, { playerId, currency });
    return row ? WalletMapper.toDomain(row) : undefined;
  }

  async save(wallet: Wallet): Promise<void> {
    const existing = await this.em.findOne(WalletOrmEntity, { id: wallet.id });
    const row = WalletMapper.toOrm(wallet, existing ?? new WalletOrmEntity());
    await this.em.persist(row).flush();
  }
}
