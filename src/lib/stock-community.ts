import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { env } from "./env";
import { describeFetchFailure, mapUpstreamStatusCode } from "./fetch-failure";
import {
  buildStructuredValidationError,
  communityLookupResultSchema,
  communityPostSchema,
  createValidationDiagnostic,
  sourceDiagnosticSchema,
  stockQuerySchema,
  type CommunityLookupResult,
  type CommunityPost,
  type SourceDiagnostic,
  type StructuredValidationError,
} from "./normalized-schemas";
import { buildSourceDiagnostics } from "./source-registry";

export const STOCK_COMMUNITY_SOURCE_ID = "tistory-public-blog-search";

const COMMUNITY_RESULTS_LIMIT = 10;
const COMMUNITY_PAGE_LIMIT = 3;
const trackingParamPatterns = [
  /^utm_/i,
  /^ref$/i,
  /^source$/i,
  /^from$/i,
  /^fbclid$/i,
  /^gclid$/i,
];

const stockDiscussionKeywords = [
  "주식",
  "주가",
  "투자",
  "매수",
  "매도",
  "전망",
  "실적",
  "배당",
  "리스크",
  "저평가",
  "고평가",
  "목표주가",
  "파업",
  "노조",
  "수급",
  "반도체",
];

const positiveSentimentKeywords = [
  "상승",
  "반등",
  "호재",
  "매수",
  "저평가",
  "유망",
  "기대",
  "강세",
  "호실적",
  "수혜",
  "돌파",
  "회복",
  "추천",
  "긍정",
];

const negativeSentimentKeywords = [
  "하락",
  "급락",
  "악재",
  "우려",
  "매도",
  "고평가",
  "리스크",
  "약세",
  "부진",
  "적자",
  "파업",
  "충격",
  "불안",
  "경고",
  "손절",
];

const themeCatalog = [
  {
    label: "Semiconductor Demand",
    keywords: ["반도체", "HBM", "메모리", "DRAM", "파운드리", "NPU", "GPU", "AI"],
  },
  {
    label: "Earnings Outlook",
    keywords: ["실적", "영업이익", "매출", "순이익", "EPS", "가이던스", "컨센서스"],
  },
  {
    label: "Valuation",
    keywords: ["PER", "PBR", "저평가", "고평가", "밸류", "목표주가", "적정주가"],
  },
  {
    label: "Dividend And Buybacks",
    keywords: ["배당", "배당금", "자사주", "주주환원"],
  },
  {
    label: "Labor Risk",
    keywords: ["노조", "파업", "임금", "협상", "생산차질"],
  },
  {
    label: "Trading Strategy",
    keywords: ["매수", "매도", "손절", "분할매수", "비중", "투자전략"],
  },
  {
    label: "Macro Risk",
    keywords: ["유가", "금리", "환율", "전쟁", "경기", "인플레이션", "관세"],
  },
  {
    label: "Investor Flow",
    keywords: ["외국인", "기관", "수급", "공매도", "신용"],
  },
];

const ignoredThemeTokens = new Set([
  "주식",
  "주가",
  "투자",
  "관련주",
  "국내",
  "한국",
  "시장",
  "증시",
  "종목",
  "정리",
  "분석",
  "가이드",
  "전망",
  "현재",
  "오늘",
  "내일",
  "이번",
  "대한",
  "무엇",
  "이유",
  "포인트",
]);

const communityLookupInputSchema = stockQuerySchema.pick({
  stockCode: true,
}).extend({
  companyName: z
    .string()
    .trim()
    .min(1, "companyName is required")
    .max(80, "companyName must be 80 characters or fewer"),
});

const tistorySearchEntrySchema = z.object({
  blogTitle: z.string().trim().min(1),
  blogUrl: z.string().trim().min(1),
  entrySummary: z.string().catch(""),
  entryTitle: z.string().trim().min(1),
  entryUrl: z.string().trim().min(1),
  entryPublished: z.string().trim().min(1),
  likeCount: z.coerce.number().int().nonnegative(),
  commentCount: z.coerce.number().int().nonnegative(),
  entryId: z.coerce.number().int().nonnegative(),
});

const tistorySearchResponseSchema = z.object({
  data: z.object({
    searchedEntries: z.array(tistorySearchEntrySchema),
    page: z.coerce.number().int().positive(),
    totalCount: z.coerce.number().int().nonnegative(),
    nextPage: z.coerce.number().int().nonnegative(),
  }),
  code: z.literal("OK"),
});

type TistorySearchEntry = z.infer<typeof tistorySearchEntrySchema>;

export class CommunityLookupValidationError extends Error {
  readonly statusCode = 400;

  constructor(readonly validationError: StructuredValidationError) {
    super(validationError.summary);
    this.name = "CommunityLookupValidationError";
  }
}

export class CommunityLookupSourceError extends Error {
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
    this.name = "CommunityLookupSourceError";
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
    sourceId: STOCK_COMMUNITY_SOURCE_ID,
    severity: options.severity,
    code: options.code,
    message: options.message,
    entity: "communityPost",
    validationErrors: options.validationErrors ?? [],
  });
}

function getRequestInit() {
  return {
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": env.DEFAULT_USER_AGENT,
    },
    signal: AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
    next: {
      revalidate: env.CACHE_TTL_SECONDS,
    },
  };
}

async function fetchJsonFromSource<T>(
  url: string,
  schema: z.ZodType<T>,
  sourceId: string,
) {
  let response: Response;

  try {
    response = await fetch(url, getRequestInit());
  } catch (error) {
    throw new CommunityLookupSourceError(
      sourceId,
      describeFetchFailure(sourceId, error),
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new CommunityLookupSourceError(
      sourceId,
      `Source ${sourceId} returned HTTP ${response.status}.`,
      { statusCode: mapUpstreamStatusCode(response.status) },
    );
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    throw new CommunityLookupSourceError(
      sourceId,
      `Source ${sourceId} returned an unreadable JSON payload.`,
      { cause: error },
    );
  }

  const parsedPayload = schema.safeParse(payload);

  if (!parsedPayload.success) {
    throw new CommunityLookupSourceError(
      sourceId,
      `Source ${sourceId} returned an unexpected payload shape.`,
      { cause: parsedPayload.error },
    );
  }

  return parsedPayload.data;
}

function buildSearchUrl(companyName: string, page: number) {
  const url = new URL("https://www.tistory.com/api/v1/search/posts");

  url.search = new URLSearchParams({
    keyword: `${companyName} 주식`,
    sort: "RECENCY",
    page: String(page),
  }).toString();

  return url.toString();
}

function canonicalizeEntryUrl(urlValue: string) {
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

function validateInput(stockCode: string, companyName: string) {
  const result = communityLookupInputSchema.safeParse({
    stockCode,
    companyName,
  });

  if (!result.success) {
    throw new CommunityLookupValidationError(
      buildStructuredValidationError(result.error, {
        entity: "stockQuery",
      }),
    );
  }

  return result.data;
}

function buildExcerpt(summary: string, title: string) {
  const normalized = cleanText(summary) || cleanText(title);

  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(0, 237).trimEnd()}...`;
}

function isRelevantEntry(
  entry: TistorySearchEntry,
  companyName: string,
  stockCode: string,
) {
  const content = cleanText(
    `${entry.entryTitle} ${buildExcerpt(entry.entrySummary, entry.entryTitle)}`,
  );
  const normalizedContent = content.toLowerCase();
  const hasStockIdentity =
    normalizedContent.includes(companyName.toLowerCase()) ||
    normalizedContent.includes(stockCode);
  const hasDiscussionKeyword = stockDiscussionKeywords.some((keyword) =>
    content.includes(keyword),
  );

  return hasStockIdentity && hasDiscussionKeyword;
}

function detectSentiment(
  title: string,
  excerpt: string,
): CommunityPost["sentiment"] {
  const content = `${cleanText(title)} ${cleanText(excerpt)}`;
  const positiveMatches = positiveSentimentKeywords.filter((keyword) =>
    content.includes(keyword),
  ).length;
  const negativeMatches = negativeSentimentKeywords.filter((keyword) =>
    content.includes(keyword),
  ).length;

  if (positiveMatches > negativeMatches) {
    return "positive";
  }

  if (negativeMatches > positiveMatches) {
    return "negative";
  }

  return "neutral";
}

function buildPostId(url: string, title: string) {
  return createHash("sha1")
    .update(`${url}|${normalizeTitleForDedup(title)}`)
    .digest("hex")
    .slice(0, 16);
}

function buildPostSource(entry: TistorySearchEntry, canonicalUrl: string) {
  const blogTitle = cleanText(entry.blogTitle);

  if (blogTitle) {
    return blogTitle;
  }

  return new URL(canonicalUrl).hostname;
}

function extractTopThemes(posts: CommunityPost[], companyName: string) {
  const themeCounts = new Map<string, number>();

  for (const post of posts) {
    const content = cleanText(`${post.title} ${post.excerpt}`);
    const postThemes = new Set<string>();

    themeCatalog.forEach((theme) => {
      if (theme.keywords.some((keyword) => content.includes(keyword))) {
        postThemes.add(theme.label);
      }
    });

    postThemes.forEach((theme) => {
      themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
    });
  }

  const rankedThemes = [...themeCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, mentions]) => ({ label, mentions }));

  if (rankedThemes.length >= 3) {
    return rankedThemes.slice(0, 5);
  }

  const fallbackTokenCounts = new Map<string, number>();
  const companyTokens = new Set(
    cleanText(companyName)
      .split(/\s+/)
      .filter(Boolean),
  );

  for (const post of posts) {
    const uniqueTokens = new Set(
      (cleanText(`${post.title} ${post.excerpt}`).match(/[가-힣A-Za-z0-9]{2,}/g) ?? [])
        .map((token) => token.trim())
        .filter(
          (token) =>
            !ignoredThemeTokens.has(token) &&
            !companyTokens.has(token) &&
            !/^\d+$/.test(token),
        ),
    );

    uniqueTokens.forEach((token) => {
      fallbackTokenCounts.set(token, (fallbackTokenCounts.get(token) ?? 0) + 1);
    });
  }

  const fallbackThemes = [...fallbackTokenCounts.entries()]
    .filter(([label]) => !themeCounts.has(label))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, mentions]) => ({ label, mentions }));

  return [...rankedThemes, ...fallbackThemes].slice(0, 5);
}

function summarizeCommunity(posts: CommunityPost[], companyName: string) {
  const bullishCount = posts.filter((post) => post.sentiment === "positive").length;
  const bearishCount = posts.filter((post) => post.sentiment === "negative").length;

  return {
    totalPosts: posts.length,
    bullishCount,
    bearishCount,
    neutralCount: posts.length - bullishCount - bearishCount,
    topThemes: extractTopThemes(posts, companyName),
  };
}

function buildCommunitySourceStatus(postCount: number, capturedAt: string) {
  return buildSourceDiagnostics({
    enabledCategories: ["community"],
  })
    .filter((status) => status.category === "community")
    .map((status) =>
      status.sourceId === STOCK_COMMUNITY_SOURCE_ID
        ? {
            ...status,
            status: "ready" as const,
            notes: [
              ...status.notes,
              `Captured ${postCount} normalized community posts at ${capturedAt}.`,
            ],
          }
        : status,
    );
}

async function fetchCommunityPage(companyName: string, page: number) {
  const response = await fetchJsonFromSource(
    buildSearchUrl(companyName, page),
    tistorySearchResponseSchema,
    STOCK_COMMUNITY_SOURCE_ID,
  );

  return response.data;
}

export async function resolvePublicCommunityReaction(
  requestedStockCode: string,
  requestedCompanyName: string,
): Promise<CommunityLookupResult> {
  const { stockCode, companyName } = validateInput(
    requestedStockCode,
    requestedCompanyName,
  );
  const diagnostics: SourceDiagnostic[] = [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const community: CommunityPost[] = [];
  const capturedAt = new Date().toISOString();
  let page = 1;

  while (
    page <= COMMUNITY_PAGE_LIMIT &&
    community.length < COMMUNITY_RESULTS_LIMIT
  ) {
    const searchPage = await fetchCommunityPage(companyName, page);

    if (searchPage.searchedEntries.length === 0) {
      break;
    }

    for (const entry of searchPage.searchedEntries) {
      if (!isRelevantEntry(entry, companyName, stockCode)) {
        continue;
      }

      const canonicalUrl = canonicalizeEntryUrl(entry.entryUrl);

      if (!canonicalUrl) {
        diagnostics.push(
          createDiagnostic({
            code: "discarded-invalid-url",
            message: `Discarded community result "${entry.entryTitle}" because it was missing a valid URL.`,
            severity: "warning",
          }),
        );
        continue;
      }

      const titleKey = normalizeTitleForDedup(entry.entryTitle);

      if (seenUrls.has(canonicalUrl) || seenTitles.has(titleKey)) {
        diagnostics.push(
          createDiagnostic({
            code: "discarded-duplicate-post",
            message: `Discarded duplicate community post "${entry.entryTitle}".`,
            severity: "info",
          }),
        );
        continue;
      }

      const excerpt = buildExcerpt(entry.entrySummary, entry.entryTitle);
      const validationResult = communityPostSchema.safeParse({
        id: buildPostId(canonicalUrl, entry.entryTitle),
        source: buildPostSource(entry, canonicalUrl),
        title: cleanText(entry.entryTitle),
        excerpt,
        publishedAt: entry.entryPublished,
        url: canonicalUrl,
        engagement: {
          likes: entry.likeCount,
          comments: entry.commentCount,
        },
        sentiment: detectSentiment(entry.entryTitle, excerpt),
      });

      if (!validationResult.success) {
        diagnostics.push(
          createValidationDiagnostic(
            buildStructuredValidationError(validationResult.error, {
              entity: "communityPost",
              sourceId: STOCK_COMMUNITY_SOURCE_ID,
            }),
          ),
        );
        continue;
      }

      seenUrls.add(canonicalUrl);
      seenTitles.add(titleKey);
      community.push(validationResult.data);

      if (community.length >= COMMUNITY_RESULTS_LIMIT) {
        break;
      }
    }

    if (searchPage.nextPage === 0) {
      break;
    }

    page = searchPage.nextPage;
  }

  if (community.length === 0) {
    diagnostics.push(
      createDiagnostic({
        code: "no-community-posts",
        message: `Source ${STOCK_COMMUNITY_SOURCE_ID} returned no stock-specific public community posts for ${companyName}.`,
        severity: "warning",
      }),
    );
  }

  return communityLookupResultSchema.parse({
    stockCode,
    companyName,
    source: {
      source: STOCK_COMMUNITY_SOURCE_ID,
      capturedAt,
    },
    community,
    summary: summarizeCommunity(community, companyName),
    diagnostics,
    sourceStatus: buildCommunitySourceStatus(community.length, capturedAt),
  });
}
