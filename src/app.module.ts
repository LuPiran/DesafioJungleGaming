import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { LoggerModule } from "nestjs-pino";
import { buildMikroOrmConfig } from "./infrastructure/persistence/mikro-orm/mikro-orm.config";
import { WALLET_REPOSITORY } from "./application/ports/wallet.repository";
import { WAGER_TRANSACTION_REPOSITORY } from "./application/ports/wager-transaction.repository";
import { LEDGER_REPOSITORY } from "./application/ports/ledger.repository";
import { INBOX_REPOSITORY } from "./application/ports/inbox.repository";
import { OUTBOX_REPOSITORY } from "./application/ports/outbox.repository";
import { UNIT_OF_WORK } from "./application/ports/unit-of-work";
import {
  APP_CONFIG,
  CLOCK,
  ID_GENERATOR,
  MESSAGE_PUBLISHER,
  PAYLOAD_HASHER,
} from "./application/ports/support";
import { METRICS } from "./application/ports/metrics.port";
import { MikroWalletRepository } from "./infrastructure/persistence/mikro-orm/repositories/wallet.repository";
import { MikroWagerTransactionRepository } from "./infrastructure/persistence/mikro-orm/repositories/wager-transaction.repository";
import { MikroLedgerRepository } from "./infrastructure/persistence/mikro-orm/repositories/ledger.repository";
import { MikroInboxRepository } from "./infrastructure/persistence/mikro-orm/repositories/inbox.repository";
import { MikroOutboxRepository } from "./infrastructure/persistence/mikro-orm/repositories/outbox.repository";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm/unit-of-work";
import {
  CanonicalSha256Hasher,
  SystemClock,
  UuidV7Generator,
} from "./infrastructure/crypto/support.adapters";
import { PrometheusMetrics } from "./infrastructure/observability/metrics.service";
import { AuthGuard } from "./infrastructure/auth/auth.guard";
import { SqsService, type SqsRuntimeConfig } from "./infrastructure/messaging/sqs/sqs.service";
import { SqsConsumerService } from "./infrastructure/messaging/sqs/sqs-consumer.service";
import {
  OutboxPublisherWorker,
  PendingReferenceWorker,
} from "./infrastructure/messaging/workers";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { OpenWalletUseCase } from "./application/use-cases/open-wallet.use-case";
import {
  GetLedgerUseCase,
  GetTransactionUseCase,
  GetWalletUseCase,
} from "./application/use-cases/query.use-cases";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import { PublishOutboxUseCase } from "./application/use-cases/publish-outbox.use-case";
import { ReprocessPendingReferencesUseCase } from "./application/use-cases/reprocess-pending-references.use-case";
import { WalletsController } from "./interfaces/http/wallets.controller";
import { WageringController } from "./interfaces/http/wagering.controller";
import { HealthController } from "./interfaces/http/health.controller";
import { GlobalExceptionFilter } from "./interfaces/http/http-exception.filter";
import { CorrelationInterceptor } from "./interfaces/http/correlation.interceptor";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        redact: {
          paths: [
            "req.headers.authorization",
            "req.body.money",
            "req.body.initialBalance",
            "req.body.data.money",
          ],
          remove: true,
        },
        serializers: {
          req: (req: { method?: string; url?: string; headers?: Record<string, unknown> }) => ({
            method: req.method,
            url: req.url,
            correlationId: req.headers?.["x-correlation-id"],
          }),
        },
      },
    }),
    MikroOrmModule.forRootAsync({
      useFactory: () => buildMikroOrmConfig(),
    }),
  ],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    { provide: WALLET_REPOSITORY, useClass: MikroWalletRepository },
    { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroWagerTransactionRepository },
    { provide: LEDGER_REPOSITORY, useClass: MikroLedgerRepository },
    { provide: INBOX_REPOSITORY, useClass: MikroInboxRepository },
    { provide: OUTBOX_REPOSITORY, useClass: MikroOutboxRepository },
    { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: PAYLOAD_HASHER, useClass: CanonicalSha256Hasher },
    PrometheusMetrics,
    { provide: METRICS, useExisting: PrometheusMetrics },
    {
      provide: APP_CONFIG,
      useValue: {
        maxPendingReferenceAttempts: Number(process.env.MAX_PENDING_REFERENCE_ATTEMPTS ?? 10),
        pendingReferenceBaseBackoffMs: Number(
          process.env.PENDING_REFERENCE_BASE_BACKOFF_MS ?? 1000,
        ),
      },
    },
    {
      provide: SqsService,
      useFactory: () =>
        new SqsService({
          region: process.env.AWS_REGION ?? "us-east-1",
          endpoint: process.env.AWS_ENDPOINT_URL,
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
          wagerQueueName: process.env.SQS_WAGER_QUEUE_NAME ?? "wager-transactions.fifo",
          wagerDlqName: process.env.SQS_WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo",
          eventsQueueName: process.env.SQS_EVENTS_QUEUE_NAME ?? "wager-events.fifo",
          visibilityTimeout: Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 30),
          waitTimeSeconds: Number(process.env.SQS_CONSUMER_WAIT_TIME_SECONDS ?? 5),
        } satisfies SqsRuntimeConfig),
    },
    { provide: MESSAGE_PUBLISHER, useExisting: SqsService },
    ProcessWagerTransactionUseCase,
    OpenWalletUseCase,
    GetWalletUseCase,
    GetLedgerUseCase,
    GetTransactionUseCase,
    ReconcileWalletUseCase,
    PublishOutboxUseCase,
    ReprocessPendingReferencesUseCase,
    SqsConsumerService,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    AuthGuard,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
  ],
})
export class AppModule {}
