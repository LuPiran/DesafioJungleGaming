import {
  InsufficientFundsError,
  InvalidMoneyError,
  ReversalWouldOverdrawError,
  WalletInvariantError,
  CurrencyMismatchError,
} from "../errors/domain-error";
import {
  LedgerDirection,
  invertLedgerDirection,
} from "../ledger/ledger-direction";
import { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import { WagerTransaction } from "../wager-transaction/wager-transaction";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    createdAt: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("Initial wallet balance cannot be negative");
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.createdAt,
      props.createdAt,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  openingEntry(transaction: WagerTransaction, entryId: string, at: Date): WalletLedgerEntry {
    if (transaction.kind !== "OPENING") {
      throw new WalletInvariantError("Opening ledger requires an OPENING transaction");
    }
    this.assertSameCurrency(transaction.money);
    if (!transaction.money.equals(this._balance)) {
      throw new WalletInvariantError("Opening entry must match the wallet initial balance");
    }
    return WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: transaction.money,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: at,
    });
  }

  apply(
    transaction: WagerTransaction,
    entryId: string,
    at: Date,
    reference?: WagerTransaction,
  ): WalletLedgerEntry | undefined {
    this.assertSameCurrency(transaction.money);
    if (transaction.walletId !== this.id) {
      throw new WalletInvariantError("Transaction walletId does not match this wallet");
    }
    if (!transaction.affectsBalance()) {
      return undefined;
    }

    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit) {
      return this.debit(transaction, entryId, at);
    }
    return this.credit(transaction, entryId, at);
  }

  debit(
    transaction: WagerTransaction,
    entryId: string,
    at: Date,
  ): WalletLedgerEntry {
    if (this._balance.isLessThan(transaction.money)) {
      if (transaction.kind === "ROLLBACK" || transaction.kind === "REFUND") {
        throw new ReversalWouldOverdrawError();
      }
      throw new InsufficientFundsError();
    }
    const before = this._balance;
    this._balance = this._balance.subtract(transaction.money);
    this.touch(at);
    return WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Debit,
      money: transaction.money,
      balanceBefore: before,
      balanceAfter: this._balance,
      createdAt: at,
    });
  }

  credit(
    transaction: WagerTransaction,
    entryId: string,
    at: Date,
  ): WalletLedgerEntry {
    const before = this._balance;
    this._balance = this._balance.add(transaction.money);
    this.touch(at);
    return WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: transaction.money,
      balanceBefore: before,
      balanceAfter: this._balance,
      createdAt: at,
    });
  }

  expectedDirectionFor(
    transaction: WagerTransaction,
    reference?: WagerTransaction,
  ): LedgerDirection | undefined {
    if (!transaction.affectsBalance()) {
      return undefined;
    }
    return transaction.ledgerDirectionFor(reference);
  }

  invertDirection(direction: LedgerDirection): LedgerDirection {
    return invertLedgerDirection(direction);
  }

  private touch(at: Date): void {
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
