import Decimal from "decimal.js";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../errors/domain-error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const CURRENCY_RE = /^[A-Z]{3}$/;
const AMOUNT_RE = /^-?(0|[1-9]\d*)\.\d{2}$/;

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = Money.assertCurrency(props.currency);
    const amount = Money.assertAmountString(props.amount);
    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  static rehydrate(props: MoneyProps): Money {
    return Money.from(props);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: string): string {
    if (!CURRENCY_RE.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid ISO-4217 currency code: ${JSON.stringify(currency)}`,
      );
    }
    return currency;
  }

  private static assertAmountString(amount: string): string {
    if (typeof amount !== "string" || amount.length === 0) {
      throw new InvalidMoneyError("Amount must be a non-empty decimal string");
    }
    if (/[eE]/.test(amount) || amount.includes("+")) {
      throw new InvalidMoneyError("Scientific notation is not allowed for money");
    }
    if (!AMOUNT_RE.test(amount)) {
      throw new InvalidMoneyError(
        `Amount must have exactly ${SCALE} decimal places (received ${JSON.stringify(amount)})`,
      );
    }
    const decimal = new Decimal(amount);
    if (!decimal.isFinite()) {
      throw new InvalidMoneyError("Amount must be a finite decimal");
    }
    if (decimal.decimalPlaces() > SCALE) {
      throw new InvalidMoneyError(`Amount scale must be exactly ${SCALE}`);
    }
    return amount;
  }
}
