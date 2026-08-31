import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { MessagePublisher } from "../../../application/ports/support";

export interface SqsRuntimeConfig {
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  wagerQueueName: string;
  wagerDlqName: string;
  eventsQueueName: string;
  visibilityTimeout: number;
  waitTimeSeconds: number;
}

@Injectable()
export class SqsService implements MessagePublisher, OnModuleDestroy {
  private readonly logger = new Logger(SqsService.name);
  private readonly client: SQSClient;
  private wagerQueueUrl?: string;
  private eventsQueueUrl?: string;
  private dlqUrl?: string;

  constructor(private readonly config: SqsRuntimeConfig) {
    this.client = new SQSClient({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.client.destroy();
  }

  async resolveQueues(): Promise<void> {
    this.wagerQueueUrl = await this.getQueueUrl(this.config.wagerQueueName);
    this.eventsQueueUrl = await this.getQueueUrl(this.config.eventsQueueName);
    this.dlqUrl = await this.getQueueUrl(this.config.wagerDlqName);
    this.logger.log({
      msg: "sqs_queues_resolved",
      wager: this.wagerQueueUrl,
      events: this.eventsQueueUrl,
      dlq: this.dlqUrl,
    });
  }

  private resolving?: Promise<void>;

  async ensureResolved(): Promise<void> {
    if (this.wagerQueueUrl && this.eventsQueueUrl && this.dlqUrl) {
      return;
    }
    if (!this.resolving) {
      this.resolving = this.resolveQueues().catch((error: unknown) => {
        this.resolving = undefined;
        throw error;
      });
    }
    await this.resolving;
  }

  async receiveWagerMessages(max = 5): Promise<Message[]> {
    await this.ensureResolved();
    if (!this.wagerQueueUrl) {
      throw new Error("Wager queue URL not resolved");
    }
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: this.config.waitTimeSeconds,
        VisibilityTimeout: this.config.visibilityTimeout,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );
    return response.Messages ?? [];
  }

  async ack(receiptHandle: string): Promise<void> {
    await this.ensureResolved();
    if (!this.wagerQueueUrl) {
      throw new Error("Wager queue URL not resolved");
    }
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async publish(input: {
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    groupId: string;
    deduplicationId: string;
  }): Promise<void> {
    await this.ensureResolved();
    if (!this.eventsQueueUrl) {
      throw new Error("Events queue URL not resolved");
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.eventsQueueUrl,
        MessageBody: JSON.stringify(input.payload),
        MessageGroupId: input.groupId,
        MessageDeduplicationId: input.deduplicationId,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: input.eventType },
        },
      }),
    );
  }

  async sendWager(body: unknown, groupId: string, deduplicationId: string): Promise<void> {
    await this.ensureResolved();
    if (!this.wagerQueueUrl) {
      throw new Error("Wager queue URL not resolved");
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  async ping(): Promise<boolean> {
    await this.getQueueUrl(this.config.wagerQueueName);
    return true;
  }

  async dlqApproximateSize(): Promise<number> {
    await this.ensureResolved();
    if (!this.dlqUrl) {
      return 0;
    }
    const attrs = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.dlqUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    return Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0);
  }

  private async getQueueUrl(name: string): Promise<string> {
    const response = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!response.QueueUrl) {
      throw new Error(`Queue not found: ${name}`);
    }
    return response.QueueUrl;
  }
}

export { CreateQueueCommand };
