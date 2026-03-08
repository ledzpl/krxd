import "server-only";

import { load } from "cheerio";

import { env } from "./env";
import { describeFetchFailure } from "./fetch-failure";
import {
  buildStructuredValidationError,
  financialLookupResultSchema,
  financialSnapshotSchema,
  sourceDiagnosticSchema,
  stockQuerySchema,
  type FinancialLookupResult,
  type FinancialSnapshot,
  type SourceDiagnostic,
  type StructuredValidationError,
} from "./normalized-schemas";
import { buildSourceDiagnostics } from "./source-registry";

export const STOCK_FINANCIAL_SOURCE_ID = "public-financial-statements";

const stockFinancialInputSchema = stockQuerySchema.pick({
  stockCode: true,
});

const DAY_IN_MS = 24 * 60 * 60 * 1000;

type FinancialPeriod = {
  estimated: boolean;
  index: number;
  period: string;
  section: "annual" | "quarterly";
};

type ParsedFinancialTable = {
  companyName: string;
  missingFields: Array<keyof Omit<FinancialSnapshot, "source" | "fiscalPeriod" | "capturedAt">>;
  periods: FinancialPeriod[];
  snapshot: FinancialSnapshot;
  usedAnnualFallback: boolean;
};

export class FinancialLookupValidationError extends Error {
  readonly statusCode = 400;

  constructor(readonly validationError: StructuredValidationError) {
    super(validationError.summary);
    this.name = "FinancialLookupValidationError";
  }
}

export class FinancialLookupSourceError extends Error {
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
    this.name = "FinancialLookupSourceError";
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
    sourceId: STOCK_FINANCIAL_SOURCE_ID,
    severity: options.severity,
    code: options.code,
    message: options.message,
    entity: "financialSnapshot",
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

async function fetchTextFromSource(url: string) {
  let response: Response;

  try {
    response = await fetch(url, getRequestInit());
  } catch (error) {
    throw new FinancialLookupSourceError(
      STOCK_FINANCIAL_SOURCE_ID,
      describeFetchFailure(STOCK_FINANCIAL_SOURCE_ID, error),
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new FinancialLookupSourceError(
      STOCK_FINANCIAL_SOURCE_ID,
      `Source ${STOCK_FINANCIAL_SOURCE_ID} returned HTTP ${response.status}.`,
      { statusCode: response.status },
    );
  }

  return response.text();
}

function validateInput(stockCode: string) {
  const result = stockFinancialInputSchema.safeParse({
    stockCode,
  });

  if (!result.success) {
    throw new FinancialLookupValidationError(
      buildStructuredValidationError(result.error, {
        entity: "stockQuery",
      }),
    );
  }

  return result.data.stockCode;
}

function extractCompanyName($: ReturnType<typeof load>) {
  const heading =
    cleanText($(".wrap_company h2 a").first().text()) ||
    cleanText($(".wrap_company h2").first().text());

  if (heading) {
    return heading;
  }

  const title = cleanText($("title").first().text());

  if (!title) {
    throw new FinancialLookupSourceError(
      STOCK_FINANCIAL_SOURCE_ID,
      `Source ${STOCK_FINANCIAL_SOURCE_ID} returned markup without a recognizable company name.`,
    );
  }

  const [name] = title.split(":");
  const normalized = cleanText(name);

  if (!normalized) {
    throw new FinancialLookupSourceError(
      STOCK_FINANCIAL_SOURCE_ID,
      `Source ${STOCK_FINANCIAL_SOURCE_ID} returned markup without a recognizable company name.`,
    );
  }

  return normalized;
}

function parseNumberValue(value: string) {
  const normalized = cleanText(value).replace(/,/g, "");

  if (!normalized || normalized === "-" || normalized === "N/A") {
    return null;
  }

  if (!/^[-+]?\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }

  return Number(normalized);
}

function parseHeaderPeriods($: ReturnType<typeof load>) {
  const headerRows = $(".cop_analysis table.tb_type1_ifrs thead tr");

  if (headerRows.length < 2) {
    throw new FinancialLookupSourceError(
      STOCK_FINANCIAL_SOURCE_ID,
      `Source ${STOCK_FINANCIAL_SOURCE_ID} returned an incomplete financial table header.`,
    );
  }

  const annualCount = Number(
    cleanText(headerRows.eq(0).children("th").eq(1).attr("colspan")) || "0",
  );
  const periodHeaders = headerRows
    .eq(1)
    .children("th")
    .toArray()
    .map((element, index) => {
      const th = $(element);
      const estimated = th.find("em").text().includes("(E)");
      const periodText = cleanText(th.text()).replace(/\(E\)/g, "");

      return {
        estimated,
        index,
        period: periodText,
        section: index < annualCount ? ("annual" as const) : ("quarterly" as const),
      };
    })
    .filter((header) => header.period);

  if (periodHeaders.length === 0) {
    throw new FinancialLookupSourceError(
      STOCK_FINANCIAL_SOURCE_ID,
      `Source ${STOCK_FINANCIAL_SOURCE_ID} returned no fiscal periods.`,
    );
  }

  return periodHeaders;
}

function parseMetricRows($: ReturnType<typeof load>) {
  const metrics = new Map<string, Array<number | null>>();

  $(".cop_analysis table.tb_type1_ifrs tbody tr").each((_, element) => {
    const row = $(element);
    const label = cleanText(row.children("th").first().text());

    if (!label) {
      return;
    }

    const values = row
      .children("td")
      .toArray()
      .map((cell) => parseNumberValue($(cell).text()));

    metrics.set(label, values);
  });

  return metrics;
}

function selectFinancialPeriod(periods: FinancialPeriod[]) {
  const latestQuarterlyActual = [...periods]
    .reverse()
    .find((period) => period.section === "quarterly" && !period.estimated);

  if (latestQuarterlyActual) {
    return {
      period: latestQuarterlyActual,
      usedAnnualFallback: false,
    };
  }

  const latestAnnualActual = [...periods]
    .reverse()
    .find((period) => period.section === "annual" && !period.estimated);

  if (!latestAnnualActual) {
    throw new FinancialLookupSourceError(
      STOCK_FINANCIAL_SOURCE_ID,
      `Source ${STOCK_FINANCIAL_SOURCE_ID} returned no non-estimate financial period.`,
    );
  }

  return {
    period: latestAnnualActual,
    usedAnnualFallback: true,
  };
}

function getMetricValue(
  metrics: Map<string, Array<number | null>>,
  label: string,
  index: number,
) {
  return metrics.get(label)?.[index] ?? null;
}

function parseFinancialTable(markup: string, capturedAt: string): ParsedFinancialTable {
  const $ = load(markup);
  const companyName = extractCompanyName($);
  const periods = parseHeaderPeriods($);
  const metrics = parseMetricRows($);
  const selection = selectFinancialPeriod(periods);
  const snapshot = financialSnapshotSchema.safeParse({
    source: STOCK_FINANCIAL_SOURCE_ID,
    fiscalPeriod: selection.period.period,
    revenue: getMetricValue(metrics, "매출액", selection.period.index),
    operatingProfit: getMetricValue(metrics, "영업이익", selection.period.index),
    netIncome: getMetricValue(metrics, "당기순이익", selection.period.index),
    eps: getMetricValue(metrics, "EPS(원)", selection.period.index),
    bps: getMetricValue(metrics, "BPS(원)", selection.period.index),
    per: getMetricValue(metrics, "PER(배)", selection.period.index),
    pbr: getMetricValue(metrics, "PBR(배)", selection.period.index),
    capturedAt,
  });

  if (!snapshot.success) {
    throw new FinancialLookupSourceError(
      STOCK_FINANCIAL_SOURCE_ID,
      `Source ${STOCK_FINANCIAL_SOURCE_ID} returned an invalid financial snapshot.`,
      { cause: snapshot.error },
    );
  }

  const missingFields = (
    Object.entries(snapshot.data).filter(
      ([key, value]) =>
        key !== "source" &&
        key !== "fiscalPeriod" &&
        key !== "capturedAt" &&
        value === null,
    ) as Array<
      [
        keyof Omit<FinancialSnapshot, "source" | "fiscalPeriod" | "capturedAt">,
        FinancialSnapshot[keyof FinancialSnapshot],
      ]
    >
  ).map(([key]) => key);

  return {
    companyName,
    missingFields,
    periods,
    snapshot: snapshot.data,
    usedAnnualFallback: selection.usedAnnualFallback,
  };
}

function getPeriodEndDate(period: string) {
  const match = period.match(/^(\d{4})\.(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  return new Date(Date.UTC(year, month, 0, 14, 59, 59));
}

function isFinancialSnapshotStale(period: string, capturedAt: string) {
  const periodEnd = getPeriodEndDate(period);

  if (!periodEnd) {
    return false;
  }

  return (
    (Date.parse(capturedAt) - periodEnd.getTime()) / DAY_IN_MS >
    env.FINANCIAL_FRESHNESS_DAYS
  );
}

function formatMetricLabel(metric: string) {
  switch (metric) {
    case "operatingProfit":
      return "operating profit";
    case "netIncome":
      return "net income";
    default:
      return metric.toLowerCase();
  }
}

function buildFinancialSourceStatus(options: {
  capturedAt: string;
  fiscalPeriod: string;
  missingFields: string[];
  stale: boolean;
}) {
  const statusDiagnostics: SourceDiagnostic[] = [];

  if (options.stale) {
    statusDiagnostics.push(
      createDiagnostic({
        code: "stale-financial-period",
        message: `Financial data for ${options.fiscalPeriod} is older than the configured ${env.FINANCIAL_FRESHNESS_DAYS}-day threshold.`,
        severity: "warning",
      }),
    );
  }

  if (options.missingFields.length > 0) {
    statusDiagnostics.push(
      createDiagnostic({
        code: "missing-financial-metrics",
        message: `Financial snapshot is missing ${options.missingFields.join(", ")}.`,
        severity: "warning",
      }),
    );
  }

  return buildSourceDiagnostics({
    enabledCategories: ["financial"],
  })
    .filter((status) => status.category === "financial")
    .map((status) => ({
      ...status,
      status: options.stale ? ("stale" as const) : ("ready" as const),
      notes: [
        ...status.notes,
        `Selected ${options.fiscalPeriod} as the latest non-estimate fiscal period at ${options.capturedAt}.`,
        options.missingFields.length > 0
          ? `Missing metrics: ${options.missingFields.join(", ")}.`
          : "All tracked profitability and valuation metrics were available.",
      ],
      diagnostics: [...status.diagnostics, ...statusDiagnostics],
    }));
}

export async function resolveFinancialSummary(
  requestedStockCode: string,
): Promise<FinancialLookupResult> {
  const stockCode = validateInput(requestedStockCode);
  const capturedAt = new Date().toISOString();
  const diagnostics: SourceDiagnostic[] = [];
  const markup = await fetchTextFromSource(
    `https://finance.naver.com/item/main.naver?code=${stockCode}`,
  );
  const parsedFinancials = parseFinancialTable(markup, capturedAt);
  const stale = isFinancialSnapshotStale(
    parsedFinancials.snapshot.fiscalPeriod,
    capturedAt,
  );
  const latestQuarterPeriod = [...parsedFinancials.periods]
    .reverse()
    .find((period) => period.section === "quarterly" && !period.estimated);

  if (latestQuarterPeriod && latestQuarterPeriod.period !== parsedFinancials.snapshot.fiscalPeriod) {
    diagnostics.push(
      createDiagnostic({
        code: "fallback-financial-period",
        message: `Used ${parsedFinancials.snapshot.fiscalPeriod} because a newer non-estimate quarterly period was unavailable.`,
        severity: "info",
      }),
    );
  }

  if (parsedFinancials.usedAnnualFallback) {
    diagnostics.push(
      createDiagnostic({
        code: "annual-fallback",
        message: `Quarterly financial data was unavailable, so ${parsedFinancials.snapshot.fiscalPeriod} annual data was used.`,
        severity: "warning",
      }),
    );
  }

  if (stale) {
    diagnostics.push(
      createDiagnostic({
        code: "stale-financial-period",
        message: `Financial data for ${parsedFinancials.snapshot.fiscalPeriod} is stale and should reduce long-horizon confidence.`,
        severity: "warning",
      }),
    );
  }

  if (parsedFinancials.missingFields.length > 0) {
    diagnostics.push(
      createDiagnostic({
        code: "missing-financial-metrics",
        message: `Financial snapshot is missing ${parsedFinancials.missingFields
          .map((field) => formatMetricLabel(field))
          .join(", ")}.`,
        severity: "warning",
      }),
    );
  }

  return financialLookupResultSchema.parse({
    stockCode,
    companyName: parsedFinancials.companyName,
    source: {
      source: STOCK_FINANCIAL_SOURCE_ID,
      capturedAt,
    },
    financials: [parsedFinancials.snapshot],
    diagnostics,
    sourceStatus: buildFinancialSourceStatus({
      capturedAt,
      fiscalPeriod: parsedFinancials.snapshot.fiscalPeriod,
      missingFields: parsedFinancials.missingFields.map((field) =>
        formatMetricLabel(field),
      ),
      stale,
    }),
  });
}
