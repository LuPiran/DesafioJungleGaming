export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super("INVALID_MONEY", message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super(
      "CURRENCY_MISMATCH",
      `Currency mismatch: expected ${left}, received ${right}`,
    );
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super("INSUFFICIENT_FUNDS", "Wallet balance is insufficient for this debit");
  }
}

export class ReversalWouldOverdrawError extends DomainError {
  constructor() {
    super(
      "REVERSAL_WOULD_OVERDRAW",
      "Reversal would result in a negative wallet balance",
    );
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(message: string, code = "INVALID_KIND") {
    super(code, message);
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super(
      "IDEMPOTENCY_PAYLOAD_CONFLICT",
      "Idempotency key already used with a different payload",
    );
  }
}

export class WalletInvariantError extends DomainError {
  constructor(message: string) {
    super("WALLET_INVARIANT", message);
  }
}
