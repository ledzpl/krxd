import { z } from "zod";

import {
  sourceCategorySchema,
  sourceDiagnosticSchema,
  sourceStatusSchema,
  type SourceCategory,
  type SourceDiagnostic,
  type SourceStatus,
} from "./normalized-schemas";

const freshnessUnitSchema = z.enum(["minutes", "hours", "days", "quarters"]);

export const runtimeExclusionReasonSchema = z.enum([
  "not-public",
  "login-required",
  "robots-review-pending",
  "terms-review-pending",
  "category-disabled",
]);

export const sourceRegistryEntrySchema = z.object({
  id: z.string().trim().min(1, "id is required"),
  name: z.string().trim().min(1, "name is required"),
  category: sourceCategorySchema,
  publicAccessible: z.boolean(),
  robotsReviewed: z.boolean(),
  loginRequired: z.boolean(),
  termsReviewed: z.boolean(),
  freshnessExpectation: z.object({
    value: z.number().int().positive("freshnessExpectation.value must be positive"),
    unit: freshnessUnitSchema,
    description: z.string().trim().min(1, "freshnessExpectation.description is required"),
  }),
  rateLimitNotes: z.string().trim().min(1, "rateLimitNotes is required"),
});

const sourceRegistrySchema = z.array(sourceRegistryEntrySchema).superRefine((sources, ctx) => {
  const ids = new Set<string>();

  sources.forEach((source, index) => {
    if (ids.has(source.id)) {
      ctx.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `Duplicate source id "${source.id}" is not allowed`,
      });
      return;
    }

    ids.add(source.id);
  });
});

export type RuntimeExclusionReason = z.infer<typeof runtimeExclusionReasonSchema>;
export type SourceRegistryEntry = z.infer<typeof sourceRegistryEntrySchema>;

type SourceRuntimeEvaluation = {
  source: SourceRegistryEntry;
  runtimeEligible: boolean;
  exclusionReasons: RuntimeExclusionReason[];
};

const runtimeExclusionMessages: Record<RuntimeExclusionReason, string> = {
  "not-public": "Source is not publicly accessible and is excluded from runtime aggregation.",
  "login-required":
    "Source requires login and is excluded from runtime aggregation.",
  "robots-review-pending":
    "Source has not passed robots.txt review and is excluded from runtime aggregation.",
  "terms-review-pending":
    "Source has not passed terms-of-service review and is excluded from runtime aggregation.",
  "category-disabled": "Source category is disabled by configuration.",
};

export const sourceRegistry = sourceRegistrySchema.parse([
  {
    id: "krx-stock-code-resolver",
    name: "KRX listed issue resolver",
    category: "quote",
    publicAccessible: true,
    robotsReviewed: true,
    loginRequired: false,
    termsReviewed: true,
    freshnessExpectation: {
      value: 1,
      unit: "days",
      description: "Listed issue metadata changes infrequently but should be refreshed regularly.",
    },
    rateLimitNotes: "Cache lookup results per stock code and avoid repeated autocomplete-style bursts.",
  },
  {
    id: "naver-domestic-market-data",
    name: "Naver domestic market data",
    category: "quote",
    publicAccessible: true,
    robotsReviewed: true,
    loginRequired: false,
    termsReviewed: true,
    freshnessExpectation: {
      value: 15,
      unit: "minutes",
      description: "Refresh near real time during market hours and reuse short-lived quote snapshots.",
    },
    rateLimitNotes: "Keep a short cache, request one stock at a time, and avoid tight polling loops.",
  },
  {
    id: "public-news-search",
    name: "Public market news search",
    category: "news",
    publicAccessible: true,
    robotsReviewed: true,
    loginRequired: false,
    termsReviewed: true,
    freshnessExpectation: {
      value: 6,
      unit: "hours",
      description: "Refresh several times during the trading day.",
    },
    rateLimitNotes: "Deduplicate mirrored articles and back off after pagination.",
  },
  {
    id: "krx-kind-disclosures",
    name: "KRX KIND disclosure board",
    category: "disclosure",
    publicAccessible: true,
    robotsReviewed: true,
    loginRequired: false,
    termsReviewed: true,
    freshnessExpectation: {
      value: 24,
      unit: "hours",
      description: "Capture new filings within the same trading day.",
    },
    rateLimitNotes: "Cache filing detail pages per receipt number and avoid tight loops.",
  },
  {
    id: "public-financial-statements",
    name: "Public financial statement summary",
    category: "financial",
    publicAccessible: true,
    robotsReviewed: true,
    loginRequired: false,
    termsReviewed: true,
    freshnessExpectation: {
      value: 1,
      unit: "quarters",
      description: "Refresh when a new quarterly filing is published.",
    },
    rateLimitNotes: "Reuse quarterly snapshots instead of refetching on every request.",
  },
  {
    id: "public-community-board",
    name: "Public investor message board",
    category: "community",
    publicAccessible: true,
    robotsReviewed: false,
    loginRequired: false,
    termsReviewed: false,
    freshnessExpectation: {
      value: 12,
      unit: "hours",
      description: "Community reaction loses value quickly for short horizons.",
    },
    rateLimitNotes: "Keep this source out of runtime aggregation until reviews are complete.",
  },
  {
    id: "members-community-feed",
    name: "Members-only community feed",
    category: "community",
    publicAccessible: false,
    robotsReviewed: false,
    loginRequired: true,
    termsReviewed: false,
    freshnessExpectation: {
      value: 12,
      unit: "hours",
      description: "Would be short lived if ever approved for aggregation.",
    },
    rateLimitNotes: "Never aggregate while the source depends on account authentication.",
  },
]);

function formatFreshnessNote(source: SourceRegistryEntry) {
  const { value, unit, description } = source.freshnessExpectation;
  return `Freshness expectation: ${value} ${unit} (${description})`;
}

export function evaluateSourceForRuntime(
  source: SourceRegistryEntry,
  options?: {
    enabledCategories?: SourceCategory[];
  },
): SourceRuntimeEvaluation {
  const exclusionReasons: RuntimeExclusionReason[] = [];

  if (!source.publicAccessible) {
    exclusionReasons.push("not-public");
  }

  if (source.loginRequired) {
    exclusionReasons.push("login-required");
  }

  if (!source.robotsReviewed) {
    exclusionReasons.push("robots-review-pending");
  }

  if (!source.termsReviewed) {
    exclusionReasons.push("terms-review-pending");
  }

  if (
    options?.enabledCategories &&
    !options.enabledCategories.includes(source.category)
  ) {
    exclusionReasons.push("category-disabled");
  }

  return {
    source,
    runtimeEligible: exclusionReasons.length === 0,
    exclusionReasons,
  };
}

function buildExclusionDiagnostics(
  evaluation: SourceRuntimeEvaluation,
): SourceDiagnostic[] {
  return evaluation.exclusionReasons.map((reason) =>
    sourceDiagnosticSchema.parse({
      sourceId: evaluation.source.id,
      severity: "warning",
      code: reason,
      message: runtimeExclusionMessages[reason],
    }),
  );
}

export function buildSourceDiagnostics(options?: {
  enabledCategories?: SourceCategory[];
}): SourceStatus[] {
  return sourceRegistry.map((source) => {
    const evaluation = evaluateSourceForRuntime(source, options);

    return sourceStatusSchema.parse({
      sourceId: source.id,
      category: source.category,
      status: evaluation.runtimeEligible ? "ready" : "excluded",
      runtimeEligible: evaluation.runtimeEligible,
      notes: [formatFreshnessNote(source), source.rateLimitNotes],
      diagnostics: buildExclusionDiagnostics(evaluation),
    });
  });
}

export function getRuntimeAggregationSources(options?: {
  enabledCategories?: SourceCategory[];
}): SourceRegistryEntry[] {
  return sourceRegistry.filter(
    (source) => evaluateSourceForRuntime(source, options).runtimeEligible,
  );
}
