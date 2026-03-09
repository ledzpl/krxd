import { describe, expect, it } from "vitest";

import {
  calculateBollingerBands,
  calculateCorrelation,
  calculateEMA,
  calculateMA,
  calculateMACD,
  calculateRSI,
} from "./technical-indicators";

describe("calculateMA", () => {
  it("returns nulls for indices before the period", () => {
    const result = calculateMA([1, 2, 3, 4, 5], 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeCloseTo(2);
  });

  it("calculates simple moving average correctly", () => {
    const result = calculateMA([10, 20, 30, 40, 50], 3);
    expect(result[2]).toBeCloseTo(20);
    expect(result[3]).toBeCloseTo(30);
    expect(result[4]).toBeCloseTo(40);
  });

  it("handles single element period", () => {
    const result = calculateMA([5, 10, 15], 1);
    expect(result).toEqual([5, 10, 15]);
  });

  it("handles all same values", () => {
    const result = calculateMA([100, 100, 100, 100], 3);
    expect(result[2]).toBeCloseTo(100);
    expect(result[3]).toBeCloseTo(100);
  });
});

describe("calculateRSI", () => {
  it("returns all nulls when not enough data", () => {
    const result = calculateRSI([1, 2, 3], 14);
    expect(result.every((v) => v === null)).toBe(true);
  });

  it("returns 100 when price only goes up", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = calculateRSI(prices, 14);
    const lastRSI = result.filter((v): v is number => v !== null).pop();
    expect(lastRSI).toBe(100);
  });

  it("returns value near 0 when price only goes down", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 200 - i);
    const result = calculateRSI(prices, 14);
    const lastRSI = result.filter((v): v is number => v !== null).pop();
    expect(lastRSI).toBeLessThan(1);
  });

  it("returns value between 0 and 100 for mixed data", () => {
    const prices = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
    const result = calculateRSI(prices, 14);
    const values = result.filter((v): v is number => v !== null);
    values.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    });
  });
});

describe("calculateEMA", () => {
  it("first value equals the first price", () => {
    const result = calculateEMA([10, 20, 30], 3);
    expect(result[0]).toBe(10);
  });

  it("converges towards recent prices", () => {
    const result = calculateEMA([10, 10, 10, 50, 50, 50], 3);
    expect(result[5]).toBeGreaterThan(result[2]);
  });
});

describe("calculateMACD", () => {
  it("returns null with insufficient data", () => {
    const result = calculateMACD([1, 2, 3]);
    expect(result).toBeNull();
  });

  it("returns valid structure with enough data", () => {
    const prices = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 10);
    const result = calculateMACD(prices);
    expect(result).not.toBeNull();
    expect(result!.macdLine.length).toBeGreaterThan(0);
    expect(result!.signalLine.length).toBeGreaterThan(0);
    expect(result!.histogram.length).toBe(result!.signalLine.length);
  });

  it("histogram equals macd minus signal", () => {
    const prices = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 5);
    const result = calculateMACD(prices)!;
    result.histogram.forEach((h, i) => {
      expect(h).toBeCloseTo(result.macdLine[i] - result.signalLine[i], 10);
    });
  });
});

describe("calculateBollingerBands", () => {
  it("returns nulls before period", () => {
    const prices = Array.from({ length: 25 }, (_, i) => 100 + i);
    const { upper, lower } = calculateBollingerBands(prices, 20);
    for (let i = 0; i < 19; i++) {
      expect(upper[i]).toBeNull();
      expect(lower[i]).toBeNull();
    }
    expect(upper[19]).not.toBeNull();
    expect(lower[19]).not.toBeNull();
  });

  it("upper is above lower", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.random() * 10);
    const { upper, lower } = calculateBollingerBands(prices, 20);
    for (let i = 19; i < prices.length; i++) {
      expect(upper[i]!).toBeGreaterThan(lower[i]!);
    }
  });

  it("bands collapse when prices are constant", () => {
    const prices = Array.from({ length: 25 }, () => 50);
    const { upper, lower } = calculateBollingerBands(prices, 20);
    expect(upper[24]).toBeCloseTo(50);
    expect(lower[24]).toBeCloseTo(50);
  });
});

describe("calculateCorrelation", () => {
  it("returns null for insufficient data", () => {
    expect(calculateCorrelation([1, 2], [3, 4])).toBeNull();
  });

  it("returns 1 for perfectly correlated series", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [10, 20, 30, 40, 50];
    expect(calculateCorrelation(a, b)).toBe(1);
  });

  it("returns -1 for perfectly inversely correlated series", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [50, 40, 30, 20, 10];
    expect(calculateCorrelation(a, b)).toBe(-1);
  });

  it("returns near 0 for uncorrelated series", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const b = [5, 2, 8, 1, 7, 3, 6, 4];
    const corr = calculateCorrelation(a, b)!;
    expect(Math.abs(corr)).toBeLessThan(0.5);
  });

  it("returns value between -1 and 1", () => {
    const a = [10, 25, 15, 30, 20, 35, 25];
    const b = [5, 12, 8, 18, 11, 22, 14];
    const corr = calculateCorrelation(a, b)!;
    expect(corr).toBeGreaterThanOrEqual(-1);
    expect(corr).toBeLessThanOrEqual(1);
  });
});
