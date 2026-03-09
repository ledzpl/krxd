import "server-only";

import { load } from "cheerio";
import { z } from "zod";

import { env } from "./env";
import { describeFetchFailure, mapUpstreamStatusCode } from "./fetch-failure";
import {
  buildStructuredValidationError,
  createStructuredValidationError,
  quoteSnapshotSchema,
  quoteLookupResultSchema,
  stockQuerySchema,
  type QuoteSnapshot,
  type QuoteLookupResult,
  type StructuredValidationError,
} from "./normalized-schemas";

export const STOCK_RESOLUTION_SOURCE_ID = "krx-stock-code-resolver";
export const STOCK_RESOLUTION_FALLBACK_SOURCE_ID = "naver-item-page-resolver";
export const STOCK_QUOTE_SOURCE_ID = "naver-domestic-market-data";

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_IN_MS = 9 * 60 * 60 * 1000;
const TREND_SERIES_POINTS = 120;

const stockCodeInputSchema = stockQuerySchema.pick({
  stockCode: true,
});

const krxResolutionResponseSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
  result: z.array(
    z.object({
      isu_srt_cd: z.array(z.string().trim().min(1)).min(1),
      isu_abbrv: z.array(z.string().trim().min(1)).min(1),
      mkt_nm: z.array(z.string().trim().min(1)).min(1),
    }),
  ),
});

const naverRealtimeItemSchema = z.object({
  cd: z.string().trim().min(1),
  nv: z.coerce.number().nonnegative(),
  cv: z.coerce.number(),
  cr: z.coerce.number(),
  aq: z.coerce.number().int().nonnegative(),
});

const naverRealtimeResponseSchema = z.object({
  resultCode: z.literal("success"),
  result: z.object({
    areas: z.array(
      z.object({
        name: z.string().trim().min(1),
        datas: z.array(naverRealtimeItemSchema),
      }),
    ),
    time: z.coerce.number().int().positive(),
  }),
});

const naverTrendSeriesSchema = z.array(
  z.object({
    localDateTime: z.string().regex(/^\d{14}$/),
    currentPrice: z.coerce.number().nonnegative(),
  }),
);

type FetchOptions = {
  sourceId: string;
  encoding?: "utf-8" | "euc-kr";
  accept?: string;
};

export type ResolvedStockListing = {
  stockCode: string;
  companyName: string;
  market: string;
  capturedAt: string;
  sourceId: string;
  primaryFailureMessage?: string;
};

export class QuoteLookupValidationError extends Error {
  readonly statusCode = 400;

  constructor(readonly validationError: StructuredValidationError) {
    super(validationError.summary);
    this.name = "QuoteLookupValidationError";
  }
}

export class QuoteLookupSourceError extends Error {
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
    this.name = "QuoteLookupSourceError";
    this.statusCode = options?.statusCode ?? 502;
  }
}

function buildValidationIssue(message: string) {
  return [
    {
      path: ["stockCode"],
      code: "custom",
      message,
    },
  ];
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

async function readJsonResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  options: FetchOptions,
) {
  const text =
    options.encoding === "euc-kr"
      ? new TextDecoder("euc-kr").decode(await response.arrayBuffer())
      : await response.text();

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new QuoteLookupSourceError(
      options.sourceId,
      `Source ${options.sourceId} returned an unreadable JSON payload.`,
      { cause: error },
    );
  }

  const parsedResult = schema.safeParse(parsedJson);

  if (!parsedResult.success) {
    throw new QuoteLookupSourceError(
      options.sourceId,
      `Source ${options.sourceId} returned an unexpected payload shape.`,
      { cause: parsedResult.error },
    );
  }

  return parsedResult.data;
}

async function fetchJsonFromSource<T>(
  url: string,
  schema: z.ZodType<T>,
  options: FetchOptions,
) {
  let response: Response;

  try {
    response = await fetch(url, {
      ...getRequestInit(),
      headers: {
        ...getRequestInit().headers,
        accept: options.accept ?? getRequestInit().headers.accept,
      },
    });
  } catch (error) {
    throw new QuoteLookupSourceError(
      options.sourceId,
      describeFetchFailure(options.sourceId, error),
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new QuoteLookupSourceError(
      options.sourceId,
      `Source ${options.sourceId} returned HTTP ${response.status}.`,
      { statusCode: mapUpstreamStatusCode(response.status) },
    );
  }

  return readJsonResponse(response, schema, options);
}

async function fetchTextFromSource(url: string, options: FetchOptions) {
  let response: Response;

  try {
    response = await fetch(url, {
      ...getRequestInit(),
      headers: {
        ...getRequestInit().headers,
        accept: options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
  } catch (error) {
    throw new QuoteLookupSourceError(
      options.sourceId,
      describeFetchFailure(options.sourceId, error),
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new QuoteLookupSourceError(
      options.sourceId,
      `Source ${options.sourceId} returned HTTP ${response.status}.`,
      { statusCode: mapUpstreamStatusCode(response.status) },
    );
  }

  return response.text();
}

function toKstDateStamp(value: Date) {
  const shifted = new Date(value.getTime() + KST_OFFSET_IN_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const date = String(shifted.getUTCDate()).padStart(2, "0");

  return `${year}${month}${date}`;
}

function toIsoTimestampFromKst(localDateTime: string) {
  const year = localDateTime.slice(0, 4);
  const month = localDateTime.slice(4, 6);
  const date = localDateTime.slice(6, 8);
  const hour = localDateTime.slice(8, 10);
  const minute = localDateTime.slice(10, 12);
  const second = localDateTime.slice(12, 14);

  return `${year}-${month}-${date}T${hour}:${minute}:${second}+09:00`;
}

function buildTrendWindow(anchorDate: Date) {
  const endDate = toKstDateStamp(anchorDate);
  const startDate = toKstDateStamp(
    new Date(anchorDate.getTime() - DAY_IN_MS * 5),
  );

  return {
    startDateTime: `${startDate}0900`,
    endDateTime: `${endDate}1530`,
  };
}

function validateStockCode(stockCode: string) {
  const result = stockCodeInputSchema.safeParse({
    stockCode,
  });

  if (!result.success) {
    throw new QuoteLookupValidationError(
      buildStructuredValidationError(result.error, {
        entity: "stockQuery",
      }),
    );
  }

  return result.data.stockCode;
}

function cleanText(value: string | undefined | null) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMarketLabel(value: string | undefined | null) {
  const normalized = cleanText(value);

  if (normalized === "코스피") {
    return "KOSPI";
  }

  if (normalized === "코스닥") {
    return "KOSDAQ";
  }

  return normalized.toUpperCase();
}

async function resolveStockCodeViaKrx(stockCode: string) {
  const url = new URL(
    "https://data.krx.co.kr/comm/util/SearchEngine/isuCore.cmd",
  );

  url.search = new URLSearchParams({
    isAutoCom: "true",
    type: "",
    solrIsuType: "STK",
    solrKeyword: stockCode,
    rows: "20",
    start: "0",
  }).toString();

  const response = await fetchJsonFromSource(
    url.toString(),
    krxResolutionResponseSchema,
    {
      sourceId: STOCK_RESOLUTION_SOURCE_ID,
    },
  );

  const match = response.result.find(
    (item) => item.isu_srt_cd[0] === stockCode,
  );

  if (!match) {
    throw new QuoteLookupValidationError(
      createStructuredValidationError(
        {
          entity: "stockQuery",
          sourceId: STOCK_RESOLUTION_SOURCE_ID,
        },
        buildValidationIssue(
          `Unknown stock code "${stockCode}". Confirm the listed Korean stock code and try again.`,
        ),
        "Unknown stock code",
      ),
    );
  }

  return {
    companyName: match.isu_abbrv[0],
    market: match.mkt_nm[0],
    capturedAt: new Date().toISOString(),
    sourceId: STOCK_RESOLUTION_SOURCE_ID,
  };
}

function parseListingFromNaverItemPage(markup: string, stockCode: string) {
  const $ = load(markup);
  const companyName =
    cleanText($(".wrap_company h2 a").first().text()) ||
    cleanText($(".wrap_company h2").first().text()) ||
    cleanText($("meta[property='og:title']").attr("content")?.split("-")[0]) ||
    cleanText($("title").first().text().split(":")[0]);
  const marketFromBadge = normalizeMarketLabel(
    $(".wrap_company .description img[alt]").first().attr("alt"),
  );
  const descriptionText = [
    ...$(".description dd")
      .toArray()
      .map((element) => cleanText($(element).text())),
    cleanText($(".h_company .description").first().text()),
  ].find((value) => value.includes(stockCode) || /코스피|코스닥|KOSPI|KOSDAQ/.test(value));
  const marketMatch = descriptionText?.match(/(코스피|코스닥|KOSPI|KOSDAQ)/i);
  const marketFromDescription = normalizeMarketLabel(marketMatch?.[1]);
  const market =
    marketFromBadge || marketFromDescription || "";

  if (!companyName || !market) {
    throw new QuoteLookupSourceError(
      STOCK_RESOLUTION_FALLBACK_SOURCE_ID,
      `Source ${STOCK_RESOLUTION_FALLBACK_SOURCE_ID} returned markup without a recognizable company name or market.`,
    );
  }

  return {
    companyName,
    market,
    capturedAt: new Date().toISOString(),
    sourceId: STOCK_RESOLUTION_FALLBACK_SOURCE_ID,
  };
}

async function resolveStockCodeViaNaverItemPage(stockCode: string) {
  const markup = await fetchTextFromSource(
    `https://finance.naver.com/item/main.naver?code=${stockCode}`,
    {
      sourceId: STOCK_RESOLUTION_FALLBACK_SOURCE_ID,
    },
  );

  return parseListingFromNaverItemPage(markup, stockCode);
}

async function fetchQuoteSnapshot(stockCode: string) {
  const url =
    `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${stockCode}`;
  const response = await fetchJsonFromSource(
    url,
    naverRealtimeResponseSchema,
    {
      sourceId: STOCK_QUOTE_SOURCE_ID,
      encoding: "euc-kr",
    },
  );

  const quoteArea =
    response.result.areas.find((area) => area.name === "SERVICE_ITEM") ??
    response.result.areas[0];
  const quoteItem = quoteArea.datas.find((item) => item.cd === stockCode);

  if (!quoteItem) {
    throw new QuoteLookupSourceError(
      STOCK_QUOTE_SOURCE_ID,
      `Source ${STOCK_QUOTE_SOURCE_ID} did not return quote data for ${stockCode}.`,
    );
  }

  return {
    currentPrice: quoteItem.nv,
    // Naver realtime payload uses the opposite sign convention from the dashboard.
    changeAmount: -quoteItem.cv,
    changePercent: -quoteItem.cr,
    volume: quoteItem.aq,
    capturedAt: new Date(response.result.time).toISOString(),
  };
}

async function fetchTrendSeries(stockCode: string, anchorDate: Date) {
  const trendWindow = buildTrendWindow(anchorDate);
  const url = new URL(
    `https://api.stock.naver.com/chart/domestic/item/${stockCode}/minute5`,
  );

  url.search = new URLSearchParams(trendWindow).toString();

  const response = await fetchJsonFromSource(
    url.toString(),
    naverTrendSeriesSchema,
    {
      sourceId: STOCK_QUOTE_SOURCE_ID,
    },
  );

  const trendPoints = response
    .slice(-TREND_SERIES_POINTS)
    .map((point) => ({
      at: toIsoTimestampFromKst(point.localDateTime),
      price: point.currentPrice,
    }));

  if (trendPoints.length === 0) {
    throw new QuoteLookupSourceError(
      STOCK_QUOTE_SOURCE_ID,
      `Source ${STOCK_QUOTE_SOURCE_ID} returned no recent trend points for ${stockCode}.`,
    );
  }

  return trendPoints;
}

export async function resolveStockListing(
  requestedStockCode: string,
): Promise<ResolvedStockListing> {
  const stockCode = validateStockCode(requestedStockCode);

  try {
    const resolution = await resolveStockCodeViaKrx(stockCode);

    return {
      stockCode,
      companyName: resolution.companyName,
      market: resolution.market,
      capturedAt: resolution.capturedAt,
      sourceId: resolution.sourceId,
    };
  } catch (error) {
    if (error instanceof QuoteLookupValidationError) {
      throw error;
    }

    try {
      const fallbackResolution = await resolveStockCodeViaNaverItemPage(stockCode);

      return {
        stockCode,
        companyName: fallbackResolution.companyName,
        market: fallbackResolution.market,
        capturedAt: fallbackResolution.capturedAt,
        sourceId: fallbackResolution.sourceId,
        primaryFailureMessage:
          error instanceof Error ? error.message : "Primary resolver failed.",
      };
    } catch (fallbackError) {
      const primaryMessage =
        error instanceof Error ? error.message : "Primary resolver failed.";
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : "Fallback resolver failed.";

      throw new QuoteLookupSourceError(
        STOCK_RESOLUTION_SOURCE_ID,
        `${primaryMessage} Fallback resolver also failed: ${fallbackMessage}`,
        { cause: fallbackError },
      );
    }
  }
}

export async function resolveQuoteSnapshot(
  requestedStockCode: string,
): Promise<QuoteSnapshot> {
  const stockCode = validateStockCode(requestedStockCode);
  const trendAnchor = new Date();
  const [quoteSnapshot, trendResult] = await Promise.all([
    fetchQuoteSnapshot(stockCode),
    fetchTrendSeries(stockCode, trendAnchor).catch(() => [] as { at: string; price: number }[]),
  ]);

  return quoteSnapshotSchema.parse({
    source: STOCK_QUOTE_SOURCE_ID,
    currentPrice: quoteSnapshot.currentPrice,
    changeAmount: quoteSnapshot.changeAmount,
    changePercent: quoteSnapshot.changePercent,
    volume: quoteSnapshot.volume,
    trendPoints: trendResult,
    capturedAt: quoteSnapshot.capturedAt,
  });
}

export async function resolveQuoteLookup(
  requestedStockCode: string,
): Promise<QuoteLookupResult> {
  const listing = await resolveStockListing(requestedStockCode);
  const quote = await resolveQuoteSnapshot(listing.stockCode);

  return quoteLookupResultSchema.parse({
    stockCode: listing.stockCode,
    companyName: listing.companyName,
    market: listing.market,
    resolution: {
      source: listing.sourceId,
      capturedAt: listing.capturedAt,
    },
    quote,
  });
}
