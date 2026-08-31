import { Migration } from "@mikro-orm/migrations";

export class Migration20260831120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_amount NUMERIC(18, 2) NOT NULL,
        version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT chk_wallets_currency CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_wallets_scale CHECK (scale(balance_amount) <= 2)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_external_transaction_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL,
        reference_transaction_id UUID REFERENCES wager_transactions(id),
        failure_code TEXT,
        processed_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        observed_balance_amount NUMERIC(18, 2),
        observed_balance_currency CHAR(3),
        CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT chk_wager_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT chk_wager_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT chk_wager_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT chk_wager_scale CHECK (scale(amount) <= 2),
        CONSTRAINT chk_wager_currency CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE INDEX idx_wager_status_retry
        ON wager_transactions (status, next_retry_at)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_refund_once
        ON wager_transactions (reference_transaction_id)
        WHERE kind = 'REFUND'
          AND status = 'PROCESSED'
          AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_rollback_once
        ON wager_transactions (reference_transaction_id)
        WHERE kind = 'ROLLBACK'
          AND status = 'PROCESSED'
          AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        direction TEXT NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_before_amount NUMERIC(18, 2) NOT NULL,
        balance_after_amount NUMERIC(18, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_ledger_transaction UNIQUE (transaction_id),
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_ledger_balances_non_negative CHECK (
          balance_before_amount >= 0 AND balance_after_amount >= 0
        ),
        CONSTRAINT chk_ledger_scale CHECK (
          scale(amount) <= 2
          AND scale(balance_before_amount) <= 2
          AND scale(balance_after_amount) <= 2
        ),
        CONSTRAINT chk_ledger_currency CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_created
        ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );
    `);

    this.addSql(`
      CREATE INDEX idx_outbox_due
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql("DROP TABLE IF EXISTS outbox_messages;");
    this.addSql("DROP TABLE IF EXISTS inbox_messages;");
    this.addSql("DROP TABLE IF EXISTS wallet_ledger_entries;");
    this.addSql("DROP TABLE IF EXISTS wager_transactions;");
    this.addSql("DROP TABLE IF EXISTS wallets;");
  }
}
