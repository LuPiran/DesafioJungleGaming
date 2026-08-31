import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import { RequestContext } from "@mikro-orm/core";
import { PublishOutboxUseCase } from "../../src/application/use-cases/publish-outbox.use-case";
import { openWallet, startHarness, stopApp, waitFor, type Harness } from "../helpers/harness";

describe("concurrent outbox publishers", () => {
  let seeder: Harness;
  let publisherA: Harness;
  let publisherB: Harness;

  beforeAll(async () => {
    seeder = await startHarness({ workers: false });
    for (let i = 0; i < 8; i += 1) {
      await openWallet(seeder.baseUrl, "25.00");
    }
    await stopApp(seeder.app);
    publisherA = await startHarness({ outboxOnly: true });
    publisherB = await startHarness({ outboxOnly: true });
  }, 180_000);

  afterAll(async () => {
    if (publisherA) await stopApp(publisherA.app);
    if (publisherB) await stopApp(publisherB.app);
  });

  test("two publishers drain the same outbox without leaving unpublished rows", async () => {
    const drain = async (app: Harness) => {
      const em = app.app.get(EntityManager);
      const publisher = app.app.get(PublishOutboxUseCase);
      for (let i = 0; i < 20; i += 1) {
        await RequestContext.create(em, () => publisher.execute(50));
      }
    };

    await Promise.all([drain(publisherA), drain(publisherB)]);

    const em = publisherA.app.get(EntityManager);
    await waitFor(async () => {
      const unpublished = (await em.getConnection().execute(
        `select count(*)::int as c from outbox_messages where published_at is null`,
      )) as Array<{ c: number }>;
      return Number(unpublished[0]?.c ?? -1) === 0;
    });

    const published = (await em.getConnection().execute(
      `select count(*)::int as c from outbox_messages where published_at is not null`,
    )) as Array<{ c: number }>;

    expect(Number(published[0]?.c ?? 0)).toBeGreaterThanOrEqual(16);
  });
});
