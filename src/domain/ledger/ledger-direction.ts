export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export function invertLedgerDirection(
  direction: LedgerDirection,
): LedgerDirection {
  return direction === LedgerDirection.Debit
    ? LedgerDirection.Credit
    : LedgerDirection.Debit;
}
