/**
 * Pure technical indicator calculations.
 * Extracted for testability — no DOM or React dependencies.
 */

export function calculateMA(prices: number[], period: number): (number | null)[] {
  return prices.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += prices[j];
    return sum / period;
  });
}

export function calculateRSI(prices: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = new Array(prices.length).fill(null);
  if (prices.length < period + 1) return rsi;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

export function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const k = 2 / (period + 1);
  ema[0] = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

export function calculateMACD(prices: number[]) {
  if (prices.length < 26) return null;
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calculateEMA(macdLine.slice(25), 9);
  const histogram = signalLine.map((v, i) => macdLine[i + 25] - v);
  return { macdLine: macdLine.slice(25), signalLine, histogram, offset: 25 };
}

export function calculateBollingerBands(prices: number[], period = 20, multiplier = 2) {
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += prices[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (prices[j] - mean) ** 2;
    const std = Math.sqrt(variance / period);
    upper.push(mean + multiplier * std);
    lower.push(mean - multiplier * std);
  }
  return { upper, lower };
}

export function calculateCorrelation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const sliceA = a.slice(-n);
  const sliceB = b.slice(-n);
  const meanA = sliceA.reduce((s, v) => s + v, 0) / n;
  const meanB = sliceB.reduce((s, v) => s + v, 0) / n;
  let cov = 0,
    varA = 0,
    varB = 0;
  for (let i = 0; i < n; i++) {
    const dA = sliceA[i] - meanA;
    const dB = sliceB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }
  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? null : Math.round((cov / denom) * 1000) / 1000;
}
