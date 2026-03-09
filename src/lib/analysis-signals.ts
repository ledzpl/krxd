import { env } from "./env";
import type {
  CommunityLookupResult,
  DisclosureItem,
  DisclosureLookupResult,
  FinancialLookupResult,
  HorizonSignal,
  NewsItem,
  NewsLookupResult,
  QuoteSnapshot,
  SourceCategory,
} from "./normalized-schemas";
import { STOCK_FINANCIAL_SOURCE_ID } from "./stock-financials";

export const DEFAULT_HORIZONS = ["1d", "1w", "1m"] as const;

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
] as const;

type CategorySignalInput = {
  available: boolean;
  category: SourceCategory;
  fresh: boolean;
  reason: string;
  score: number;
};

const timestampFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Seoul",
});

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function formatTimestamp(value: string) {
  return timestampFormatter.format(new Date(value));
}

export function roundScore(value: number) {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, minimum = -1, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function getLatestTimestamp(values: string[]) {
  return values.reduce<string | null>((latest, candidate) => {
    if (!latest) {
      return candidate;
    }

    return Date.parse(candidate) > Date.parse(latest) ? candidate : latest;
  }, null);
}

export function isTimestampStale(
  value: string | null,
  maxAgeMs: number,
  anchorMs: number,
) {
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
    (quote.changePercent / 4.5) * 0.55 +
      (trendPercent / 3) * 0.3 +
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
  news: NewsLookupResult | null,
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

function getCommunitySentimentValue(
  sentiment: "positive" | "negative" | "neutral" | "mixed" | "unknown",
) {
  if (sentiment === "positive") {
    return 1;
  }

  if (sentiment === "negative") {
    return -1;
  }

  return 0;
}

function buildCommunitySignalInput(
  community: CommunityLookupResult | null,
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
  disclosures: DisclosureLookupResult | null,
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
  financials: FinancialLookupResult | null,
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

export function buildSignals(options: {
  community: CommunityLookupResult | null;
  disclosures: DisclosureLookupResult | null;
  financials: FinancialLookupResult | null;
  horizons: HorizonSignal["horizon"][];
  news: NewsLookupResult | null;
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
