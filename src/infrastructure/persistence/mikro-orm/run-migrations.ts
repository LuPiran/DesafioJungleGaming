import { MikroORM } from "@mikro-orm/postgresql";
import { buildMikroOrmConfig } from "./mikro-orm.config";

export async function runMigrations(): Promise<void> {
  const orm = await MikroORM.init({
    ...buildMikroOrmConfig(),
    allowGlobalContext: true,
  });
  try {
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  await runMigrations();
}
