import "reflect-metadata";
import { LocalstackContainer, type StartedLocalStackContainer } from "@testcontainers/localstack";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Test } from "@nestjs/testing";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";

process.env.DOCKER_HOST ??= "unix:///var/run/docker.sock";

export interface Harness {
  app: INestApplication;
  port: number;
  postgres: StartedPostgreSqlContainer;
  localstack: StartedLocalStackContainer;
  sqs: SQSClient;
  wagerQueueUrl: string;
  eventsQueueUrl: string;
  dlqUrl: string;
  baseUrl: string;
}

let sharedPostgres: StartedPostgreSqlContainer | undefined;
let sharedLocalstack: StartedLocalStackContainer | undefined;

async function sharedInfrastructure(): Promise<{
  postgres: StartedPostgreSqlContainer;
  localstack: StartedLocalStackContainer;
}> {
  if (!sharedPostgres) {
    sharedPostgres = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("wagering")
      .withUsername("wagering")
      .withPassword("wagering")
      .start();
  }
  if (!sharedLocalstack) {
    sharedLocalstack = await new LocalstackContainer("localstack/localstack:4.3").start();
  }
  return { postgres: sharedPostgres, localstack: sharedLocalstack };
}

export async function startHarness(options?: {
  workers?: boolean;
  outboxOnly?: boolean;
  port?: number;
}): Promise<Harness> {
  const { postgres, localstack } = await sharedInfrastructure();
  const port = options?.port ?? 0;

  const endpoint = localstack.getConnectionUri();
  const sqs = new SQSClient({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  const dlqUrl = await ensureFifoQueue(sqs, "wager-transactions-dlq.fifo");
  const wagerQueueUrl = await ensureFifoQueue(sqs, "wager-transactions.fifo");
  const eventsQueueUrl = await ensureFifoQueue(sqs, "wager-events.fifo");
  await attachRedrive(sqs, wagerQueueUrl, dlqUrl);

  const workers = options?.workers !== false;
  const outboxOnly = options?.outboxOnly === true;

  process.env.DATABASE_HOST = postgres.getHost();
  process.env.DATABASE_PORT = String(postgres.getPort());
  process.env.DATABASE_USER = postgres.getUsername();
  process.env.DATABASE_PASSWORD = postgres.getPassword();
  process.env.DATABASE_NAME = postgres.getDatabase();
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  process.env.AWS_ENDPOINT_URL = endpoint;
  process.env.SQS_WAGER_QUEUE_NAME = "wager-transactions.fifo";
  process.env.SQS_WAGER_DLQ_NAME = "wager-transactions-dlq.fifo";
  process.env.SQS_EVENTS_QUEUE_NAME = "wager-events.fifo";
  process.env.AUTH_ENABLED = "false";
  process.env.LOG_LEVEL = "error";
  process.env.SQS_VISIBILITY_TIMEOUT_SECONDS = "5";
  process.env.SQS_CONSUMER_WAIT_TIME_SECONDS = "1";
  process.env.SQS_CONSUMER_ENABLED =
    workers && !outboxOnly ? "true" : "false";
  process.env.OUTBOX_PUBLISHER_ENABLED = workers || outboxOnly ? "true" : "false";
  process.env.PENDING_REFERENCE_WORKER_ENABLED =
    workers && !outboxOnly ? "true" : "false";
  process.env.MAX_PENDING_REFERENCE_ATTEMPTS = "5";
  process.env.PENDING_REFERENCE_BASE_BACKOFF_MS = "50";

  const { runMigrations } = await import("../../src/infrastructure/persistence/mikro-orm/run-migrations");
  await runMigrations();

  const { AppModule } = await import("../../src/app.module");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();
  await app.listen(port);
  const address = app.getHttpServer().address();
  const bound = typeof address === "object" && address ? address.port : port;

  return {
    app,
    port: bound,
    postgres,
    localstack,
    sqs,
    wagerQueueUrl,
    eventsQueueUrl,
    dlqUrl,
    baseUrl: `http://127.0.0.1:${bound}`,
  };
}

export async function stopApp(app: INestApplication): Promise<void> {
  await app.close();
}

async function ensureFifoQueue(sqs: SQSClient, name: string): Promise<string> {
  try {
    const existing = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (existing.QueueUrl) {
      return existing.QueueUrl;
    }
  } catch {
    // create below
  }
  await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }),
  );
  const created = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  return created.QueueUrl!;
}

async function attachRedrive(sqs: SQSClient, queueUrl: string, dlqUrl: string): Promise<void> {
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ["QueueArn"],
    }),
  );
  const arn = attrs.Attributes?.QueueArn;
  if (!arn) {
    throw new Error("DLQ ARN missing");
  }
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        VisibilityTimeout: "5",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: "3" }),
      },
    }),
  );
}

export function uuid(): string {
  return uuidv7();
}

export async function openWallet(
  baseUrl: string,
  initial = "1000.00",
): Promise<{ id: string; playerId: string; balance: { amount: string }; version: number }> {
  const playerId = uuid();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: initial, currency: "BRL" },
    }),
  });
  if (!response.ok) {
    throw new Error(`openWallet failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as {
    id: string;
    playerId: string;
    balance: { amount: string };
    version: number;
  };
  return { ...body, playerId };
}

export async function submitWager(
  baseUrl: string,
  input: {
    walletId: string;
    playerId: string;
    kind: string;
    amount: string;
    externalTransactionId?: string;
    idempotencyKey?: string;
    roundId?: string;
    referenceExternalTransactionId?: string;
    providerId?: string;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const externalTransactionId = input.externalTransactionId ?? uuid();
  const providerId = input.providerId ?? "provider-a";
  const idempotencyKey = input.idempotencyKey ?? `${providerId}:${externalTransactionId}`;
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      providerId,
      externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId ?? "round-1",
      gameId: "fortune-chimp",
      kind: input.kind,
      money: { amount: input.amount, currency: "BRL" },
      ...(input.referenceExternalTransactionId
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function sendSqsWager(
  harness: Harness,
  data: Record<string, unknown>,
  messageId: string,
): Promise<void> {
  await harness.sqs.send(
    new SendMessageCommand({
      QueueUrl: harness.wagerQueueUrl,
      MessageBody: JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data,
      }),
      MessageGroupId: String(data.walletId),
      MessageDeduplicationId: messageId,
    }),
  );
}

export async function sendRawSqs(
  harness: Harness,
  body: unknown,
  groupId: string,
  deduplicationId: string,
): Promise<void> {
  await harness.sqs.send(
    new SendMessageCommand({
      QueueUrl: harness.wagerQueueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

export async function dlqSize(harness: Harness): Promise<number> {
  const attrs = await harness.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: harness.dlqUrl,
      AttributeNames: ["ApproximateNumberOfMessages"],
    }),
  );
  return Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0);
}

export async function receiveDlq(harness: Harness): Promise<number> {
  const received = await harness.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: harness.dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
    }),
  );
  return received.Messages?.length ?? 0;
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}
