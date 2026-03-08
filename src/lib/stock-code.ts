const surroundingQuotePattern =
  /^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g;

export function normalizeStockCodeInput(value: string): string;
export function normalizeStockCodeInput(value: unknown): unknown;
export function normalizeStockCodeInput(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  return value.normalize("NFKC").replace(surroundingQuotePattern, "").trim();
}

export function sanitizeStockCodeDigits(value: string) {
  return normalizeStockCodeInput(value).replace(/\D/g, "").slice(0, 6);
}
