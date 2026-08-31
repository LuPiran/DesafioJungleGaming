export const CLOCK = Symbol("CLOCK");

export interface Clock {
  now(): Date;
}

export const ID_GENERATOR = Symbol("ID_GENERATOR");

export interface IdGenerator {
  uuid(): string;
}

export const PAYLOAD_HASHER = Symbol("PAYLOAD_HASHER");

export interface PayloadHasher {
  hash(value: unknown): string;
}

export const APP_CONFIG = Symbol("APP_CONFIG");

export interface AppConfig {
  maxPendingReferenceAttempts: number;
  pendingReferenceBaseBackoffMs: number;
}

export const MESSAGE_PUBLISHER = Symbol("MESSAGE_PUBLISHER");

export interface MessagePublisher {
  publish(input: {
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    groupId: string;
    deduplicationId: string;
  }): Promise<void>;
}
