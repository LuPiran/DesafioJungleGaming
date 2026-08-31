export class UniqueConstraintError extends Error {
  constructor(public readonly constraint?: string) {
    super(`Unique constraint violated${constraint ? `: ${constraint}` : ""}`);
    this.name = "UniqueConstraintError";
  }
}
