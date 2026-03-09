import type { DashboardResult, SourceStatus } from "@/lib/normalized-schemas";

const DEFAULT_HORIZONS = ["1d", "1w", "1m"] as const;
const STOCK_RESOLUTION_SOURCE_ID = "krx-stock-code-resolver";
const STOCK_RESOLUTION_FALLBACK_SOURCE_ID = "naver-item-page-resolver";
const STOCK_QUOTE_SOURCE_ID = "naver-domestic-market-data";
const STOCK_NEWS_SOURCE_ID = "public-news-search";
const STOCK_COMMUNITY_SOURCE_ID = "tistory-public-blog-search";
const STOCK_DISCLOSURE_SOURCE_ID = "krx-kind-disclosures";
const STOCK_FINANCIAL_SOURCE_ID = "public-financial-statements";
const sourceLabels: Record<string, string> = {
  [STOCK_RESOLUTION_SOURCE_ID]: "KRX 종목 식별",
  [STOCK_RESOLUTION_FALLBACK_SOURCE_ID]: "네이버 종목 페이지 식별",
  [STOCK_QUOTE_SOURCE_ID]: "네이버 국내 시세",
  [STOCK_NEWS_SOURCE_ID]: "공개 뉴스 검색",
  [STOCK_COMMUNITY_SOURCE_ID]: "티스토리 공개 글 검색",
  [STOCK_DISCLOSURE_SOURCE_ID]: "KIND 공시",
  [STOCK_FINANCIAL_SOURCE_ID]: "공개 재무 데이터",
};
const enabledSourceLabels: Record<string, string> = {
  Quote: "시세",
  News: "뉴스",
  Community: "커뮤니티",
  Disclosures: "공시",
  Financials: "재무",
};
const communityThemeStopwords = new Set([
  "주식",
  "투자",
  "시장",
  "종목",
  "전망",
  "분석",
]);

export type DashboardState =
  | "empty"
  | "loading"
  | "success"
  | "partial-data"
  | "invalid-code"
  | "stale-data"
  | "all-sources-failed";

export const numberFormatter = new Intl.NumberFormat("ko-KR");
export const decimalFormatter = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const timestampFormatter = new Intl.DateTimeFormat("ko-KR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Seoul",
});

export function formatSourceLabel(sourceId: string) {
  return sourceLabels[sourceId] ?? sourceId;
}

export function getDashboardState(options: {
  error: {
    sourceStatus?: SourceStatus[];
  } | null;
  failedSourceCount: number;
  isInvalid: boolean;
  isLoading: boolean;
  result: DashboardResult | null;
  staleSourceCount: number;
  warnings: string[];
}): DashboardState {
  if (options.isLoading) {
    return "loading";
  }

  if (options.isInvalid) {
    return "invalid-code";
  }

  if (options.error?.sourceStatus?.length) {
    return "all-sources-failed";
  }

  if (!options.result) {
    return "empty";
  }

  if (options.staleSourceCount > 0) {
    return "stale-data";
  }

  if (options.failedSourceCount > 0 || options.warnings.length > 0) {
    return "partial-data";
  }

  return "success";
}

export function getMetricFallbackCopy(state: DashboardState, fallback: string) {
  if (state === "loading") {
    return "불러오는 중...";
  }

  if (state === "empty") {
    return fallback;
  }

  if (state === "invalid-code") {
    return "유효한 종목 코드가 필요합니다.";
  }

  if (state === "all-sources-failed") {
    return "사용 가능한 소스 데이터가 없습니다.";
  }

  return fallback;
}

export function getSectionStateCopy(state: DashboardState, successFallback: string) {
  switch (state) {
    case "loading":
      return "불러오는 중...";
    case "invalid-code":
      return "이 섹션을 보려면 유효한 6자리 종목 코드를 입력해 주세요.";
    case "all-sources-failed":
      return "이번 요청에서는 사용 중인 소스가 모두 실패했습니다. 하단 소스 상태를 확인해 주세요.";
    case "empty":
      return successFallback;
    default:
      return successFallback;
  }
}

export function formatDashboardState(state: DashboardState) {
  switch (state) {
    case "invalid-code":
      return "코드 오류";
    case "partial-data":
      return "일부 누락";
    case "stale-data":
      return "오래된 데이터";
    case "all-sources-failed":
      return "전체 소스 실패";
    case "loading":
      return "로딩 중";
    case "success":
      return "정상";
    case "empty":
      return "대기 중";
    default:
      return state;
  }
}

export function formatTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return timestampFormatter.format(date);
}

export function formatSignedNumber(value: number) {
  const absoluteValue = numberFormatter.format(Math.abs(value));

  if (value > 0) {
    return `+${absoluteValue}`;
  }

  if (value < 0) {
    return `-${absoluteValue}`;
  }

  return absoluteValue;
}

export function formatSignedPercent(value: number) {
  const absoluteValue = decimalFormatter.format(Math.abs(value));

  if (value > 0) {
    return `+${absoluteValue}%`;
  }

  if (value < 0) {
    return `-${absoluteValue}%`;
  }

  return `${absoluteValue}%`;
}

export function formatDirection(
  direction: DashboardResult["signals"][number]["direction"],
) {
  switch (direction) {
    case "up":
      return "상승";
    case "down":
      return "하락";
    default:
      return "보합";
  }
}

export function formatConfidence(
  confidence: DashboardResult["signals"][number]["confidence"],
) {
  switch (confidence) {
    case "high":
      return "높음";
    case "medium":
      return "보통";
    default:
      return "낮음";
  }
}

export function formatSentiment(sentiment: string) {
  switch (sentiment) {
    case "positive":
      return "긍정";
    case "negative":
      return "부정";
    case "mixed":
      return "혼합";
    case "unknown":
      return "불명";
    default:
      return "중립";
  }
}

export function formatCommunitySentiment(sentiment: string) {
  if (sentiment === "positive") {
    return "강세";
  }

  if (sentiment === "negative") {
    return "약세";
  }

  return "중립";
}

export function formatImportance(importance: string) {
  if (importance === "high") {
    return "높음";
  }

  if (importance === "medium") {
    return "보통";
  }

  return "낮음";
}

export function formatSourceState(state: SourceStatus["status"]) {
  switch (state) {
    case "ready":
      return "정상";
    case "stale":
      return "오래됨";
    case "failed":
      return "실패";
    default:
      return "제외";
  }
}

export function formatCategory(category: string) {
  const categoryLabels: Record<string, string> = {
    quote: "시세",
    news: "뉴스",
    community: "커뮤니티",
    disclosure: "공시",
    financial: "재무",
    "market-notice": "시장 공지",
    earnings: "실적",
    "shareholder-return": "주주환원",
    "corporate-action": "기업행위",
    ownership: "지분",
    governance: "지배구조",
  };

  return categoryLabels[category] ?? category.replaceAll("-", " ");
}

export function formatFinancialMetric(value: number | null) {
  return value === null ? "없음" : numberFormatter.format(value);
}

export function getTone(value: number): "neutral" | "positive" | "negative" {
  if (value > 0) {
    return "positive";
  }

  if (value < 0) {
    return "negative";
  }

  return "neutral";
}

export function getSignalTone(
  direction: DashboardResult["signals"][number]["direction"],
) {
  if (direction === "up") {
    return "positive";
  }

  if (direction === "down") {
    return "negative";
  }

  return "neutral";
}

export function getStatusTone(status: SourceStatus["status"]) {
  if (status === "ready") {
    return "positive";
  }

  if (status === "failed") {
    return "negative";
  }

  if (status === "stale") {
    return "mixed";
  }

  return "neutral";
}

export function getSentimentTone(sentiment: string) {
  if (sentiment === "positive") {
    return "positive";
  }

  if (sentiment === "negative") {
    return "negative";
  }

  if (sentiment === "mixed") {
    return "mixed";
  }

  return "neutral";
}

export function getImportanceTone(importance: string) {
  if (importance === "high") {
    return "positive";
  }

  if (importance === "medium") {
    return "mixed";
  }

  return "neutral";
}

export function formatEngagement(likes: number, comments: number) {
  const total = likes + comments;

  if (total === 0) {
    return "반응 적음";
  }

  return `반응 ${numberFormatter.format(total)}회`;
}

export function getLatestTimestamp(values: string[]) {
  return values.reduce<string | null>((latest, current) => {
    if (!latest) {
      return current;
    }

    return Date.parse(current) > Date.parse(latest) ? current : latest;
  }, null);
}

export function summarizeCommunity(community: DashboardResult["community"]) {
  const bullishCount = community.filter((post) => post.sentiment === "positive").length;
  const bearishCount = community.filter((post) => post.sentiment === "negative").length;

  return {
    totalPosts: community.length,
    bullishCount,
    bearishCount,
    neutralCount: community.length - bullishCount - bearishCount,
  };
}

export function extractCommunityThemes(community: DashboardResult["community"]) {
  const counts = new Map<string, number>();

  community.forEach((post) => {
    const tokens = `${post.title} ${post.excerpt}`
      .match(/[가-힣A-Za-z]{3,}/g)
      ?.map((token) => token.trim())
      .filter((token) => !communityThemeStopwords.has(token));

    [...new Set(tokens ?? [])].forEach((token) => {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    });
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([label, mentions]) => ({ label, mentions }));
}

export function countMissingMetrics(snapshot: DashboardResult["financials"][number]) {
  return getMissingMetricLabels(snapshot).length;
}

export function getMissingMetricLabels(
  snapshot: DashboardResult["financials"][number],
) {
  return [
    ["매출액", snapshot.revenue],
    ["영업이익", snapshot.operatingProfit],
    ["당기순이익", snapshot.netIncome],
    ["EPS", snapshot.eps],
    ["BPS", snapshot.bps],
    ["PER", snapshot.per],
    ["PBR", snapshot.pbr],
  ]
    .filter(([, value]) => value === null)
    .map(([label]) => label);
}

export function uniqueText(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function formatHorizonLabel(horizon: (typeof DEFAULT_HORIZONS)[number]) {
  switch (horizon) {
    case "1d":
      return "1일";
    case "1w":
      return "1주";
    default:
      return "1개월";
  }
}

export function formatEnabledSourceLabel(label: string) {
  return enabledSourceLabels[label] ?? label;
}

export function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export { DEFAULT_HORIZONS };
