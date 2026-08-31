import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../../src/domain/errors/domain-error";

describe("Money", () => {
  test("parses a two-decimal string and serializes with fixed scale", () => {
    const money = Money.from({ amount: "25.00", currency: "BRL" });
    expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(money.toString()).toBe("25.00");
    expect(money.isPositive()).toBe(true);
  });

  test("zero factory", () => {
    const zero = Money.zero("BRL");
    expect(zero.isZero()).toBe(true);
    expect(zero.toString()).toBe("0.00");
  });

  test("adds and subtracts immutably", () => {
    const a = Money.from({ amount: "10.50", currency: "BRL" });
    const b = Money.from({ amount: "1.25", currency: "BRL" });
    expect(a.add(b).toString()).toBe("11.75");
    expect(a.subtract(b).toString()).toBe("9.25");
    expect(a.toString()).toBe("10.50");
  });

  test("rejects currency mismatch", () => {
    const brl = Money.from({ amount: "1.00", currency: "BRL" });
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  test("rejects invalid inputs", () => {
    expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "1e2", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "1.2", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "1.234", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "01.00", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "NaN", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "Infinity", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "10.00", currency: "brl" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "10.00", currency: "REAL" })).toThrow(InvalidMoneyError);
  });

  test("negate produces a negative value without mutating", () => {
    const money = Money.from({ amount: "5.00", currency: "BRL" });
    expect(money.negate().isNegative()).toBe(true);
    expect(money.negate().toString()).toBe("-5.00");
    expect(money.isPositive()).toBe(true);
  });

  test("equals compares amount and currency", () => {
    const a = Money.from({ amount: "2.00", currency: "BRL" });
    const b = Money.from({ amount: "2.00", currency: "BRL" });
    expect(a.equals(b)).toBe(true);
  });
});
