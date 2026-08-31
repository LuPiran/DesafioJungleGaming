import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "wallets" })
@Unique({ name: "uq_wallets_player_currency", properties: ["playerId", "currency"] })
@Check({
  name: "chk_wallets_balance_non_negative",
  expression: "balance_amount >= 0",
})
@Check({ name: "chk_wallets_version_positive", expression: "version >= 1" })
export class WalletOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "uuid", fieldName: "player_id" })
  playerId!: string;

  @Property({ type: "char", length: 3 })
  currency!: string;

  @Property({ type: "decimal", precision: 18, scale: 2, fieldName: "balance_amount" })
  balanceAmount!: string;

  @Property({ type: "int" })
  version!: number;

  @Property({ type: "timestamptz", fieldName: "created_at" })
  createdAt!: Date;

  @Property({ type: "timestamptz", fieldName: "updated_at" })
  updatedAt!: Date;
}

@Entity({ tableName: "wager_transactions" })
@Unique({ name: "uq_wager_idempotency_key", properties: ["idempotencyKey"] })
@Unique({
  name: "uq_wager_provider_external",
  properties: ["providerId", "externalTransactionId"],
})
@Index({ name: "idx_wager_status_retry", properties: ["status", "nextRetryAt"] })
@Check({
  name: "chk_wager_kind",
  expression: "kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')",
})
@Check({
  name: "chk_wager_status",
  expression:
    "status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')",
})
@Check({ name: "chk_wager_amount_non_negative", expression: "amount >= 0" })
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "text", fieldName: "provider_id" })
  providerId!: string;

  @Property({ type: "text", fieldName: "external_transaction_id" })
  externalTransactionId!: string;

  @Property({ type: "text", fieldName: "idempotency_key" })
  idempotencyKey!: string;

  @Property({ type: "text", fieldName: "payload_hash" })
  payloadHash!: string;

  @Property({ type: "uuid", fieldName: "wallet_id" })
  walletId!: string;

  @Property({ type: "uuid", fieldName: "player_id" })
  playerId!: string;

  @Property({ type: "text", fieldName: "round_id" })
  roundId!: string;

  @Property({ type: "text", fieldName: "game_id" })
  gameId!: string;

  @Property({ type: "text" })
  kind!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: "char", length: 3 })
  currency!: string;

  @Property({ type: "text", fieldName: "reference_external_transaction_id", nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: "timestamptz", fieldName: "created_at" })
  createdAt!: Date;

  @Property({ type: "text" })
  status!: string;

  @Property({ type: "uuid", fieldName: "reference_transaction_id", nullable: true })
  referenceTransactionId?: string;

  @Property({ type: "text", fieldName: "failure_code", nullable: true })
  failureCode?: string;

  @Property({ type: "timestamptz", fieldName: "processed_at", nullable: true })
  processedAt?: Date;

  @Property({ type: "int", fieldName: "attempt_count", default: 0 })
  attemptCount: number = 0;

  @Property({ type: "timestamptz", fieldName: "next_retry_at", nullable: true })
  nextRetryAt?: Date;

  @Property({
    type: "decimal",
    precision: 18,
    scale: 2,
    fieldName: "observed_balance_amount",
    nullable: true,
  })
  observedBalanceAmount?: string;

  @Property({ type: "char", length: 3, fieldName: "observed_balance_currency", nullable: true })
  observedBalanceCurrency?: string;
}

@Entity({ tableName: "wallet_ledger_entries" })
@Unique({ name: "uq_ledger_transaction", properties: ["transactionId"] })
@Index({ name: "idx_ledger_wallet_created", properties: ["walletId", "createdAt", "id"] })
@Check({ name: "chk_ledger_direction", expression: "direction IN ('DEBIT','CREDIT')" })
@Check({ name: "chk_ledger_amount_positive", expression: "amount > 0" })
@Check({
  name: "chk_ledger_balances_non_negative",
  expression: "balance_before_amount >= 0 AND balance_after_amount >= 0",
})
export class LedgerOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "uuid", fieldName: "wallet_id" })
  walletId!: string;

  @Property({ type: "uuid", fieldName: "transaction_id" })
  transactionId!: string;

  @Property({ type: "text" })
  direction!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: "char", length: 3 })
  currency!: string;

  @Property({ type: "decimal", precision: 18, scale: 2, fieldName: "balance_before_amount" })
  balanceBeforeAmount!: string;

  @Property({ type: "decimal", precision: 18, scale: 2, fieldName: "balance_after_amount" })
  balanceAfterAmount!: string;

  @Property({ type: "timestamptz", fieldName: "created_at" })
  createdAt!: Date;
}

@Entity({ tableName: "inbox_messages" })
export class InboxOrmEntity {
  @PrimaryKey({ type: "text", fieldName: "consumer_name" })
  consumerName!: string;

  @PrimaryKey({ type: "text", fieldName: "message_id" })
  messageId!: string;

  @Property({ type: "text", fieldName: "payload_hash" })
  payloadHash!: string;

  @Property({ type: "timestamptz", fieldName: "received_at" })
  receivedAt!: Date;

  @Property({ type: "timestamptz", fieldName: "processed_at", nullable: true })
  processedAt?: Date;
}

@Entity({ tableName: "outbox_messages" })
@Index({ name: "idx_outbox_due", properties: ["publishedAt", "nextAttemptAt"] })
export class OutboxOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "text", fieldName: "aggregate_id" })
  aggregateId!: string;

  @Property({ type: "text", fieldName: "event_type" })
  eventType!: string;

  @Property({ type: "jsonb" })
  payload!: Record<string, unknown>;

  @Property({ type: "timestamptz", fieldName: "occurred_at" })
  occurredAt!: Date;

  @Property({ type: "int", default: 0 })
  attempts: number = 0;

  @Property({ type: "timestamptz", fieldName: "next_attempt_at", nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: "timestamptz", fieldName: "published_at", nullable: true })
  publishedAt?: Date;
}
