import { defineConfig, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { ReflectMetadataProvider } from "@mikro-orm/decorators/legacy";
import {
  InboxOrmEntity,
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from "./entities";

export function buildMikroOrmConfig() {
  return defineConfig({
    driver: PostgreSqlDriver,
    host: process.env.DATABASE_HOST ?? "localhost",
    port: Number(process.env.DATABASE_PORT ?? 5432),
    user: process.env.DATABASE_USER ?? "wagering",
    password: process.env.DATABASE_PASSWORD ?? "wagering",
    dbName: process.env.DATABASE_NAME ?? "wagering",
    entities: [
      WalletOrmEntity,
      WagerTransactionOrmEntity,
      LedgerOrmEntity,
      InboxOrmEntity,
      OutboxOrmEntity,
    ],
    migrations: {
      path: "src/infrastructure/persistence/mikro-orm/migrations",
      snapshot: false,
      transactional: true,
    },
    extensions: [Migrator],
    metadataProvider: ReflectMetadataProvider,
    pool: { min: 2, max: 10 },
    allowGlobalContext: false,
  });
}

export default buildMikroOrmConfig();
