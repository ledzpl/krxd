import "server-only";

import { z } from "zod";

import { env } from "./env";
import { isLikelyRuntimeNetworkIssue } from "./fetch-failure";
import {
  buildStructuredValidationError,
  dashboardResultSchema,
  horizonSchema,
  sourceDiagnosticSchema,
  sourceStatusSchema,
  type DashboardResult,
  type DisclosureItem,
  type FinancialSnapshot,
  type HorizonSignal,
  type NewsItem,
  type QuoteSnapshot,
  type SourceCategory,
  type SourceDiagnostic,
  type SourceStatus,
  type StructuredValidationError,
} from "./normalized-schemas";
import { buildSourceDiagnostics } from "./source-registry";
import { STOCK_COMMUNITY_SOURCE_ID, resolvePublicCommunityReaction } from "./stock-community";
import {
  STOCK_DISCLOSURE_SOURCE_ID,
  resolveRecentDisclosures,
} from "./stock-disclosures";
import {
  STOCK_FINANCIAL_SOURCE_ID,
  resolveFinancialSummary,
} from "./stock-financials";
import { STOCK_NEWS_SOURCE_ID, resolveRecentNews } from "./stock-news";
import {
  STOCK_RESOLUTION_FALLBACK_SOURCE_ID,
  QuoteLookupValidationError,
  STOCK_QUOTE_SOURCE_ID,
  STOCK_RESOLUTION_SOURCE_ID,
  resolveQuoteSnapshot,
  resolveStockListing,
} from "./stock-quote";
import { normalizeStockCodeInput } from "./stock-code";

const DEFAULT_HORIZONS = ["1d", "1w", "1m"] as const;

const CATEGORY_WEIGHTS: Record<
  HorizonSignal["horizon"],
  Record<SourceCategory, number>
> = {
  "1d": {
    quote: 0.35,
    news: 0.25,
    community: 0.2,
    disclosure: 0.1,
    financial: 0.1,
  },
  "1w": {
    quote: 0.25,
    news: 0.25,
    community: 0.15,
    disclosure: 0.15,
    financial: 0.2,
  },
  "1m": {
    quote: 0.15,
    news: 0.2,
    community: 0.1,
    disclosure: 0.2,
    financial: 0.35,
  },
};

const SOURCE_LABELS: Record<string, string> = {
  [STOCK_RESOLUTION_SOURCE_ID]: "KRX listing resolver",
  [STOCK_RESOLUTION_FALLBACK_SOURCE_ID]: "Naver item page resolver",
  [STOCK_QUOTE_SOURCE_ID]: "Naver domestic market data",
  [STOCK_NEWS_SOURCE_ID]: "Public market news search",
  [STOCK_COMMUNITY_SOURCE_ID]: "Tistory public blog search",
  [STOCK_DISCLOSURE_SOURCE_ID]: "KIND disclosures",
  [STOCK_FINANCIAL_SOURCE_ID]: "Public financial statements",
};

const DISCLOSURE_SENTIMENT_RULES = [
  {
    score: 1,
    patterns: [
      /배당/,
      /자사주/,
      /자기주식/,
      /소각/,
      /주주환원/,
      /공급계약/,
      /단일판매/,
      /신규시설투자/,
      /수주/,
      /흑자/,
      /실적/,
    ],
  },
  {
    score: -1,
    patterns: [
      /적자/,
      /손실/,
      /감자/,
      /거래정지/,
      /상장폐지/,
      /투자주의/,
      /투자경고/,
      /투자위험/,
      /횡령/,
      /배임/,
      /소송/,
      /회생/,
      /파업/,
      /생산중단/,
      /하향/,
    ],
  },
];

const analyzeInputSchema = z
  .object({
    stockCode: z.preprocess(
      normalizeStockCodeInput,
      z
        .string()
        .trim()
        .regex(/^\d{6}$/, "stockCode must be a 6-digit Korean stock code"),
    ),
    horizons: z.array(horizonSchema).optional(),
  })
  .transform((input) => ({
    stockCode: input.stockCode,
    horizons: input.horizons?.length
      ? [...new Set(input.horizons)]
      : [...DEFAULT_HORIZONS],
  }));

type AnalyzeInput = z.output<typeof analyzeInputSchema>;

type CollectorOutcome<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: unknown;
      summary: string;
    };

type CategorySignalInput = {
  available: boolean;
  category: SourceCategory;
  fresh: boolean;
  reason: string;
  score: number;
};

type CachedAnalysisEntry = {
  expiresAt: number;
  result: DashboardResult;
};

type GlobalWithAnalysisCache = typeof globalThis & {
  __kstockDashboardAnalysisCache?: Map<string, CachedAnalysisEntry>;
};

const analysisCache =
  (globalThis as GlobalWithAnalysisCache).__kstockDashboardAnalysisCache ??
  ((globalThis as GlobalWithAnalysisCache).__kstockDashboardAnalysisCache =
    new Map<string, CachedAnalysisEntry>());

export class AnalyzeDashboardValidationError extends Error {
  readonly statusCode = 400;

  constructor(readonly validationError: StructuredValidationError) {
    super(validationError.summary);
    this.name = "AnalyzeDashboardValidationError";
  }
}

export class AnalyzeDashboardSourceError extends Error {
  readonly statusCode = 503;

  constructor(
    message: string,
    readonly details: {
      analyzedAt: string;
      sourceStatus: SourceStatus[];
      stockCode: string;
      warnings: string[];
    },
  ) {
    super(message);
    this.name = "AnalyzeDashboardSourceError";
  }
}

function buildAnalyzeValidationError(input: unknown) {
  const result = analyzeInputSchema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  throw new AnalyzeDashboardValidationError(
    buildStructuredValidationError(result.error, {
      entity: "stockQuery",
    }),
  );
}

function getEnabledCategories(): SourceCategory[] {
  const enabledCategories: SourceCategory[] = [];

  if (env.ENABLE_QUOTE_SOURCE) {
    enabledCategories.push("quote");
  }

  if (env.ENABLE_NEWS_SOURCE) {
    enabledCategories.push("news");
  }

  if (env.ENABLE_COMMUNITY_SOURCE) {
    enabledCategories.push("community");
  }

  if (env.ENABLE_DISCLOSURE_SOURCE) {
    enabledCategories.push("disclosure");
  }

  if (env.ENABLE_FINANCIAL_SOURCE) {
    enabledCategories.push("financial");
  }

  return enabledCategories;
}

function createDiagnostic(options: {
  code: string;
  message: string;
  severity?: SourceDiagnostic["severity"];
  sourceId: string;
}) {
  return sourceDiagnosticSchema.parse({
    sourceId: options.sourceId,
    severity: options.severity ?? "warning",
    code: options.code,
    message: options.message,
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function mergeStatus(
  statuses: SourceStatus[],
  patch: {
    sourceId: string;
    category: SourceCategory;
    status: SourceStatus["status"];
    runtimeEligible?: boolean;
    notes?: string[];
    diagnostics?: SourceDiagnostic[];
  },
) {
  const current = statuses.find((status) => status.sourceId === patch.sourceId);
  const nextStatus = sourceStatusSchema.parse({
    sourceId: patch.sourceId,
    category: patch.category,
    status: patch.status,
    runtimeEligible: patch.runtimeEligible ?? current?.runtimeEligible ?? true,
    notes: uniqueStrings([...(current?.notes ?? []), ...(patch.notes ?? [])]),
    diagnostics: [...(current?.diagnostics ?? []), ...(patch.diagnostics ?? [])],
  });
  const nextIndex = statuses.findIndex((status) => status.sourceId === patch.sourceId);

  if (nextIndex === -1) {
    statuses.push(nextStatus);
    return;
  }

  statuses[nextIndex] = nextStatus;
}

function mergeStatusList(statuses: SourceStatus[], incomingStatuses: SourceStatus[]) {
  incomingStatuses.forEach((status) => {
    mergeStatus(statuses, status);
  });
}

function summarizeError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unexpected source failure.";
}

function hasValidationError(error: unknown): error is {
  validationError: StructuredValidationError;
} {
  return Boolean(
    error &&
      typeof error === "object" &&
      "validationError" in error &&
      (error as { validationError?: unknown }).validationError,
  );
}

async function collect<T>(collector: () => Promise<T>): Promise<CollectorOutcome<T>> {
  try {
    return {
      ok: true,
      data: await collector(),
    };
  } catch (error) {
    return {
      ok: false,
      error,
      summary: summarizeError(error),
    };
  }
}

function getSourceLabel(sourceId: string) {
  return SOURCE_LABELS[sourceId] ?? sourceId;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function roundScore(value: number) {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, minimum = -1, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function getLatestTimestamp(values: string[]) {
  return values.reduce<string | null>((latest, candidate) => {
    if (!latest) {
      return candidate;
    }

    return Date.parse(candidate) > Date.parse(latest) ? candidate : latest;
  }, null);
}

function isTimestampStale(value: string | null, maxAgeMs: number, anchorMs: number) {
  if (!value) {
    return true;
  }

  return anchorMs - Date.parse(value) > maxAgeMs;
}

function buildQuoteSignalInput(
  quote: QuoteSnapshot | null,
  anchorMs: number,
): CategorySignalInput {
  if (!quote) {
    return {
      available: false,
      category: "quote",
      fresh: false,
      reason: "Quote data was unavailable for this request.",
      score: 0,
    };
  }

  const startPrice = quote.trendPoints[0]?.price ?? quote.currentPrice;
  const endPrice =
    quote.trendPoints[quote.trendPoints.length - 1]?.price ?? quote.currentPrice;
  const trendPercent = startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;
  let upMoves = 0;
  let downMoves = 0;

  for (let index = 1; index < quote.trendPoints.length; index += 1) {
    const previousPrice = quote.trendPoints[index - 1]?.price ?? 0;
    const currentPrice = quote.trendPoints[index]?.price ?? 0;

    if (currentPrice > previousPrice) {
      upMoves += 1;
    } else if (currentPrice < previousPrice) {
      downMoves += 1;
    }
  }

  const directionalConsistency =
    upMoves + downMoves === 0 ? 0 : (upMoves - downMoves) / (upMoves + downMoves);
  const score = clamp(
    quote.changePercent / 4.5 * 0.55 +
      trendPercent / 3 * 0.3 +
      directionalConsistency * 0.15,
  );
  const tone =
    quote.changePercent >= 0.2 ? "positive" : quote.changePercent <= -0.2 ? "negative" : "flat";

  return {
    available: true,
    category: "quote",
    fresh: !isTimestampStale(
      quote.capturedAt,
      env.QUOTE_FRESHNESS_MINUTES * 60 * 1000,
      anchorMs,
    ),
    reason:
      tone === "positive"
        ? `Quote momentum stayed positive at ${roundScore(quote.changePercent)}% with intraday trend support as of ${formatTimestamp(quote.capturedAt)} KST.`
        : tone === "negative"
          ? `Quote momentum stayed negative at ${roundScore(quote.changePercent)}% with intraday weakness as of ${formatTimestamp(quote.capturedAt)} KST.`
          : `Quote momentum was mostly flat into ${formatTimestamp(quote.capturedAt)} KST.`,
    score,
  };
}

function getNewsSentimentValue(sentiment: NewsItem["sentiment"]) {
  switch (sentiment) {
    case "positive":
      return 1;
    case "negative":
      return -1;
    case "mixed":
      return 0;
    default:
      return 0;
  }
}

function buildNewsSignalInput(
  news: Awaited<ReturnType<typeof resolveRecentNews>> | null,
  anchorMs: number,
): CategorySignalInput {
  if (!news) {
    return {
      available: false,
      category: "news",
      fresh: false,
      reason: "News coverage was unavailable for this request.",
      score: 0,
    };
  }

  const latestPublishedAt = getLatestTimestamp(news.news.map((item) => item.publishedAt));

  if (news.news.length === 0) {
    return {
      available: true,
      category: "news",
      fresh: false,
      reason: "The news source responded but did not return any recent validated articles.",
      score: 0,
    };
  }

  let weightedSentiment = 0;
  let totalWeight = 0;
  let positiveCount = 0;
  let negativeCount = 0;

  news.news.forEach((item) => {
    const hoursAgo = Math.max(0, (anchorMs - Date.parse(item.publishedAt)) / (60 * 60 * 1000));
    const weight = 1 / (1 + hoursAgo / 6);
    const sentimentValue = getNewsSentimentValue(item.sentiment);

    if (sentimentValue > 0) {
      positiveCount += 1;
    } else if (sentimentValue < 0) {
      negativeCount += 1;
    }

    weightedSentiment += sentimentValue * weight;
    totalWeight += weight;
  });

  const score = totalWeight === 0 ? 0 : clamp(weightedSentiment / totalWeight);
  const latestPublisher = news.news[0]?.publisher ?? "the news feed";

  return {
    available: true,
    category: "news",
    fresh: !isTimestampStale(
      latestPublishedAt,
      env.NEWS_FRESHNESS_HOURS * 60 * 60 * 1000,
      anchorMs,
    ),
    reason:
      positiveCount > negativeCount
        ? `News tone leaned positive across ${news.news.length} recent articles, latest from ${latestPublisher} at ${formatTimestamp(latestPublishedAt ?? news.source.capturedAt)} KST.`
        : negativeCount > positiveCount
          ? `News tone leaned negative across ${news.news.length} recent articles, latest from ${latestPublisher} at ${formatTimestamp(latestPublishedAt ?? news.source.capturedAt)} KST.`
          : `News coverage stayed mixed to neutral across ${news.news.length} recent articles through ${formatTimestamp(latestPublishedAt ?? news.source.capturedAt)} KST.`,
    score,
  };
}

function getCommunitySentimentValue(sentiment: "positive" | "negative" | "neutral" | "mixed" | "unknown") {
  if (sentiment === "positive") {
    return 1;
  }

  if (sentiment === "negative") {
    return -1;
  }

  return 0;
}

function buildCommunitySignalInput(
  community: Awaited<ReturnType<typeof resolvePublicCommunityReaction>> | null,
  anchorMs: number,
): CategorySignalInput {
  if (!community) {
    return {
      available: false,
      category: "community",
      fresh: false,
      reason: "Public community reaction was unavailable for this request.",
      score: 0,
    };
  }

  const latestPublishedAt = getLatestTimestamp(
    community.community.map((item) => item.publishedAt),
  );

  if (community.community.length === 0) {
    return {
      available: true,
      category: "community",
      fresh: false,
      reason: "The public community source responded without any validated stock-specific posts.",
      score: 0,
    };
  }

  let weightedSentiment = 0;
  let totalWeight = 0;

  community.community.forEach((post) => {
    const engagementWeight =
      1 +
      Math.log1p(
        (post.engagement.likes ?? 0) +
          (post.engagement.comments ?? 0) +
          (post.engagement.views ?? 0),
      );
    const hoursAgo = Math.max(0, (anchorMs - Date.parse(post.publishedAt)) / (60 * 60 * 1000));
    const recencyWeight = 1 / (1 + hoursAgo / 8);
    const weight = engagementWeight * recencyWeight;

    weightedSentiment += getCommunitySentimentValue(post.sentiment) * weight;
    totalWeight += weight;
  });

  const score = totalWeight === 0 ? 0 : clamp(weightedSentiment / totalWeight);
  const leadingTheme = community.summary.topThemes[0]?.label;

  return {
    available: true,
    category: "community",
    fresh: !isTimestampStale(
      latestPublishedAt,
      env.COMMUNITY_FRESHNESS_HOURS * 60 * 60 * 1000,
      anchorMs,
    ),
    reason:
      community.summary.bullishCount > community.summary.bearishCount
        ? `Community reaction skewed bullish${leadingTheme ? ` around ${leadingTheme}` : ""}, using ${community.summary.totalPosts} public posts through ${formatTimestamp(latestPublishedAt ?? community.source.capturedAt)} KST.`
        : community.summary.bearishCount > community.summary.bullishCount
          ? `Community reaction skewed bearish${leadingTheme ? ` around ${leadingTheme}` : ""}, using ${community.summary.totalPosts} public posts through ${formatTimestamp(latestPublishedAt ?? community.source.capturedAt)} KST.`
          : `Community reaction stayed balanced${leadingTheme ? ` around ${leadingTheme}` : ""} across ${community.summary.totalPosts} public posts.`,
    score,
  };
}

function getDisclosureOrientation(disclosure: DisclosureItem) {
  for (const rule of DISCLOSURE_SENTIMENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(disclosure.title))) {
      return rule.score;
    }
  }

  if (
    disclosure.category === "shareholder-return" ||
    disclosure.category === "earnings" ||
    disclosure.category === "corporate-action"
  ) {
    return 0.35;
  }

  if (disclosure.category === "market-notice") {
    return -0.35;
  }

  return 0;
}

function getImportanceWeight(importance: DisclosureItem["importance"]) {
  switch (importance) {
    case "high":
      return 1;
    case "medium":
      return 0.65;
    default:
      return 0.35;
  }
}

function buildDisclosureSignalInput(
  disclosures: Awaited<ReturnType<typeof resolveRecentDisclosures>> | null,
  anchorMs: number,
): CategorySignalInput {
  if (!disclosures) {
    return {
      available: false,
      category: "disclosure",
      fresh: false,
      reason: "Official disclosures were unavailable for this request.",
      score: 0,
    };
  }

  const latestPublishedAt = getLatestTimestamp(
    disclosures.disclosures.map((item) => item.publishedAt),
  );

  if (disclosures.disclosures.length === 0) {
    return {
      available: true,
      category: "disclosure",
      fresh: false,
      reason: "The KIND disclosure feed responded without any recent validated filings.",
      score: 0,
    };
  }

  let weightedOrientation = 0;
  let totalWeight = 0;

  disclosures.disclosures.forEach((item) => {
    const hoursAgo = Math.max(0, (anchorMs - Date.parse(item.publishedAt)) / (60 * 60 * 1000));
    const recencyWeight = 1 / (1 + hoursAgo / 24);
    const weight = getImportanceWeight(item.importance) * recencyWeight;

    weightedOrientation += getDisclosureOrientation(item) * weight;
    totalWeight += weight;
  });

  const score = totalWeight === 0 ? 0 : clamp(weightedOrientation / totalWeight);
  const topDisclosure = disclosures.disclosures[0];

  return {
    available: true,
    category: "disclosure",
    fresh: !isTimestampStale(
      latestPublishedAt,
      env.DISCLOSURE_FRESHNESS_HOURS * 60 * 60 * 1000,
      anchorMs,
    ),
    reason:
      score >= 0.15
        ? `Official disclosures leaned supportive, led by "${topDisclosure.title}" at ${formatTimestamp(topDisclosure.publishedAt)} KST.`
        : score <= -0.15
          ? `Official disclosures leaned cautious, led by "${topDisclosure.title}" at ${formatTimestamp(topDisclosure.publishedAt)} KST.`
          : `Official disclosures were mostly neutral, with "${topDisclosure.title}" the most visible recent filing at ${formatTimestamp(topDisclosure.publishedAt)} KST.`,
    score,
  };
}

function buildFinancialSignalInput(
  financials: Awaited<ReturnType<typeof resolveFinancialSummary>> | null,
): CategorySignalInput {
  const snapshot = financials?.financials[0] ?? null;
  const primaryStatus = financials?.sourceStatus.find(
    (status) => status.sourceId === STOCK_FINANCIAL_SOURCE_ID,
  );

  if (!snapshot) {
    return {
      available: false,
      category: "financial",
      fresh: false,
      reason: "Financial summary data was unavailable for this request.",
      score: 0,
    };
  }

  const metricScores: Array<{ score: number; weight: number }> = [];

  if (snapshot.operatingProfit !== null) {
    metricScores.push({
      score: snapshot.operatingProfit > 0 ? 1 : -1,
      weight: 0.28,
    });
  }

  if (snapshot.netIncome !== null) {
    metricScores.push({
      score: snapshot.netIncome > 0 ? 1 : -1,
      weight: 0.28,
    });
  }

  if (snapshot.eps !== null) {
    metricScores.push({
      score: snapshot.eps > 0 ? 1 : -1,
      weight: 0.16,
    });
  }

  if (snapshot.per !== null) {
    metricScores.push({
      score: snapshot.per <= 20 ? 0.7 : snapshot.per >= 45 ? -0.5 : 0,
      weight: 0.12,
    });
  }

  if (snapshot.pbr !== null) {
    metricScores.push({
      score: snapshot.pbr <= 2.5 ? 0.6 : snapshot.pbr >= 4 ? -0.4 : 0,
      weight: 0.1,
    });
  }

  if (snapshot.bps !== null) {
    metricScores.push({
      score: snapshot.bps > 0 ? 0.4 : -0.4,
      weight: 0.06,
    });
  }

  const totalWeight = metricScores.reduce((sum, item) => sum + item.weight, 0);
  const score =
    totalWeight === 0
      ? 0
      : clamp(
          metricScores.reduce((sum, item) => sum + item.score * item.weight, 0) /
            totalWeight,
        );
  const profitabilityTone =
    (snapshot.operatingProfit ?? 0) > 0 && (snapshot.netIncome ?? 0) > 0
      ? "positive"
      : (snapshot.operatingProfit ?? 0) < 0 || (snapshot.netIncome ?? 0) < 0
        ? "negative"
        : "mixed";

  return {
    available: true,
    category: "financial",
    fresh: primaryStatus?.status !== "stale",
    reason:
      profitabilityTone === "positive"
        ? `The ${snapshot.fiscalPeriod} financial snapshot stayed profitable with PER ${snapshot.per ?? "n/a"} and PBR ${snapshot.pbr ?? "n/a"}.`
        : profitabilityTone === "negative"
          ? `The ${snapshot.fiscalPeriod} financial snapshot showed profitability pressure and should temper longer-horizon confidence.`
          : `The ${snapshot.fiscalPeriod} financial snapshot was mixed, with partial support from valuation and earnings metrics.`,
    score,
  };
}

function computeDirection(score: number): HorizonSignal["direction"] {
  if (score >= 0.2) {
    return "up";
  }

  if (score <= -0.2) {
    return "down";
  }

  return "flat";
}

function computeConfidence(options: {
  availableCount: number;
  freshNonFinancialCount: number;
  horizon: HorizonSignal["horizon"];
  scoreMagnitude: number;
  signalInputs: CategorySignalInput[];
}) {
  if (options.availableCount < 3 || options.freshNonFinancialCount === 0) {
    return "low" as const;
  }

  let level = 2;

  if (options.availableCount >= 5 && options.scoreMagnitude >= 0.3) {
    level = 3;
  } else if (options.scoreMagnitude < 0.12) {
    level = 1;
  }

  const staleCount = options.signalInputs.filter(
    (signal) => signal.available && !signal.fresh,
  ).length;

  if (staleCount >= 2) {
    level -= 1;
  }

  const criticalCategoriesByHorizon: Record<
    HorizonSignal["horizon"],
    SourceCategory[]
  > = {
    "1d": ["quote", "news"],
    "1w": ["quote", "news", "disclosure"],
    "1m": ["financial", "disclosure"],
  };
  const criticalMiss = criticalCategoriesByHorizon[options.horizon].some((category) => {
    const signal = options.signalInputs.find((entry) => entry.category === category);
    return !signal?.available || !signal.fresh;
  });

  if (criticalMiss) {
    level -= 1;
  }

  if (level >= 3) {
    return "high" as const;
  }

  if (level <= 1) {
    return "low" as const;
  }

  return "medium" as const;
}

function buildSignals(options: {
  community: Awaited<ReturnType<typeof resolvePublicCommunityReaction>> | null;
  disclosures: Awaited<ReturnType<typeof resolveRecentDisclosures>> | null;
  financials: Awaited<ReturnType<typeof resolveFinancialSummary>> | null;
  horizons: HorizonSignal["horizon"][];
  news: Awaited<ReturnType<typeof resolveRecentNews>> | null;
  quote: QuoteSnapshot | null;
}) {
  const anchorMs = Date.now();
  const signalInputs = [
    buildQuoteSignalInput(options.quote, anchorMs),
    buildNewsSignalInput(options.news, anchorMs),
    buildCommunitySignalInput(options.community, anchorMs),
    buildDisclosureSignalInput(options.disclosures, anchorMs),
    buildFinancialSignalInput(options.financials),
  ];
  const availableCount = signalInputs.filter((signal) => signal.available).length;
  const freshNonFinancialCount = signalInputs.filter(
    (signal) => signal.category !== "financial" && signal.fresh,
  ).length;

  return options.horizons.map<HorizonSignal>((horizon) => {
    const weightedInputs = signalInputs
      .filter((signal) => signal.available)
      .map((signal) => ({
        ...signal,
        weight: CATEGORY_WEIGHTS[horizon][signal.category],
      }));
    // Normalize on only the categories that actually responded so partial data still produces a comparable score.
    const totalWeight = weightedInputs.reduce((sum, input) => sum + input.weight, 0);
    const weightedScore =
      totalWeight === 0
        ? 0
        : weightedInputs.reduce(
            (sum, input) => sum + input.score * input.weight,
            0,
          ) / totalWeight;
    const score = roundScore(weightedScore);
    const direction = computeDirection(score);
    const confidence = computeConfidence({
      availableCount,
      freshNonFinancialCount,
      horizon,
      scoreMagnitude: Math.abs(score),
      signalInputs,
    });
    const reasons = weightedInputs
      .map((input) => ({
        contribution: Math.abs(input.score * input.weight),
        reason: input.reason,
      }))
      .sort((left, right) => right.contribution - left.contribution)
      .map((item) => item.reason)
      .slice(0, 3);

    if (availableCount < 3) {
      reasons.push(
        "Confidence is capped at low because fewer than three source categories were available.",
      );
    }

    if (freshNonFinancialCount === 0) {
      reasons.push(
        "Confidence is capped at low because all non-financial evidence is stale or unavailable.",
      );
    }

    return {
      horizon,
      direction,
      score,
      confidence,
      reasons: uniqueStrings(reasons),
    };
  });
}

function buildCacheKey(stockCode: string) {
  return `dashboard:${stockCode}`;
}

function getCachedResult(input: AnalyzeInput) {
  const cacheEntry = analysisCache.get(buildCacheKey(input.stockCode));

  if (!cacheEntry || cacheEntry.expiresAt <= Date.now()) {
    if (cacheEntry) {
      analysisCache.delete(buildCacheKey(input.stockCode));
    }

    return null;
  }

  return dashboardResultSchema.parse({
    ...cacheEntry.result,
    signals: cacheEntry.result.signals.filter((signal) =>
      input.horizons.includes(signal.horizon),
    ),
    warnings: uniqueStrings([
      ...cacheEntry.result.warnings,
      `Served from short-lived server cache generated at ${formatTimestamp(cacheEntry.result.analyzedAt)} KST.`,
    ]),
  });
}

function setCachedResult(result: DashboardResult) {
  analysisCache.set(buildCacheKey(result.stockCode), {
    expiresAt: Date.now() + env.CACHE_TTL_SECONDS * 1000,
    result,
  });
}

function createFailedSourceWarning(sourceId: string, summary: string) {
  return `${getSourceLabel(sourceId)} failed: ${summary}`;
}

function hasNetworkWideReachabilityFailure(sourceStatus: SourceStatus[]) {
  return sourceStatus.some((status) =>
    status.diagnostics.some((diagnostic) =>
      isLikelyRuntimeNetworkIssue(diagnostic.message),
    ),
  );
}

export async function analyzeStockDashboard(
  input: unknown,
): Promise<DashboardResult> {
  const parsedInput = buildAnalyzeValidationError(input);
  const cachedResult = getCachedResult(parsedInput);

  if (cachedResult) {
    return cachedResult;
  }

  const analyzedAt = new Date().toISOString();
  const enabledCategories = getEnabledCategories();
  const sourceStatus = buildSourceDiagnostics({
    enabledCategories,
  });
  const warnings: string[] = [];
  let companyName = "Unknown issuer";
  let market = "Market unavailable";
  let quote: QuoteSnapshot | null = null;
  let news: Awaited<ReturnType<typeof resolveRecentNews>> | null = null;
  let community: Awaited<ReturnType<typeof resolvePublicCommunityReaction>> | null =
    null;
  let disclosures: Awaited<ReturnType<typeof resolveRecentDisclosures>> | null = null;
  let financials: Awaited<ReturnType<typeof resolveFinancialSummary>> | null = null;
  let listingAvailable = false;

  if (env.ENABLE_QUOTE_SOURCE) {
    try {
      const listing = await resolveStockListing(parsedInput.stockCode);

      listingAvailable = true;
      companyName = listing.companyName;
      market = listing.market;
      if (listing.sourceId === STOCK_RESOLUTION_SOURCE_ID) {
        mergeStatus(sourceStatus, {
          sourceId: STOCK_RESOLUTION_SOURCE_ID,
          category: "quote",
          status: "ready",
          notes: [
            `Resolved ${listing.companyName} (${listing.market}) at ${formatTimestamp(listing.capturedAt)} KST.`,
          ],
        });
      } else {
        mergeStatus(sourceStatus, {
          sourceId: STOCK_RESOLUTION_SOURCE_ID,
          category: "quote",
          status: "failed",
          diagnostics: listing.primaryFailureMessage
            ? [
                createDiagnostic({
                  code: "primary-resolver-failed",
                  message: listing.primaryFailureMessage,
                  severity: "warning",
                  sourceId: STOCK_RESOLUTION_SOURCE_ID,
                }),
              ]
            : [],
          notes: [
            "Primary listed issue resolver failed, so the fallback resolver was used.",
          ],
        });
        mergeStatus(sourceStatus, {
          sourceId: STOCK_RESOLUTION_FALLBACK_SOURCE_ID,
          category: "quote",
          status: "ready",
          notes: [
            `Resolved ${listing.companyName} (${listing.market}) at ${formatTimestamp(listing.capturedAt)} KST via fallback item page parsing.`,
          ],
        });
        if (listing.primaryFailureMessage) {
          warnings.push(
            `KRX listing resolver was unavailable, so Naver item page resolver was used instead.`,
          );
        }
      }
    } catch (error) {
      if (error instanceof QuoteLookupValidationError || hasValidationError(error)) {
        throw new AnalyzeDashboardValidationError(
          error instanceof QuoteLookupValidationError
            ? error.validationError
            : error.validationError,
        );
      }

      const summary = summarizeError(error);

      mergeStatus(sourceStatus, {
        sourceId: STOCK_RESOLUTION_SOURCE_ID,
        category: "quote",
        status: "failed",
        diagnostics: [
          createDiagnostic({
            code: "source-failure",
            message: summary,
            severity: "error",
            sourceId: STOCK_RESOLUTION_SOURCE_ID,
          }),
        ],
        notes: [`Stock identity could not be resolved for ${parsedInput.stockCode}.`],
      });
      warnings.push(
        createFailedSourceWarning(STOCK_RESOLUTION_SOURCE_ID, summary),
      );
    }
  }

  const [quoteOutcome, disclosureOutcome, financialOutcome] = await Promise.all([
    env.ENABLE_QUOTE_SOURCE
      ? collect(() => resolveQuoteSnapshot(parsedInput.stockCode))
      : Promise.resolve<CollectorOutcome<QuoteSnapshot> | null>(null),
    env.ENABLE_DISCLOSURE_SOURCE
      ? collect(() => resolveRecentDisclosures(parsedInput.stockCode))
      : Promise.resolve<CollectorOutcome<Awaited<ReturnType<typeof resolveRecentDisclosures>>> | null>(
          null,
        ),
    env.ENABLE_FINANCIAL_SOURCE
      ? collect(() => resolveFinancialSummary(parsedInput.stockCode))
      : Promise.resolve<CollectorOutcome<Awaited<ReturnType<typeof resolveFinancialSummary>>> | null>(
          null,
        ),
  ]);

  let newsOutcome: CollectorOutcome<Awaited<ReturnType<typeof resolveRecentNews>>> | null =
    null;
  let communityOutcome:
    | CollectorOutcome<Awaited<ReturnType<typeof resolvePublicCommunityReaction>>>
    | null = null;

  if (listingAvailable && (env.ENABLE_NEWS_SOURCE || env.ENABLE_COMMUNITY_SOURCE)) {
    [newsOutcome, communityOutcome] = await Promise.all([
      env.ENABLE_NEWS_SOURCE
        ? collect(() => resolveRecentNews(parsedInput.stockCode, companyName))
        : Promise.resolve<CollectorOutcome<Awaited<ReturnType<typeof resolveRecentNews>>> | null>(
            null,
          ),
      env.ENABLE_COMMUNITY_SOURCE
        ? collect(() =>
            resolvePublicCommunityReaction(parsedInput.stockCode, companyName),
          )
        : Promise.resolve<CollectorOutcome<Awaited<ReturnType<typeof resolvePublicCommunityReaction>>> | null>(
            null,
          ),
    ]);
  } else if (env.ENABLE_NEWS_SOURCE) {
    mergeStatus(sourceStatus, {
      sourceId: STOCK_NEWS_SOURCE_ID,
      category: "news",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          code: "dependency-unavailable",
          message:
            "News collection was skipped because company name resolution was unavailable.",
          sourceId: STOCK_NEWS_SOURCE_ID,
        }),
      ],
      notes: ["News collection requires a resolved company name."],
    });
    warnings.push(
      `${getSourceLabel(STOCK_NEWS_SOURCE_ID)} was skipped because company name resolution was unavailable.`,
    );
  }

  if (!listingAvailable && env.ENABLE_COMMUNITY_SOURCE) {
    mergeStatus(sourceStatus, {
      sourceId: STOCK_COMMUNITY_SOURCE_ID,
      category: "community",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          code: "dependency-unavailable",
          message:
            "Community collection was skipped because company name resolution was unavailable.",
          sourceId: STOCK_COMMUNITY_SOURCE_ID,
        }),
      ],
      notes: ["Community collection requires a resolved company name."],
    });
    warnings.push(
      `${getSourceLabel(STOCK_COMMUNITY_SOURCE_ID)} was skipped because company name resolution was unavailable.`,
    );
  }

  if (quoteOutcome?.ok) {
    quote = quoteOutcome.data;

    mergeStatus(sourceStatus, {
      sourceId: STOCK_QUOTE_SOURCE_ID,
      category: "quote",
      status: isTimestampStale(
        quote.capturedAt,
        env.QUOTE_FRESHNESS_MINUTES * 60 * 1000,
        Date.now(),
      )
        ? "stale"
        : "ready",
      notes: [
        `Captured quote snapshot at ${formatTimestamp(quote.capturedAt)} KST.`,
        `Latest price ${roundScore(quote.currentPrice)} KRW with ${quote.trendPoints.length} trend points.`,
      ],
      diagnostics: isTimestampStale(
        quote.capturedAt,
        env.QUOTE_FRESHNESS_MINUTES * 60 * 1000,
        Date.now(),
      )
        ? [
            createDiagnostic({
              code: "stale-quote",
              message: `Quote data is older than the configured ${env.QUOTE_FRESHNESS_MINUTES}-minute threshold.`,
              sourceId: STOCK_QUOTE_SOURCE_ID,
            }),
          ]
        : [],
    });
  } else if (env.ENABLE_QUOTE_SOURCE && quoteOutcome) {
    mergeStatus(sourceStatus, {
      sourceId: STOCK_QUOTE_SOURCE_ID,
      category: "quote",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          code: "source-failure",
          message: quoteOutcome.summary,
          severity: "error",
          sourceId: STOCK_QUOTE_SOURCE_ID,
        }),
      ],
      notes: ["Quote snapshot could not be collected."],
    });
    warnings.push(
      createFailedSourceWarning(STOCK_QUOTE_SOURCE_ID, quoteOutcome.summary),
    );
  }

  if (disclosureOutcome?.ok) {
    disclosures = disclosureOutcome.data;
    companyName = disclosures.companyName || companyName;
    mergeStatusList(sourceStatus, disclosures.sourceStatus);
    mergeStatus(sourceStatus, {
      sourceId: STOCK_DISCLOSURE_SOURCE_ID,
      category: "disclosure",
      status: isTimestampStale(
        getLatestTimestamp(disclosures.disclosures.map((item) => item.publishedAt)),
        env.DISCLOSURE_FRESHNESS_HOURS * 60 * 60 * 1000,
        Date.now(),
      )
        ? "stale"
        : "ready",
      notes: [
        `Captured ${disclosures.disclosures.length} disclosures at ${formatTimestamp(disclosures.source.capturedAt)} KST.`,
      ],
      diagnostics: disclosures.diagnostics,
    });
    warnings.push(
      ...disclosures.diagnostics
        .filter((diagnostic) => diagnostic.severity !== "info")
        .map((diagnostic) => diagnostic.message),
    );
  } else if (env.ENABLE_DISCLOSURE_SOURCE && disclosureOutcome) {
    mergeStatus(sourceStatus, {
      sourceId: STOCK_DISCLOSURE_SOURCE_ID,
      category: "disclosure",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          code: "source-failure",
          message: disclosureOutcome.summary,
          severity: "error",
          sourceId: STOCK_DISCLOSURE_SOURCE_ID,
        }),
      ],
      notes: ["Official disclosures could not be collected."],
    });
    warnings.push(
      createFailedSourceWarning(
        STOCK_DISCLOSURE_SOURCE_ID,
        disclosureOutcome.summary,
      ),
    );
  }

  if (financialOutcome?.ok) {
    financials = financialOutcome.data;
    companyName = financials.companyName || companyName;
    mergeStatusList(sourceStatus, financials.sourceStatus);
    warnings.push(
      ...financials.diagnostics
        .filter((diagnostic) => diagnostic.severity !== "info")
        .map((diagnostic) => diagnostic.message),
    );
  } else if (env.ENABLE_FINANCIAL_SOURCE && financialOutcome) {
    mergeStatus(sourceStatus, {
      sourceId: STOCK_FINANCIAL_SOURCE_ID,
      category: "financial",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          code: "source-failure",
          message: financialOutcome.summary,
          severity: "error",
          sourceId: STOCK_FINANCIAL_SOURCE_ID,
        }),
      ],
      notes: ["Financial summary data could not be collected."],
    });
    warnings.push(
      createFailedSourceWarning(
        STOCK_FINANCIAL_SOURCE_ID,
        financialOutcome.summary,
      ),
    );
  }

  if (newsOutcome?.ok) {
    news = newsOutcome.data;
    mergeStatus(sourceStatus, {
      sourceId: STOCK_NEWS_SOURCE_ID,
      category: "news",
      status: isTimestampStale(
        getLatestTimestamp(news.news.map((item) => item.publishedAt)),
        env.NEWS_FRESHNESS_HOURS * 60 * 60 * 1000,
        Date.now(),
      )
        ? "stale"
        : "ready",
      notes: [
        `Captured ${news.news.length} normalized news items at ${formatTimestamp(news.source.capturedAt)} KST.`,
      ],
      diagnostics: news.diagnostics,
    });
    warnings.push(
      ...news.diagnostics
        .filter((diagnostic) => diagnostic.severity !== "info")
        .map((diagnostic) => diagnostic.message),
    );
  } else if (env.ENABLE_NEWS_SOURCE && newsOutcome) {
    mergeStatus(sourceStatus, {
      sourceId: STOCK_NEWS_SOURCE_ID,
      category: "news",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          code: "source-failure",
          message: newsOutcome.summary,
          severity: "error",
          sourceId: STOCK_NEWS_SOURCE_ID,
        }),
      ],
      notes: ["Recent news could not be collected."],
    });
    warnings.push(
      createFailedSourceWarning(STOCK_NEWS_SOURCE_ID, newsOutcome.summary),
    );
  }

  if (communityOutcome?.ok) {
    community = communityOutcome.data;
    mergeStatusList(sourceStatus, community.sourceStatus);
    mergeStatus(sourceStatus, {
      sourceId: STOCK_COMMUNITY_SOURCE_ID,
      category: "community",
      status: isTimestampStale(
        getLatestTimestamp(community.community.map((item) => item.publishedAt)),
        env.COMMUNITY_FRESHNESS_HOURS * 60 * 60 * 1000,
        Date.now(),
      )
        ? "stale"
        : "ready",
      notes: [
        `Captured ${community.summary.totalPosts} public community posts at ${formatTimestamp(community.source.capturedAt)} KST.`,
      ],
      diagnostics: community.diagnostics,
    });
    warnings.push(
      ...community.diagnostics
        .filter((diagnostic) => diagnostic.severity !== "info")
        .map((diagnostic) => diagnostic.message),
    );
  } else if (env.ENABLE_COMMUNITY_SOURCE && communityOutcome) {
    mergeStatus(sourceStatus, {
      sourceId: STOCK_COMMUNITY_SOURCE_ID,
      category: "community",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          code: "source-failure",
          message: communityOutcome.summary,
          severity: "error",
          sourceId: STOCK_COMMUNITY_SOURCE_ID,
        }),
      ],
      notes: ["Public community reaction could not be collected."],
    });
    warnings.push(
      createFailedSourceWarning(
        STOCK_COMMUNITY_SOURCE_ID,
        communityOutcome.summary,
      ),
    );
  }

  const availableCategoryCount = [
    quote !== null,
    news !== null,
    community !== null,
    disclosures !== null,
    financials !== null,
  ].filter(Boolean).length;

  if (availableCategoryCount === 0) {
    const networkWideFailure = hasNetworkWideReachabilityFailure(sourceStatus);

    throw new AnalyzeDashboardSourceError(
      networkWideFailure
        ? "The stock code format was accepted, but the current runtime could not reach the public stock sources. If this app is running inside a restricted sandbox, grant outbound network access or run it outside that sandbox."
        : "The stock code format was accepted, but all enabled public sources were unavailable for this request.",
      {
        analyzedAt,
        sourceStatus,
        stockCode: parsedInput.stockCode,
        warnings: uniqueStrings(warnings),
      },
    );
  }

  const signals = buildSignals({
    community,
    disclosures,
    financials,
    horizons: parsedInput.horizons,
    news,
    quote,
  });
  const result = dashboardResultSchema.parse({
    stockCode: parsedInput.stockCode,
    companyName,
    market,
    analyzedAt,
    quote,
    news: news?.news ?? [],
    community: community?.community ?? [],
    disclosures: disclosures?.disclosures ?? [],
    financials: financials?.financials ?? [],
    signals,
    sourceStatus,
    warnings: uniqueStrings(warnings),
  });

  setCachedResult(
    dashboardResultSchema.parse({
      ...result,
      signals: buildSignals({
        community,
        disclosures,
        financials,
        horizons: [...DEFAULT_HORIZONS],
        news,
        quote,
      }),
    }),
  );

  return result;
}
