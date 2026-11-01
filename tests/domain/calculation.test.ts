import { describe, expect, it } from "vitest";
import { calculate } from "../../src/domain/calculation";
import { convertBasis } from "../../src/domain/units";
import type { Basis, ConfirmedInput, Food } from "../../src/contracts/types";

const source = { kind: "user" as const, label: "Manual" };
const food: Food = { name: "Food", source, packageBasis: { amount: 200, unit: "g" }, servingSize: { amount: 50, unit: "g" }, servingsPerPackage: 4 };
const input: ConfirmedInput = { food, nutrition: { proteinG: 10, energyKcal: 100, basis: { amount: 100, unit: "g" }, source }, price: { amount: 4, currency: "USD", basis: { amount: 1, unit: "package" }, source: "user" } };
const b = (amount: number, unit: Basis["unit"], count?: number): Basis => ({ amount, unit, ...(count === undefined ? {} : { count }) });

describe("nutrition calculations", () => {
  it("calculates both metrics for the approved example", () => {
    expect(calculate(input)).toEqual({ proteinPerCurrency: { value: 5, unit: "g/USD" }, proteinPer100Kcal: { value: 10, unit: "g/100 kcal" } });
  });
  it("keeps independent metrics available, including supported zero protein", () => {
    expect(calculate({ ...input, food: { ...food, packageBasis: null, servingsPerPackage: null } }).proteinPerCurrency).toHaveProperty("unavailable");
    expect(calculate({ ...input, food: { ...food, packageBasis: null, servingsPerPackage: null } }).proteinPer100Kcal).toEqual({ value: 10, unit: "g/100 kcal" });
    expect(calculate({ ...input, nutrition: { ...input.nutrition!, proteinG: 0 } })).toEqual({ proteinPerCurrency: { value: 0, unit: "g/USD" }, proteinPer100Kcal: { value: 0, unit: "g/100 kcal" } });
    expect(calculate({ ...input, nutrition: { ...input.nutrition!, energyKcal: 0 } }).proteinPer100Kcal).toHaveProperty("unavailable");
    expect(calculate({ ...input, price: null }).proteinPerCurrency).toHaveProperty("unavailable");
  });
  it.each([0, -1, NaN, Infinity])("does not calculate with invalid price %s", (amount) => {
    expect(calculate({ ...input, price: { ...input.price!, amount } }).proteinPerCurrency).toHaveProperty("unavailable");
  });
  it.each([-1, NaN, Infinity])("does not calculate with invalid protein %s", (proteinG) => {
    const result = calculate({ ...input, nutrition: { ...input.nutrition!, proteinG } });
    expect(result.proteinPerCurrency).toHaveProperty("unavailable");
    expect(result.proteinPer100Kcal).toHaveProperty("unavailable");
  });
  it("computes a matching per-kg price but never assumes density", () => {
    expect(calculate({ ...input, price: { ...input.price!, amount: 20, basis: b(1, "kg") } }).proteinPerCurrency).toEqual({ value: 5, unit: "g/USD" });
    expect(calculate({ ...input, price: { ...input.price!, basis: b(1, "l") } }).proteinPerCurrency).toHaveProperty("unavailable");
  });
});

describe("basis conversion", () => {
  it("scales values between weight and volume units only within their dimension", () => {
    expect(convertBasis(10, b(100, "g"), b(1, "kg"), food)).toBe(100);
    expect(convertBasis(10, b(100, "ml"), b(1, "l"), food)).toBe(100);
    expect(convertBasis(10, b(100, "g"), b(1, "l"), food)).toBeNull();
    expect(convertBasis(10, b(100, "g"), b(200, "g"), food)).toBe(20);
  });
  it("uses known serving/package mappings and rejects missing or conflicting mappings", () => {
    expect(convertBasis(10, b(1, "serving"), b(1, "package"), food)).toBe(40);
    expect(convertBasis(10, b(100, "g"), b(1, "package"), food)).toBe(20);
    expect(convertBasis(10, b(1, "serving"), b(1, "package"), { ...food, packageBasis: null, servingsPerPackage: null })).toBeNull();
    expect(convertBasis(10, b(100, "g"), b(1, "package"), { ...food, servingsPerPackage: 3 })).toBeNull();
    expect(convertBasis(10, b(1, "serving"), b(2, "serving"), food)).toBe(20);
  });
  it("does not multiply total physical multipack quantity by the count again", () => {
    const pack = { ...food, packageBasis: b(600, "g", 6), servingSize: null, servingsPerPackage: null };
    expect(convertBasis(10, b(100, "g"), b(1, "package", 6), pack)).toBe(60);
    expect(convertBasis(10, b(100, "g"), b(1, "package", 3), pack)).toBeNull();
    expect(convertBasis(10, b(1, "package", 3), b(1, "package", 6), pack)).toBeNull();
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid quantities %s", (amount) => {
    expect(convertBasis(10, b(amount, "g"), b(100, "g"), food)).toBeNull();
  });
  it("rejects overflow rather than reporting a fabricated zero", () => {
    expect(convertBasis(10, b(1e308, "kg"), b(100, "g"), food)).toBeNull();
  });
});
