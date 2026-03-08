import "server-only";

import { createHash } from "node:crypto";

import { load } from "cheerio";
import { z } from "zod";

import { env } from "./env";
import { describeFetchFailure } from "./fetch-failure";
import {
  buildStructuredValidationError,
  createValidationDiagnostic,
  disclosureItemSchema,
  disclosureLookupResultSchema,
  sourceDiagnosticSchema,
  stockQuerySchema,
  type DisclosureItem,
  type DisclosureLookupResult,
  type SourceDiagnostic,
  type StructuredValidationError,
} from "./normalized-schemas";
import { buildSourceDiagnostics } from "./source-registry";

export const STOCK_DISCLOSURE_SOURCE_ID = "krx-kind-disclosures";

const DISCLOSURE_RESULTS_LIMIT = 10;
const DISCLOSURE_LOOKBACK_DAYS = 365;

const stockDisclosureInputSchema = stockQuerySchema.pick({
  stockCode: true,
});

const kindCompanyLookupResponseSchema = z.array(
  z.object({
    comabbrv: z.string().trim().min(1),
    isurcd: z.string().trim().min(1),
    repisusrtcd: z.string().trim().min(1),
    repisusrtcd2: z.string().trim().min(1),
  }),
);

type FetchOptions = {
  method?: "GET" | "POST";
  sourceId: string;
  body?: URLSearchParams;
};

const marketNoticePatterns = [
  /가격제한폭/,
  /매매거래/,
  /투자주의/,
  /투자경고/,
  /투자위험/,
  /관리종목/,
  /시장조치/,
  /파생상품시장본부/,
];

const earningsPatterns = [
  /영업.?실적/,
  /실적/,
  /손익/,
  /결산/,
  /사업보고서/,
  /반기보고서/,
  /분기보고서/,
  /감사보고서/,
  /감사전/,
];

const shareholderReturnPatterns = [
  /배당/,
  /자사주/,
  /자기주식/,
  /소각/,
  /주주환원/,
];

const corporateActionPatterns = [
  /합병/,
  /분할/,
  /유상증자/,
  /무상증자/,
  /감자/,
  /주식교환/,
  /주식이전/,
  /영업양수/,
  /영업양도/,
  /단일판매/,
  /투자판단/,
];

const ownershipPatterns = [
  /최대주주/,
  /주요주주/,
  /임원/,
  /소유주식/,
  /대량보유/,
  /지분/,
];

const governancePatterns = [
  /주주총회/,
  /이사회/,
  /사외이사/,
  /지배구조/,
  /정관/,
  /대표이사/,
];

export class DisclosureLookupValidationError extends Error {
  readonly statusCode = 400;

  constructor(readonly validationError: StructuredValidationError) {
    super(validationError.summary);
    this.name = "DisclosureLookupValidationError";
  }
}

export class DisclosureLookupSourceError extends Error {
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
    this.name = "DisclosureLookupSourceError";
    this.statusCode = options?.statusCode ?? 502;
  }
}

function cleanText(value: string | undefined | null) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function stripCorrectionPrefix(title: string) {
  return cleanText(title).replace(/^\[(정정|기재정정)\]\s*/u, "");
}

function createDiagnostic(options: {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  validationErrors?: SourceDiagnostic["validationErrors"];
}) {
  return sourceDiagnosticSchema.parse({
    sourceId: STOCK_DISCLOSURE_SOURCE_ID,
    severity: options.severity,
    code: options.code,
    message: options.message,
    entity: "disclosureItem",
    validationErrors: options.validationErrors ?? [],
  });
}

function getRequestInit(options: FetchOptions) {
  return {
    method: options.method ?? "GET",
    body: options.body,
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
    response = await fetch(url, getRequestInit(options));
  } catch (error) {
    throw new DisclosureLookupSourceError(
      options.sourceId,
      describeFetchFailure(options.sourceId, error),
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new DisclosureLookupSourceError(
      options.sourceId,
      `Source ${options.sourceId} returned HTTP ${response.status}.`,
      { statusCode: response.status },
    );
  }

  return response.text();
}

async function fetchJsonFromSource<T>(
  url: string,
  schema: z.ZodType<T>,
  sourceId: string,
) {
  const text = await fetchTextFromSource(url, {
    sourceId,
  });

  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new DisclosureLookupSourceError(
      sourceId,
      `Source ${sourceId} returned an unreadable JSON payload.`,
      { cause: error },
    );
  }

  const parsedPayload = schema.safeParse(payload);

  if (!parsedPayload.success) {
    throw new DisclosureLookupSourceError(
      sourceId,
      `Source ${sourceId} returned an unexpected payload shape.`,
      { cause: parsedPayload.error },
    );
  }

  return parsedPayload.data;
}

function validateInput(stockCode: string) {
  const result = stockDisclosureInputSchema.safeParse({
    stockCode,
  });

  if (!result.success) {
    throw new DisclosureLookupValidationError(
      buildStructuredValidationError(result.error, {
        entity: "stockQuery",
      }),
    );
  }

  return result.data.stockCode;
}

async function resolveKindCompany(stockCode: string) {
  const url = new URL("https://kind.krx.co.kr/common/searchcorpname.do");

  url.search = new URLSearchParams({
    method: "searchCorpNameJson",
    searchCodeType: "number",
    searchCorpName: stockCode,
  }).toString();

  const response = await fetchJsonFromSource(
    url.toString(),
    kindCompanyLookupResponseSchema,
    STOCK_DISCLOSURE_SOURCE_ID,
  );
  const match = response.find(
    (item) =>
      item.repisusrtcd2 === stockCode ||
      item.repisusrtcd === stockCode ||
      item.repisusrtcd === `A${stockCode}`,
  );

  if (!match) {
    throw new DisclosureLookupValidationError(
      {
        entity: "stockQuery",
        sourceId: STOCK_DISCLOSURE_SOURCE_ID,
        summary: "Unknown stock code",
        issues: [
          {
            path: ["stockCode"],
            code: "custom",
            message: `Unknown stock code "${stockCode}". Confirm the listed Korean stock code and try again.`,
          },
        ],
      },
    );
  }

  return {
    companyName: match.comabbrv,
    repIsuSrtCd: match.repisusrtcd,
  };
}

function formatKindDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const date = String(value.getDate()).padStart(2, "0");

  return `${year}${month}${date}`;
}

function buildDateWindow(anchorDate: Date) {
  const startDate = new Date(anchorDate);
  startDate.setDate(anchorDate.getDate() - DISCLOSURE_LOOKBACK_DAYS);

  return {
    fromDate: formatKindDate(startDate),
    toDate: formatKindDate(anchorDate),
  };
}

function parsePublishedAt(value: string) {
  const normalized = cleanText(value);
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/,
  );

  if (!match) {
    return null;
  }

  const [, year, month, date, hour, minute] = match;
  return `${year}-${month}-${date}T${hour}:${minute}:00+09:00`;
}

function extractReceiptNumber(onclickValue: string | undefined) {
  const normalized = cleanText(onclickValue);
  const match = normalized.match(/openDisclsViewer\('(\d+)','([^']*)'\)/);

  if (!match) {
    return null;
  }

  return {
    acptNo: match[1],
    docNo: match[2],
  };
}

function normalizeTitleForId(title: string) {
  return stripCorrectionPrefix(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function inferDisclosureCategory(title: string) {
  const normalized = stripCorrectionPrefix(title);

  if (marketNoticePatterns.some((pattern) => pattern.test(normalized))) {
    return "market-notice";
  }

  if (earningsPatterns.some((pattern) => pattern.test(normalized))) {
    return "earnings";
  }

  if (shareholderReturnPatterns.some((pattern) => pattern.test(normalized))) {
    return "shareholder-return";
  }

  if (corporateActionPatterns.some((pattern) => pattern.test(normalized))) {
    return "corporate-action";
  }

  if (ownershipPatterns.some((pattern) => pattern.test(normalized))) {
    return "ownership";
  }

  if (governancePatterns.some((pattern) => pattern.test(normalized))) {
    return "governance";
  }

  return "general";
}

function inferDisclosureImportance(title: string): DisclosureItem["importance"] {
  const category = inferDisclosureCategory(title);

  if (
    category === "earnings" ||
    category === "shareholder-return" ||
    category === "corporate-action"
  ) {
    return "high";
  }

  if (category === "ownership" || category === "governance") {
    return "medium";
  }

  return "low";
}

function buildDisclosureId(receiptNumber: string, title: string) {
  const titleKey = normalizeTitleForId(title);

  if (titleKey) {
    return `${receiptNumber}-${titleKey.slice(0, 40)}`;
  }

  return createHash("sha1").update(receiptNumber).digest("hex").slice(0, 16);
}

function buildDisclosureUrl(acptNo: string, docNo: string) {
  const url = new URL("https://kind.krx.co.kr/common/disclsviewer.do");

  url.search = new URLSearchParams({
    method: "search",
    acptno: acptNo,
    docno: docNo,
  }).toString();

  return url.toString();
}

async function fetchDisclosureMarkup(
  companyName: string,
  repIsuSrtCd: string,
) {
  const url = "https://kind.krx.co.kr/disclosure/searchdisclosurebycorp.do";
  const anchorDate = new Date();
  const { fromDate, toDate } = buildDateWindow(anchorDate);

  return {
    capturedAt: anchorDate.toISOString(),
    markup: await fetchTextFromSource(url, {
      method: "POST",
      sourceId: STOCK_DISCLOSURE_SOURCE_ID,
      body: new URLSearchParams({
        method: "searchDisclosureByCorpSub",
        forward: "searchdisclosurebycorp_sub",
        searchCorpName: companyName,
        repIsuSrtCd,
        fromDate,
        toDate,
        orderMode: "1",
        orderStat: "D",
        currentPageSize: String(DISCLOSURE_RESULTS_LIMIT),
        pageIndex: "1",
      }),
    }),
  };
}

function buildDisclosureSourceStatus(
  disclosureCount: number,
  capturedAt: string,
  highImportanceCount: number,
) {
  return buildSourceDiagnostics({
    enabledCategories: ["disclosure"],
  })
    .filter((status) => status.category === "disclosure")
    .map((status) => ({
      ...status,
      status: "ready" as const,
      notes: [
        ...status.notes,
        `Captured ${disclosureCount} normalized disclosures at ${capturedAt}.`,
        highImportanceCount > 0
          ? `${highImportanceCount} disclosures were labeled high importance for downstream evidence weighting.`
          : "No high-importance disclosures were identified in the latest pull.",
      ],
    }));
}

export async function resolveRecentDisclosures(
  requestedStockCode: string,
): Promise<DisclosureLookupResult> {
  const stockCode = validateInput(requestedStockCode);
  const diagnostics: SourceDiagnostic[] = [];
  const { companyName, repIsuSrtCd } = await resolveKindCompany(stockCode);
  const { markup, capturedAt } = await fetchDisclosureMarkup(companyName, repIsuSrtCd);
  const $ = load(markup);
  const rows = $("table.list.type-00 tbody tr").toArray();
  const disclosures: DisclosureItem[] = [];

  if (rows.length === 0) {
    diagnostics.push(
      createDiagnostic({
        code: "no-disclosures",
        message: `Source ${STOCK_DISCLOSURE_SOURCE_ID} returned no recent disclosures for ${companyName}.`,
        severity: "warning",
      }),
    );
  }

  for (const row of rows) {
    const cells = $(row).children("td");

    if (!cells.length || cells.first().hasClass("null")) {
      continue;
    }

    const publishedAt = parsePublishedAt(cleanText(cells.eq(1).text()));
    const titleAnchor = cells.eq(3).find("a").first();
    const title = cleanText(titleAnchor.text());
    const receiptNumber = extractReceiptNumber(titleAnchor.attr("onclick"));

    if (!publishedAt) {
      diagnostics.push(
        createDiagnostic({
          code: "discarded-invalid-published-at",
          message: `Discarded disclosure "${title || "unknown"}" because it was missing a valid timestamp.`,
          severity: "warning",
        }),
      );
      continue;
    }

    if (!title || !receiptNumber) {
      diagnostics.push(
        createDiagnostic({
          code: "discarded-invalid-disclosure-row",
          message: "Discarded a KIND disclosure row because it was missing a receipt number or title.",
          severity: "warning",
        }),
      );
      continue;
    }

    const normalizedDisclosure = disclosureItemSchema.safeParse({
      id: buildDisclosureId(receiptNumber.acptNo, title),
      source: STOCK_DISCLOSURE_SOURCE_ID,
      category: inferDisclosureCategory(title),
      title,
      publishedAt,
      url: buildDisclosureUrl(receiptNumber.acptNo, receiptNumber.docNo),
      importance: inferDisclosureImportance(title),
    });

    if (!normalizedDisclosure.success) {
      diagnostics.push(
        createValidationDiagnostic(
          buildStructuredValidationError(normalizedDisclosure.error, {
            entity: "disclosureItem",
            sourceId: STOCK_DISCLOSURE_SOURCE_ID,
          }),
        ),
      );
      continue;
    }

    disclosures.push(normalizedDisclosure.data);
  }

  if (disclosures.length === 0 && diagnostics.length === 0) {
    diagnostics.push(
      createDiagnostic({
        code: "no-disclosures",
        message: `Source ${STOCK_DISCLOSURE_SOURCE_ID} returned no recent disclosures for ${companyName}.`,
        severity: "warning",
      }),
    );
  }

  const sortedDisclosures = disclosures
    .sort((left, right) => {
      const importanceWeight = { high: 2, medium: 1, low: 0 };
      const importanceDelta =
        importanceWeight[right.importance] - importanceWeight[left.importance];

      if (importanceDelta !== 0) {
        return importanceDelta;
      }

      return Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
    })
    .slice(0, DISCLOSURE_RESULTS_LIMIT);
  const highImportanceCount = sortedDisclosures.filter(
    (item) => item.importance === "high",
  ).length;

  return disclosureLookupResultSchema.parse({
    stockCode,
    companyName,
    source: {
      source: STOCK_DISCLOSURE_SOURCE_ID,
      capturedAt,
    },
    disclosures: sortedDisclosures,
    diagnostics,
    sourceStatus: buildDisclosureSourceStatus(
      sortedDisclosures.length,
      capturedAt,
      highImportanceCount,
    ),
  });
}
