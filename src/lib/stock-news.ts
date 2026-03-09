import "server-only";

import { createHash } from "node:crypto";

import { load } from "cheerio";
import { z } from "zod";

import { env } from "./env";
import { describeFetchFailure, mapUpstreamStatusCode } from "./fetch-failure";
import {
  buildStructuredValidationError,
  createValidationDiagnostic,
  newsItemSchema,
  newsLookupResultSchema,
  sourceDiagnosticSchema,
  stockQuerySchema,
  type NewsItem,
  type NewsLookupResult,
  type SourceDiagnostic,
  type StructuredValidationError,
} from "./normalized-schemas";

export const STOCK_NEWS_SOURCE_ID = "public-news-search";

const NEWS_RESULTS_LIMIT = 8;
const relativePublishedAtPattern =
  /^(?:방금|조금 전|어제|그제|\d+\s*(?:분|시간|일|주|개월)\s*전)$/;
const absolutePublishedAtPattern =
  /^\d{4}\.\d{1,2}\.\d{1,2}\.?(?:\s*(?:오전|오후)?\s*\d{1,2}(?::\d{2})?)?$/;
const trackingParamPatterns = [
  /^utm_/i,
  /^ref$/i,
  /^from$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^ocid$/i,
  /^nclick/i,
];

const positiveSentimentKeywords = [
  "상승",
  "급등",
  "강세",
  "반등",
  "회복",
  "호재",
  "흑자",
  "개선",
  "확대",
  "수혜",
  "돌파",
  "상향",
  "증가",
  "최고가",
];

const negativeSentimentKeywords = [
  "하락",
  "급락",
  "약세",
  "우려",
  "부진",
  "악재",
  "적자",
  "감소",
  "둔화",
  "결렬",
  "리스크",
  "충격",
  "하향",
  "차질",
];

const newsLookupInputSchema = stockQuerySchema.pick({
  stockCode: true,
}).extend({
  companyName: z
    .string()
    .trim()
    .min(1, "companyName is required")
    .max(80, "companyName must be 80 characters or fewer"),
});

type ParsedNewsCandidate = {
  index: number;
  publisher: string;
  publishedText: string | null;
  summary: string;
  title: string;
  url: string | null;
};

type FetchOptions = {
  sourceId: string;
};

export class NewsLookupValidationError extends Error {
  readonly statusCode = 400;

  constructor(readonly validationError: StructuredValidationError) {
    super(validationError.summary);
    this.name = "NewsLookupValidationError";
  }
}

export class NewsLookupSourceError extends Error {
  readonly statusCode: number;

  constructor(
    readonly sourceId: string,
    message: string,
    options?: {
      cause?: unknown;
      statusCode?: number;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "NewsLookupSourceError";
    this.statusCode = options?.statusCode ?? 502;
  }
}

function cleanText(value: string | undefined | null) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function createDiagnostic(options: {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  validationErrors?: SourceDiagnostic["validationErrors"];
}) {
  return sourceDiagnosticSchema.parse({
    sourceId: STOCK_NEWS_SOURCE_ID,
    severity: options.severity,
    code: options.code,
    message: options.message,
    entity: "newsItem",
    validationErrors: options.validationErrors ?? [],
  });
}

function getRequestInit() {
  return {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": env.DEFAULT_USER_AGENT,
    },
    signal: AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
    next: {
      revalidate: env.CACHE_TTL_SECONDS,
    },
  };
}

async function fetchTextFromSource(url: string, options: FetchOptions) {
  let response: Response;

  try {
    response = await fetch(url, getRequestInit());
  } catch (error) {
    throw new NewsLookupSourceError(
      options.sourceId,
      describeFetchFailure(options.sourceId, error),
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new NewsLookupSourceError(
      options.sourceId,
      `Source ${options.sourceId} returned HTTP ${response.status}.`,
      { statusCode: mapUpstreamStatusCode(response.status) },
    );
  }

  return response.text();
}

function buildSearchUrl(stockCode: string, companyName: string) {
  const url = new URL("https://search.naver.com/search.naver");

  url.search = new URLSearchParams({
    where: "news",
    query: `${stockCode} ${companyName} 주식`,
    sort: "1",
    pd: "0",
    photo: "0",
    field: "0",
    office_type: "0",
    office_section_code: "0",
    news_office_checked: "",
    nso: "so:dd,p:all,a:all",
  }).toString();

  return url.toString();
}

function looksLikePublishedText(value: string) {
  return (
    relativePublishedAtPattern.test(value) ||
    absolutePublishedAtPattern.test(value)
  );
}

function parsePublishedAt(
  publishedText: string | null,
  anchorDate: Date,
): string | null {
  if (!publishedText) {
    return null;
  }

  const normalized = cleanText(publishedText);

  if (normalized === "방금" || normalized === "조금 전") {
    return anchorDate.toISOString();
  }

  if (normalized === "어제") {
    return new Date(anchorDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
  }

  if (normalized === "그제") {
    return new Date(anchorDate.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  }

  const relativeMatch = normalized.match(
    /^(\d+)\s*(분|시간|일|주|개월)\s*전$/,
  );

  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    const relativeDate = new Date(anchorDate);

    if (unit === "분") {
      relativeDate.setMinutes(relativeDate.getMinutes() - amount);
    } else if (unit === "시간") {
      relativeDate.setHours(relativeDate.getHours() - amount);
    } else if (unit === "일") {
      relativeDate.setDate(relativeDate.getDate() - amount);
    } else if (unit === "주") {
      relativeDate.setDate(relativeDate.getDate() - amount * 7);
    } else if (unit === "개월") {
      relativeDate.setMonth(relativeDate.getMonth() - amount);
    }

    return relativeDate.toISOString();
  }

  const absoluteMatch = normalized.match(
    /^(\d{4})\.(\d{1,2})\.(\d{1,2})\.?(?:\s*(오전|오후)?\s*(\d{1,2})(?::(\d{2}))?)?$/,
  );

  if (!absoluteMatch) {
    return null;
  }

  const [, year, month, day, meridiem, hourText, minuteText] = absoluteMatch;
  let hour = Number(hourText ?? "0");

  if (meridiem === "오후" && hour < 12) {
    hour += 12;
  } else if (meridiem === "오전" && hour === 12) {
    hour = 0;
  }

  const minute = Number(minuteText ?? "0");

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${String(
    hour,
  ).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`;
}

function canonicalizeArticleUrl(urlValue: string | null) {
  if (!urlValue) {
    return null;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(urlValue);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return null;
  }

  const paramsToDelete = [...parsedUrl.searchParams.keys()].filter((key) =>
    trackingParamPatterns.some((pattern) => pattern.test(key)),
  );

  paramsToDelete.forEach((key) => parsedUrl.searchParams.delete(key));

  parsedUrl.hash = "";
  parsedUrl.hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");

  if (
    (parsedUrl.protocol === "https:" && parsedUrl.port === "443") ||
    (parsedUrl.protocol === "http:" && parsedUrl.port === "80")
  ) {
    parsedUrl.port = "";
  }

  if (parsedUrl.pathname !== "/") {
    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
  }

  return parsedUrl.toString();
}

function normalizeTitleForDedup(title: string) {
  return cleanText(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function buildSummary(summary: string, title: string) {
  const normalized = cleanText(summary) || cleanText(title);

  if (normalized.length <= 220) {
    return normalized;
  }

  return `${normalized.slice(0, 217).trimEnd()}...`;
}

function detectSentiment(title: string, summary: string): NewsItem["sentiment"] {
  const content = `${cleanText(title)} ${cleanText(summary)}`;
  const positiveMatches = positiveSentimentKeywords.filter((keyword) =>
    content.includes(keyword),
  ).length;
  const negativeMatches = negativeSentimentKeywords.filter((keyword) =>
    content.includes(keyword),
  ).length;

  if (positiveMatches > 0 && negativeMatches > 0) {
    return "mixed";
  }

  if (positiveMatches > negativeMatches) {
    return "positive";
  }

  if (negativeMatches > positiveMatches) {
    return "negative";
  }

  return "neutral";
}

function buildArticleId(url: string, title: string) {
  return createHash("sha1")
    .update(`${url}|${normalizeTitleForDedup(title)}`)
    .digest("hex")
    .slice(0, 16);
}

function parseNewsCandidates(markup: string) {
  const $ = load(markup);
  const list = $(".fds-news-item-list-tab").first();

  if (!list.length) {
    throw new NewsLookupSourceError(
      STOCK_NEWS_SOURCE_ID,
      `Source ${STOCK_NEWS_SOURCE_ID} returned unexpected markup.`,
    );
  }

  return list
    .children("div")
    .toArray()
    .map((element, index) => {
      const item = $(element);
      const profile = item.find('[data-sds-comp="Profile"]').first();
      const titleLink = item.find('[data-heatmap-target=".tit"]').first();
      const summaryLink = item.find('[data-heatmap-target=".body"]').first();
      const metaTexts = profile
        .find(".sds-comps-profile-info-subtexts .sds-comps-text-ellipsis-1")
        .map((_, metaElement) => cleanText($(metaElement).text()))
        .get();
      const publishedText =
        metaTexts.find((value) => looksLikePublishedText(value)) ?? null;

      const candidate: ParsedNewsCandidate = {
        index,
        publisher: cleanText(
          profile.find(".sds-comps-profile-info-title-text").first().text(),
        ),
        publishedText,
        summary: cleanText(summaryLink.text()),
        title: cleanText(titleLink.text()),
        url:
          titleLink.attr("href")?.trim() ??
          summaryLink.attr("href")?.trim() ??
          null,
      };

      if (!candidate.title && !candidate.summary && !candidate.publisher) {
        return null;
      }

      return candidate;
    })
    .filter((candidate): candidate is ParsedNewsCandidate => candidate !== null);
}

function validateInput(stockCode: string, companyName: string) {
  const result = newsLookupInputSchema.safeParse({
    stockCode,
    companyName,
  });

  if (!result.success) {
    throw new NewsLookupValidationError(
      buildStructuredValidationError(result.error, {
        entity: "stockQuery",
      }),
    );
  }

  return result.data;
}

export async function resolveRecentNews(
  requestedStockCode: string,
  requestedCompanyName: string,
): Promise<NewsLookupResult> {
  const { stockCode, companyName } = validateInput(
    requestedStockCode,
    requestedCompanyName,
  );
  const capturedAt = new Date();
  const diagnostics: SourceDiagnostic[] = [];
  const seenUrls = new Set<string>();
  const seenPublisherTitles = new Set<string>();

  const markup = await fetchTextFromSource(
    buildSearchUrl(stockCode, companyName),
    {
      sourceId: STOCK_NEWS_SOURCE_ID,
    },
  );

  const candidates = parseNewsCandidates(markup);
  const news: NewsItem[] = [];

  if (candidates.length === 0) {
    diagnostics.push(
      createDiagnostic({
        code: "no-news-items",
        message: `Source ${STOCK_NEWS_SOURCE_ID} returned no recent articles for ${stockCode} ${companyName}.`,
        severity: "warning",
      }),
    );
  }

  for (const candidate of candidates) {
    const canonicalUrl = canonicalizeArticleUrl(candidate.url);

    if (!canonicalUrl) {
      diagnostics.push(
        createDiagnostic({
          code: "discarded-invalid-url",
          message: `Discarded article #${candidate.index + 1} because it was missing a valid article URL.`,
          severity: "warning",
        }),
      );
      continue;
    }

    const publishedAt = parsePublishedAt(candidate.publishedText, capturedAt);

    if (!publishedAt) {
      diagnostics.push(
        createDiagnostic({
          code: "discarded-invalid-published-at",
          message: `Discarded article "${candidate.title || canonicalUrl}" because it was missing a valid publish timestamp.`,
          severity: "warning",
        }),
      );
      continue;
    }

    const titleKey = `${candidate.publisher.toLowerCase()}::${normalizeTitleForDedup(
      candidate.title,
    )}`;

    if (seenUrls.has(canonicalUrl) || seenPublisherTitles.has(titleKey)) {
      diagnostics.push(
        createDiagnostic({
          code: "discarded-duplicate-article",
          message: `Discarded duplicate article "${candidate.title}".`,
          severity: "info",
        }),
      );
      continue;
    }

    const validationResult = newsItemSchema.safeParse({
      id: buildArticleId(canonicalUrl, candidate.title),
      source: STOCK_NEWS_SOURCE_ID,
      title: candidate.title,
      summary: buildSummary(candidate.summary, candidate.title),
      publisher: candidate.publisher,
      publishedAt,
      url: canonicalUrl,
      sentiment: detectSentiment(candidate.title, candidate.summary),
    });

    if (!validationResult.success) {
      diagnostics.push(
        createValidationDiagnostic(
          buildStructuredValidationError(validationResult.error, {
            entity: "newsItem",
            sourceId: STOCK_NEWS_SOURCE_ID,
          }),
        ),
      );
      continue;
    }

    seenUrls.add(canonicalUrl);
    seenPublisherTitles.add(titleKey);
    news.push(validationResult.data);

    if (news.length >= NEWS_RESULTS_LIMIT) {
      break;
    }
  }

  return newsLookupResultSchema.parse({
    stockCode,
    companyName,
    source: {
      source: STOCK_NEWS_SOURCE_ID,
      capturedAt: capturedAt.toISOString(),
    },
    news,
    diagnostics,
  });
}
