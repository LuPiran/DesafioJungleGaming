import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { RequestContext } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import type { Message } from "@aws-sdk/client-sqs";
import { SqsService } from "./sqs.service";
import { ProcessWagerTransactionUseCase } from "../../../application/use-cases/process-wager-transaction.use-case";
import { ApplicationError } from "../../../application/errors/application-error";
import { WagerTransactionKind } from "../../../domain/wager-transaction/enums";
import { METRICS, type MetricsPort } from "../../../application/ports/metrics.port";
import { Inject } from "@nestjs/common";

const CONSUMER_NAME = "wager-transaction-consumer";

interface SqsEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);
  private running = false;
  private inFlight = 0;
  private loop?: Promise<void>;

  constructor(
    private readonly sqs: SqsService,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly em: EntityManager,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.SQS_CONSUMER_ENABLED === "false") {
      return;
    }
    this.running = true;
    this.loop = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    const started = Date.now();
    while (this.inFlight > 0 && Date.now() - started < 25_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.loop;
  }

  private queuesReady = false;

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        if (!this.queuesReady) {
          await this.sqs.resolveQueues();
          this.queuesReady = true;
        }
        const messages = await this.sqs.receiveWagerMessages(5);
        for (const message of messages) {
          if (!this.running) {
            break;
          }
          this.inFlight += 1;
          try {
            await this.handle(message);
          } finally {
            this.inFlight -= 1;
          }
        }
      } catch (error) {
        this.logger.error({ msg: "sqs_poll_failed", error: stringifyError(error) });
        await sleep(1000);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const started = Date.now();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    try {
      const envelope = parseEnvelope(message);
      this.logger.log({
        msg: "sqs_message_received",
        correlationId: envelope.messageId,
        messageId: envelope.messageId,
        providerId: envelope.data.providerId,
        walletId: envelope.data.walletId,
        transactionId: envelope.data.externalTransactionId,
        kind: envelope.data.kind,
        receiveCount,
      });

      await RequestContext.create(this.em, async () => {
        await this.processWager.execute({
          ...envelope.data,
          inbox: { consumerName: CONSUMER_NAME, messageId: envelope.messageId },
          correlationId: envelope.messageId,
        });
      });

      await this.sqs.ack(message.ReceiptHandle!);
      this.metrics.observeProcessingLatency((Date.now() - started) / 1000);
    } catch (error) {
      if (error instanceof ApplicationError && !error.retryable) {
        this.logger.warn({
          msg: "sqs_business_error_acked",
          code: error.code,
          correlationId: message.MessageId,
          messageId: message.MessageId,
        });
        await this.sqs.ack(message.ReceiptHandle!);
        return;
      }
      this.metrics.recordRetry("sqs");
      if (receiveCount >= 5) {
        this.metrics.recordDlq();
        this.logger.error({
          msg: "sqs_message_exhausted_to_dlq",
          correlationId: message.MessageId,
          messageId: message.MessageId,
          receiveCount,
        });
      }
      this.logger.warn({
        msg: "sqs_transient_error",
        correlationId: message.MessageId,
        messageId: message.MessageId,
        error: stringifyError(error),
      });
    }
  }
}

function parseEnvelope(message: Message): SqsEnvelope {
  if (!message.Body) {
    throw new Error("Empty SQS body");
  }
  const parsed = JSON.parse(message.Body) as SqsEnvelope;
  if (parsed.type !== "WagerTransactionRequested" || !parsed.data) {
    throw new Error(`Unsupported SQS type: ${parsed.type}`);
  }
  parsed.messageId = parsed.messageId ?? message.MessageId ?? "";
  return parsed;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
