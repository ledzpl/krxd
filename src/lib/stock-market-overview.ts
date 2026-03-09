import "server-only";

import { load } from "cheerio";

import { env } from "./env";
import { describeFetchFailure, mapUpstreamStatusCode } from "./fetch-failure";
import {
  marketOverviewSchema,
  type MarketOverview,
} from "./normalized-schemas";

export const MARKET_OVERVIEW_SOURCE_ID = "naver-market-overview";

function cleanText(value: string | undefined | null) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function parseNumberFromText(value: string) {
  const normalized = cleanText(value).replace(/,/g, "").replace(/원|주|%|배/g, "");
  if (!normalized || normalized === "-" || normalized === "N/A") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVolumeFromBillions(value: string) {
  const cleaned = cleanText(value).replace(/,/g, "");
  const billionMatch = cleaned.match(/([-+]?[\d,.]+)\s*억/);
  if (billionMatch) {
    const num = Number(billionMatch[1].replace(/,/g, ""));
    return Number.isFinite(num) ? num * 100_000_000 : null;
  }
  const trillionMatch = cleaned.match(/([-+]?[\d,.]+)\s*조/);
  if (trillionMatch) {
    const num = Number(trillionMatch[1].replace(/,/g, ""));
    return Number.isFinite(num) ? num * 1_000_000_000_000 : null;
  }
  return parseNumberFromText(value);
}

function getRequestInit() {
  return {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": env.DEFAULT_USER_AGENT,
    },
    signal: AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
    next: { revalidate: env.CACHE_TTL_SECONDS },
  };
}

export async function resolveMarketOverview(
  stockCode: string,
): Promise<MarketOverview> {
  const capturedAt = new Date().toISOString();
  let markup: string;

  try {
    const response = await fetch(
      `https://finance.naver.com/item/main.naver?code=${stockCode}`,
      getRequestInit(),
    );
    if (!response.ok) {
      return buildEmptyOverview(capturedAt);
    }
    markup = await response.text();
  } catch {
    return buildEmptyOverview(capturedAt);
  }

  try {
    return parseMarketOverview(markup, capturedAt);
  } catch {
    return buildEmptyOverview(capturedAt);
  }
}

function buildEmptyOverview(capturedAt: string): MarketOverview {
  return marketOverviewSchema.parse({
    week52High: null,
    week52Low: null,
    dividendYield: null,
    foreignOwnershipPercent: null,
    sectorName: null,
    marketCap: null,
    foreignNetVolume: null,
    institutionalNetVolume: null,
    capturedAt,
  });
}

function parseMarketOverview(markup: string, capturedAt: string): MarketOverview {
  const $ = load(markup);

  let week52High: number | null = null;
  let week52Low: number | null = null;
  let dividendYield: number | null = null;
  let foreignOwnershipPercent: number | null = null;
  let sectorName: string | null = null;
  let marketCap: number | null = null;
  let foreignNetVolume: number | null = null;
  let institutionalNetVolume: number | null = null;

  // 52-week high/low from aside_invest_info or tab_con1
  $("table").each((_, table) => {
    $(table).find("tr").each((_, tr) => {
      const thText = cleanText($(tr).find("th, td:first-child").first().text());
      const tdTexts = $(tr).find("td").toArray().map((td) => cleanText($(td).text()));

      if (thText.includes("52주 최고") || thText.includes("52주최고")) {
        week52High = parseNumberFromText(tdTexts[0] ?? "");
      }
      if (thText.includes("52주 최저") || thText.includes("52주최저")) {
        week52Low = parseNumberFromText(tdTexts[0] ?? "");
      }
      if (thText.includes("시가총액")) {
        marketCap = parseVolumeFromBillions(tdTexts[0] ?? "");
      }
      if (thText.includes("배당수익률") || thText.includes("배당률")) {
        dividendYield = parseNumberFromText(tdTexts[0] ?? "");
      }
      if (thText.includes("외국인소진율") || thText.includes("외국인")) {
        const val = parseNumberFromText(tdTexts[0] ?? "");
        if (val !== null && val <= 100) foreignOwnershipPercent = val;
      }
    });
  });

  // Sector from description area
  const descriptionText = cleanText($(".sub_tit7 a, .h_company .sub_tit a, .section_cop_info dt a").first().text());
  if (descriptionText) sectorName = descriptionText;

  // Try to get sector from breadcrumb-like elements
  if (!sectorName) {
    $("a[href*='sise_group']").each((_, el) => {
      const text = cleanText($(el).text());
      if (text && text.length > 1 && text.length < 20) {
        sectorName = text;
        return false;
      }
    });
  }

  // Foreign/institutional investor data from the page
  $("table.type2, table.type_1").each((_, table) => {
    const headerText = cleanText($(table).prev("h4, h3, .h_sub").text());
    if (headerText.includes("투자자") || headerText.includes("매매동향")) {
      $(table).find("tr").each((_, tr) => {
        const label = cleanText($(tr).find("th").first().text());
        const values = $(tr).find("td").toArray().map((td) => cleanText($(td).text()));
        if (label.includes("외국인") && values.length > 0) {
          foreignNetVolume = parseVolumeFromBillions(values[0]);
        }
        if ((label.includes("기관") || label.includes("투신")) && values.length > 0) {
          institutionalNetVolume = parseVolumeFromBillions(values[0]);
        }
      });
    }
  });

  // Fallback: try parsing from inline text patterns
  const fullText = $.text();
  if (week52High === null) {
    const highMatch = fullText.match(/52주\s*최고[^\d]*([\d,]+)/);
    if (highMatch) week52High = parseNumberFromText(highMatch[1]);
  }
  if (week52Low === null) {
    const lowMatch = fullText.match(/52주\s*최저[^\d]*([\d,]+)/);
    if (lowMatch) week52Low = parseNumberFromText(lowMatch[1]);
  }
  if (foreignOwnershipPercent === null) {
    const foreignMatch = fullText.match(/외국인소진율[^\d]*([\d.]+)%?/);
    if (foreignMatch) {
      const val = parseNumberFromText(foreignMatch[1]);
      if (val !== null && val <= 100) foreignOwnershipPercent = val;
    }
  }
  if (dividendYield === null) {
    const divMatch = fullText.match(/배당수익률[^\d]*([\d.]+)%?/);
    if (divMatch) dividendYield = parseNumberFromText(divMatch[1]);
  }

  return marketOverviewSchema.parse({
    week52High,
    week52Low,
    dividendYield,
    foreignOwnershipPercent,
    sectorName,
    marketCap,
    foreignNetVolume,
    institutionalNetVolume,
    capturedAt,
  });
}
