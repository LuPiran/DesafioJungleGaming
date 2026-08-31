export class ApplicationError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends ApplicationError {
  constructor(code: string, message: string) {
    super(404, code, message);
  }
}

export class ConflictError extends ApplicationError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }

  static idempotency(): ConflictError {
    return new ConflictError(
      "IDEMPOTENCY_PAYLOAD_CONFLICT",
      "Idempotency key already used with a different payload",
    );
  }

  static duplicateWallet(): ConflictError {
    return new ConflictError(
      "DUPLICATE_WALLET",
      "A wallet already exists for this playerId and currency",
    );
  }
}

export class BusinessRejectionError extends ApplicationError {
  constructor(
    code: string,
    message: string,
    public readonly transactionId?: string,
    public readonly status?: string,
    public readonly balance?: { amount: string; currency: string },
  ) {
    super(422, code, message);
  }
}

export class AcceptedPendingError extends ApplicationError {
  constructor(
    public readonly transactionId: string,
    public readonly status: string,
    public readonly balance: { amount: string; currency: string },
  ) {
    super(202, "PENDING_REFERENCE", "Transaction is waiting for its referenced operation");
  }
}

export class TransientInfrastructureError extends ApplicationError {
  constructor(message: string) {
    super(503, "TRANSIENT_INFRASTRUCTURE", message, true);
  }
}
