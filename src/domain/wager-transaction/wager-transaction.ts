import {
  InvalidMoneyError,
  InvalidTransactionStateError,
} from "../errors/domain-error";
import {
  invertLedgerDirection,
  LedgerDirection,
} from "../ledger/ledger-direction";
import { Money } from "../money/money";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./enums";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  attemptCount: number;
  nextRetryAt?: Date;
  observedBalance?: Money;
}

const KINDS_REQUIRING_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _attemptCount: number,
    private _nextRetryAt: Date | undefined,
    private _observedBalance: Money | undefined,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionStateError(
        "OPENING cannot be submitted through public entry points",
        FailureCode.OPENING_NOT_ALLOWED,
      );
    }
    if (props.money.isNegative() || props.money.isZero()) {
      throw new InvalidMoneyError("Transaction amount must be greater than zero");
    }
    if (
      KINDS_REQUIRING_REFERENCE.has(props.kind) &&
      !props.referenceExternalTransactionId
    ) {
      throw new InvalidTransactionStateError(
        `${props.kind} requires referenceExternalTransactionId`,
        FailureCode.REFERENCE_REQUIRED,
      );
    }
    if (
      !KINDS_REQUIRING_REFERENCE.has(props.kind) &&
      props.kind !== WagerTransactionKind.Win &&
      props.referenceExternalTransactionId
    ) {
      throw new InvalidTransactionStateError(
        `${props.kind} must not carry a referenceExternalTransactionId`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
    );
  }

  static openWalletCredit(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind !== WagerTransactionKind.Opening) {
      throw new InvalidTransactionStateError("openWalletCredit requires OPENING kind");
    }
    if (props.money.isNegative() || props.money.isZero()) {
      throw new InvalidMoneyError("OPENING amount must be greater than zero");
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.createdAt,
      0,
      undefined,
      props.money,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.attemptCount,
      state.nextRetryAt,
      state.observedBalance,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get attemptCount(): number {
    return this._attemptCount;
  }

  get nextRetryAt(): Date | undefined {
    return this._nextRetryAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, balance: Money): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._failureCode = undefined;
    this._nextRetryAt = undefined;
    this._observedBalance = balance;
  }

  markPendingReference(now: Date, backoffMs: number): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
    this._attemptCount += 1;
    this._nextRetryAt = new Date(now.getTime() + backoffMs);
  }

  reject(code: FailureCode, at: Date, balance?: Money): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._nextRetryAt = undefined;
    this._observedBalance = balance;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextRetryAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  allowedReferenceKinds(): ReadonlySet<WagerTransactionKind> {
    if (this.kind === WagerTransactionKind.Refund) {
      return new Set([WagerTransactionKind.Bet]);
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      return new Set([
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ]);
    }
    return new Set();
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError("LOSS does not produce a ledger direction");
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(
            "ROLLBACK requires the referenced transaction to compute ledger direction",
          );
        }
        return invertLedgerDirection(reference.ledgerDirectionFor());
      }
      default: {
        const exhaustive: never = this.kind;
        throw new InvalidTransactionStateError(`Unknown kind ${exhaustive}`);
      }
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot transition transaction ${this.id} from terminal status ${this._status}`,
      );
    }
  }
}
