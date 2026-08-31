import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import type { WalletLedgerEntry } from "../../../../domain/ledger/wallet-ledger-entry";
import type { LedgerPage, LedgerRepository } from "../../../../application/ports/ledger.repository";
import { LedgerOrmEntity } from "../entities";
import { LedgerMapper, normalizeDecimal } from "../mappers";

@Injectable()
export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    const row = LedgerMapper.toOrm(entry);
    await this.em.persist(row).flush();
  }

  async listByWallet(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPage> {
    const where: Record<string, unknown> = { walletId };
    if (cursor) {
      const decoded = decodeCursor(cursor);
      where.$or = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, id: { $lt: decoded.id } },
      ];
    }

    const rows = await this.em.find(LedgerOrmEntity, where, {
      orderBy: { createdAt: "DESC", id: "DESC" },
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];

    return {
      items: slice.map((row) => LedgerMapper.toDomain(row)),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined,
    };
  }

  async sumByWallet(walletId: string): Promise<{
    credits: string;
    debits: string;
    count: number;
    currency: string;
  }> {
    const result = (await this.em.getConnection().execute(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS credits,
         COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) AS debits,
         COUNT(*)::int AS count,
         MAX(currency) AS currency
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId],
    )) as Array<{ credits: string; debits: string; count: number; currency: string | null }>;

    const row = result[0];
    const currency = row?.currency ?? "BRL";
    return {
      credits: normalizeDecimal(String(row?.credits ?? "0")),
      debits: normalizeDecimal(String(row?.debits ?? "0")),
      count: Number(row?.count ?? 0),
      currency,
    };
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const [iso, id] = raw.split("|");
  if (!iso || !id) {
    throw new Error("Invalid ledger cursor");
  }
  return { createdAt: new Date(iso), id };
}
