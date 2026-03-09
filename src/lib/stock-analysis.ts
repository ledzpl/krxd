import "server-only";

import { z } from "zod";

import {
  DEFAULT_HORIZONS,
  buildSignals,
  formatTimestamp,
  getLatestTimestamp,
  isTimestampStale,
  roundScore,
} from "./analysis-signals";
import { env } from "./env";
import { isLikelyRuntimeNetworkIssue } from "./fetch-failure";
import {
  buildStructuredValidationError,
  dashboardResultSchema,
  horizonSchema,
  sourceDiagnosticSchema,
  sourceStatusSchema,
  type DashboardResult,
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
import { resolveMarketOverview } from "./stock-market-overview";
import { normalizeStockCodeInput } from "./stock-code";

const MAX_ANALYSIS_CACHE_ENTRIES = 250;

const SOURCE_LABELS: Record<string, string> = {
  [STOCK_RESOLUTION_SOURCE_ID]: "KRX listing resolver",
  [STOCK_RESOLUTION_FALLBACK_SOURCE_ID]: "Naver item page resolver",
  [STOCK_QUOTE_SOURCE_ID]: "Naver domestic market data",
  [STOCK_NEWS_SOURCE_ID]: "Public market news search",
  [STOCK_COMMUNITY_SOURCE_ID]: "Tistory public blog search",
  [STOCK_DISCLOSURE_SOURCE_ID]: "KIND disclosures",
  [STOCK_FINANCIAL_SOURCE_ID]: "Public financial statements",
};

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

function buildCacheKey(stockCode: string) {
  return `dashboard:${stockCode}`;
}

function pruneAnalysisCache(now = Date.now()) {
  for (const [cacheKey, cacheEntry] of analysisCache.entries()) {
    if (cacheEntry.expiresAt <= now) {
      analysisCache.delete(cacheKey);
    }
  }

  while (analysisCache.size > MAX_ANALYSIS_CACHE_ENTRIES) {
    const oldestKey = analysisCache.keys().next().value;

    if (!oldestKey) {
      break;
    }

    analysisCache.delete(oldestKey);
  }
}

function getCachedResult(input: AnalyzeInput) {
  pruneAnalysisCache();
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
  pruneAnalysisCache();
  analysisCache.set(buildCacheKey(result.stockCode), {
    expiresAt: Date.now() + env.CACHE_TTL_SECONDS * 1000,
    result,
  });
  pruneAnalysisCache();
}

function createFailedSourceWarning(sourceId: string, summary: string) {
  return `${getSourceLabel(sourceId)} failed: ${summary}`;
}

function getCollectionStatus(options: {
  itemCount: number;
  latestPublishedAt: string | null;
  maxAgeMs: number;
}) {
  if (options.itemCount === 0) {
    return "ready" as const;
  }

  return isTimestampStale(options.latestPublishedAt, options.maxAgeMs, Date.now())
    ? ("stale" as const)
    : ("ready" as const);
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
  let marketOverview: Awaited<ReturnType<typeof resolveMarketOverview>> | null = null;
  let companyNameResolved = false;
  let listingFailureSummary: string | null = null;
  const requiresListingResolution =
    env.ENABLE_QUOTE_SOURCE || env.ENABLE_NEWS_SOURCE || env.ENABLE_COMMUNITY_SOURCE;

  if (requiresListingResolution) {
    try {
      const listing = await resolveStockListing(parsedInput.stockCode);

      companyNameResolved = true;
      companyName = listing.companyName;
      market = listing.market;
      if (!env.ENABLE_QUOTE_SOURCE) {
        if (listing.sourceId === STOCK_RESOLUTION_FALLBACK_SOURCE_ID) {
          warnings.push(
            "KRX listing resolver was unavailable, so Naver item page resolver was used instead.",
          );
        }
      } else if (listing.sourceId === STOCK_RESOLUTION_SOURCE_ID) {
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
      listingFailureSummary = summary;

      if (env.ENABLE_QUOTE_SOURCE) {
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
  }

  const [quoteOutcome, disclosureOutcome, financialOutcome, marketOverviewOutcome] = await Promise.all([
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
    collect(() => resolveMarketOverview(parsedInput.stockCode)),
  ]);

  if (marketOverviewOutcome?.ok) {
    marketOverview = marketOverviewOutcome.data;
  }

  let newsOutcome: CollectorOutcome<Awaited<ReturnType<typeof resolveRecentNews>>> | null =
    null;
  let communityOutcome:
    | CollectorOutcome<Awaited<ReturnType<typeof resolvePublicCommunityReaction>>>
    | null = null;

  if (disclosureOutcome?.ok && disclosureOutcome.data.companyName) {
    companyName = disclosureOutcome.data.companyName;
    companyNameResolved = true;
  }

  if (financialOutcome?.ok && financialOutcome.data.companyName) {
    companyName = financialOutcome.data.companyName;
    companyNameResolved = true;
  }

  const companyNameDependencyMessage = listingFailureSummary
    ? `company name resolution was unavailable (${listingFailureSummary})`
    : "company name resolution was unavailable";

  if (companyNameResolved && (env.ENABLE_NEWS_SOURCE || env.ENABLE_COMMUNITY_SOURCE)) {
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
          message: `News collection was skipped because ${companyNameDependencyMessage}.`,
          sourceId: STOCK_NEWS_SOURCE_ID,
        }),
      ],
      notes: ["News collection requires a resolved company name."],
    });
    warnings.push(
      `${getSourceLabel(STOCK_NEWS_SOURCE_ID)} was skipped because company name resolution was unavailable.`,
    );
  }

  if (!companyNameResolved && env.ENABLE_COMMUNITY_SOURCE) {
    mergeStatus(sourceStatus, {
      sourceId: STOCK_COMMUNITY_SOURCE_ID,
      category: "community",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          code: "dependency-unavailable",
          message: `Community collection was skipped because ${companyNameDependencyMessage}.`,
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
    const isQuoteStale = isTimestampStale(
      quote.capturedAt,
      env.QUOTE_FRESHNESS_MINUTES * 60 * 1000,
      Date.now(),
    );

    mergeStatus(sourceStatus, {
      sourceId: STOCK_QUOTE_SOURCE_ID,
      category: "quote",
      status: isQuoteStale ? "stale" : "ready",
      notes: [
        `Captured quote snapshot at ${formatTimestamp(quote.capturedAt)} KST.`,
        `Latest price ${roundScore(quote.currentPrice)} KRW with ${quote.trendPoints.length} trend points.`,
      ],
      diagnostics: isQuoteStale
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
      status: getCollectionStatus({
        itemCount: disclosures.disclosures.length,
        latestPublishedAt: getLatestTimestamp(
          disclosures.disclosures.map((item) => item.publishedAt),
        ),
        maxAgeMs: env.DISCLOSURE_FRESHNESS_HOURS * 60 * 60 * 1000,
      }),
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
      status: getCollectionStatus({
        itemCount: news.news.length,
        latestPublishedAt: getLatestTimestamp(news.news.map((item) => item.publishedAt)),
        maxAgeMs: env.NEWS_FRESHNESS_HOURS * 60 * 60 * 1000,
      }),
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
      status: getCollectionStatus({
        itemCount: community.community.length,
        latestPublishedAt: getLatestTimestamp(
          community.community.map((item) => item.publishedAt),
        ),
        maxAgeMs: env.COMMUNITY_FRESHNESS_HOURS * 60 * 60 * 1000,
      }),
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
    marketOverview,
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
