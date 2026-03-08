import { z } from "zod";

import { normalizeStockCodeInput } from "./stock-code";

const nonEmptyStringSchema = z.string().trim().min(1, "Value is required");
const finiteNumberSchema = z.number().finite("Value must be a finite number");
const nonNegativeNumberSchema = finiteNumberSchema.min(
  0,
  "Value must be greater than or equal to 0",
);
const nonNegativeIntegerSchema = z
  .number()
  .int("Value must be an integer")
  .min(0, "Value must be greater than or equal to 0");

export const isoTimestampSchema = z
  .string()
  .trim()
  .min(1, "Timestamp is required")
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Timestamp must be a valid ISO 8601 string",
  );

export const absoluteUrlSchema = z
  .string()
  .trim()
  .min(1, "URL is required")
  .url("URL must be a valid absolute URL")
  .refine((value) => /^https?:\/\//.test(value), "URL must use http or https");

export const sourceIdSchema = nonEmptyStringSchema;

export const sourceCategorySchema = z.enum([
  "quote",
  "news",
  "community",
  "disclosure",
  "financial",
]);

export const sentimentSchema = z.enum([
  "positive",
  "neutral",
  "negative",
  "mixed",
  "unknown",
]);

export const importanceSchema = z.enum(["low", "medium", "high"]);
export const directionSchema = z.enum(["up", "flat", "down"]);
export const confidenceSchema = z.enum(["low", "medium", "high"]);
export const horizonSchema = z.enum(["1d", "1w", "1m"]);

const stockCodeSchema = z.preprocess(
  normalizeStockCodeInput,
  z
    .string()
    .trim()
    .regex(/^\d{6}$/, "stockCode must be a 6-digit Korean stock code"),
);

export const structuredValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
});

export const structuredValidationErrorSchema = z.object({
  entity: nonEmptyStringSchema,
  sourceId: sourceIdSchema.optional(),
  summary: nonEmptyStringSchema,
  issues: z.array(structuredValidationIssueSchema).min(1),
});

export const sourceDiagnosticSchema = z.object({
  sourceId: sourceIdSchema.optional(),
  severity: z.enum(["info", "warning", "error"]),
  code: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  entity: nonEmptyStringSchema.optional(),
  validationErrors: z.array(structuredValidationIssueSchema).default([]),
});

export const sourceStatusSchema = z.object({
  sourceId: sourceIdSchema,
  category: sourceCategorySchema,
  status: z.enum(["ready", "excluded", "failed", "stale"]),
  runtimeEligible: z.boolean(),
  notes: z.array(nonEmptyStringSchema).default([]),
  diagnostics: z.array(sourceDiagnosticSchema).default([]),
});

const quoteTrendPointSchema = z.object({
  at: isoTimestampSchema,
  price: nonNegativeNumberSchema,
});

const engagementSchema = z
  .object({
    comments: nonNegativeIntegerSchema.optional(),
    likes: nonNegativeIntegerSchema.optional(),
    views: nonNegativeIntegerSchema.optional(),
  })
  .default({});

const financialMetricSchema = finiteNumberSchema.nullable();

export const stockQuerySchema = z.object({
  stockCode: stockCodeSchema,
  companyName: nonEmptyStringSchema.optional(),
  market: nonEmptyStringSchema.optional(),
  requestedAt: isoTimestampSchema,
});

export const quoteSnapshotSchema = z.object({
  source: sourceIdSchema,
  currentPrice: nonNegativeNumberSchema,
  changeAmount: finiteNumberSchema,
  changePercent: finiteNumberSchema,
  volume: nonNegativeIntegerSchema,
  trendPoints: z.array(quoteTrendPointSchema),
  capturedAt: isoTimestampSchema,
});

export const sourceCaptureSchema = z.object({
  source: sourceIdSchema,
  capturedAt: isoTimestampSchema,
});

export const quoteLookupResultSchema = z.object({
  stockCode: stockCodeSchema,
  companyName: nonEmptyStringSchema,
  market: nonEmptyStringSchema,
  resolution: sourceCaptureSchema,
  quote: quoteSnapshotSchema,
});

export const newsItemSchema = z.object({
  id: nonEmptyStringSchema,
  source: sourceIdSchema,
  title: nonEmptyStringSchema,
  summary: nonEmptyStringSchema,
  publisher: nonEmptyStringSchema,
  publishedAt: isoTimestampSchema,
  url: absoluteUrlSchema,
  sentiment: sentimentSchema,
});

export const newsLookupResultSchema = z.object({
  stockCode: stockCodeSchema,
  companyName: nonEmptyStringSchema,
  source: sourceCaptureSchema,
  news: z.array(newsItemSchema),
  diagnostics: z.array(sourceDiagnosticSchema).default([]),
});

export const communityPostSchema = z.object({
  id: nonEmptyStringSchema,
  source: sourceIdSchema,
  title: nonEmptyStringSchema,
  excerpt: nonEmptyStringSchema,
  publishedAt: isoTimestampSchema,
  url: absoluteUrlSchema,
  engagement: engagementSchema,
  sentiment: sentimentSchema,
});

export const themeSummaryItemSchema = z.object({
  label: nonEmptyStringSchema,
  mentions: nonNegativeIntegerSchema,
});

export const communitySummarySchema = z
  .object({
    totalPosts: nonNegativeIntegerSchema,
    bullishCount: nonNegativeIntegerSchema,
    bearishCount: nonNegativeIntegerSchema,
    neutralCount: nonNegativeIntegerSchema,
    topThemes: z.array(themeSummaryItemSchema).max(5).default([]),
  })
  .superRefine((summary, ctx) => {
    if (
      summary.bullishCount + summary.bearishCount + summary.neutralCount !==
      summary.totalPosts
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["totalPosts"],
        message:
          "communitySummary counts must add up to the totalPosts value",
      });
    }
  });

export const communityLookupResultSchema = z.object({
  stockCode: stockCodeSchema,
  companyName: nonEmptyStringSchema,
  source: sourceCaptureSchema,
  community: z.array(communityPostSchema),
  summary: communitySummarySchema,
  diagnostics: z.array(sourceDiagnosticSchema).default([]),
  sourceStatus: z.array(sourceStatusSchema).default([]),
});

export const disclosureItemSchema = z.object({
  id: nonEmptyStringSchema,
  source: sourceIdSchema,
  category: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  publishedAt: isoTimestampSchema,
  url: absoluteUrlSchema,
  importance: importanceSchema,
});

export const disclosureLookupResultSchema = z.object({
  stockCode: stockCodeSchema,
  companyName: nonEmptyStringSchema,
  source: sourceCaptureSchema,
  disclosures: z.array(disclosureItemSchema),
  diagnostics: z.array(sourceDiagnosticSchema).default([]),
  sourceStatus: z.array(sourceStatusSchema).default([]),
});

export const financialSnapshotSchema = z.object({
  source: sourceIdSchema,
  fiscalPeriod: nonEmptyStringSchema,
  revenue: financialMetricSchema,
  operatingProfit: financialMetricSchema,
  netIncome: financialMetricSchema,
  eps: financialMetricSchema,
  bps: financialMetricSchema,
  per: financialMetricSchema,
  pbr: financialMetricSchema,
  capturedAt: isoTimestampSchema,
});

export const financialLookupResultSchema = z.object({
  stockCode: stockCodeSchema,
  companyName: nonEmptyStringSchema,
  source: sourceCaptureSchema,
  financials: z.array(financialSnapshotSchema),
  diagnostics: z.array(sourceDiagnosticSchema).default([]),
  sourceStatus: z.array(sourceStatusSchema).default([]),
});

export const horizonSignalSchema = z.object({
  horizon: horizonSchema,
  direction: directionSchema,
  score: finiteNumberSchema.min(-1, "score must be at least -1").max(
    1,
    "score must be at most 1",
  ),
  confidence: confidenceSchema,
  reasons: z.array(nonEmptyStringSchema).min(1, "At least one reason is required"),
});

const horizonSignalListSchema = z.array(horizonSignalSchema).superRefine((signals, ctx) => {
  const seen = new Set<string>();

  signals.forEach((signal, index) => {
    if (seen.has(signal.horizon)) {
      ctx.addIssue({
        code: "custom",
        path: [index, "horizon"],
        message: `Duplicate horizon "${signal.horizon}" is not allowed`,
      });
      return;
    }

    seen.add(signal.horizon);
  });
});

export const dashboardResultSchema = z.object({
  stockCode: stockCodeSchema,
  companyName: nonEmptyStringSchema,
  market: nonEmptyStringSchema,
  analyzedAt: isoTimestampSchema,
  quote: quoteSnapshotSchema.nullable(),
  news: z.array(newsItemSchema),
  community: z.array(communityPostSchema),
  disclosures: z.array(disclosureItemSchema),
  financials: z.array(financialSnapshotSchema),
  signals: horizonSignalListSchema,
  sourceStatus: z.array(sourceStatusSchema),
  warnings: z.array(nonEmptyStringSchema).default([]),
});

export type SourceCategory = z.infer<typeof sourceCategorySchema>;
export type StructuredValidationIssue = z.infer<typeof structuredValidationIssueSchema>;
export type StructuredValidationError = z.infer<typeof structuredValidationErrorSchema>;
export type SourceDiagnostic = z.infer<typeof sourceDiagnosticSchema>;
export type SourceStatus = z.infer<typeof sourceStatusSchema>;
export type StockQuery = z.infer<typeof stockQuerySchema>;
export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;
export type SourceCapture = z.infer<typeof sourceCaptureSchema>;
export type QuoteLookupResult = z.infer<typeof quoteLookupResultSchema>;
export type NewsItem = z.infer<typeof newsItemSchema>;
export type NewsLookupResult = z.infer<typeof newsLookupResultSchema>;
export type CommunityPost = z.infer<typeof communityPostSchema>;
export type ThemeSummaryItem = z.infer<typeof themeSummaryItemSchema>;
export type CommunitySummary = z.infer<typeof communitySummarySchema>;
export type CommunityLookupResult = z.infer<typeof communityLookupResultSchema>;
export type DisclosureItem = z.infer<typeof disclosureItemSchema>;
export type DisclosureLookupResult = z.infer<typeof disclosureLookupResultSchema>;
export type FinancialSnapshot = z.infer<typeof financialSnapshotSchema>;
export type FinancialLookupResult = z.infer<typeof financialLookupResultSchema>;
export type HorizonSignal = z.infer<typeof horizonSignalSchema>;
export type DashboardResult = z.infer<typeof dashboardResultSchema>;

type ValidationContext = {
  entity: string;
  sourceId?: string;
};

export type ValidationResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: StructuredValidationError;
    };

function normalizeValidationIssues(
  issues: z.ZodIssue[],
): StructuredValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map((part) =>
      typeof part === "number" ? part : String(part),
    ),
    code: issue.code,
    message: issue.message,
  }));
}

export function createStructuredValidationError(
  context: ValidationContext,
  issues: StructuredValidationIssue[],
  summary = `${context.entity} validation failed`,
): StructuredValidationError {
  return structuredValidationErrorSchema.parse({
    entity: context.entity,
    sourceId: context.sourceId,
    summary,
    issues,
  });
}

export function buildStructuredValidationError(
  error: z.ZodError,
  context: ValidationContext,
): StructuredValidationError {
  return createStructuredValidationError(
    context,
    normalizeValidationIssues(error.issues),
  );
}

export function validateNormalizedEntity<T>(
  schema: z.ZodType<T>,
  input: unknown,
  context: ValidationContext,
): ValidationResult<T> {
  const result = schema.safeParse(input);

  if (!result.success) {
    return {
      success: false,
      error: buildStructuredValidationError(result.error, context),
    };
  }

  return {
    success: true,
    data: result.data,
  };
}

export function createValidationDiagnostic(
  error: StructuredValidationError,
): SourceDiagnostic {
  return sourceDiagnosticSchema.parse({
    sourceId: error.sourceId,
    severity: "error",
    code: "validation-error",
    message: error.summary,
    entity: error.entity,
    validationErrors: error.issues,
  });
}
