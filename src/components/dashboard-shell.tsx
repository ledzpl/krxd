"use client";

import { Component, FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { DashboardResult, SourceStatus } from "@/lib/normalized-schemas";
import { sanitizeStockCodeDigits } from "@/lib/stock-code";
import {
  calculateBollingerBands,
  calculateCorrelation,
  calculateEMA,
  calculateMA,
  calculateMACD,
  calculateRSI,
} from "@/lib/technical-indicators";

import {
  DEFAULT_HORIZONS,
  capitalize,
  countMissingMetrics,
  decimalFormatter,
  extractCommunityThemes,
  formatCategory,
  formatCommunitySentiment,
  formatConfidence,
  formatDashboardState,
  formatDirection,
  formatEnabledSourceLabel,
  formatEngagement,
  formatFinancialMetric,
  formatHorizonLabel,
  formatImportance,
  formatSentiment,
  formatSignedNumber,
  formatSignedPercent,
  formatSourceLabel,
  formatSourceState,
  formatTimestamp,
  getImportanceTone,
  getLatestTimestamp,
  getMissingMetricLabels,
  getMetricFallbackCopy,
  getSectionStateCopy,
  getSentimentTone,
  getSignalTone,
  getStatusTone,
  getTone,
  numberFormatter,
  summarizeCommunity,
  uniqueText,
  type DashboardState,
} from "./dashboard-formatters";
import styles from "./dashboard-shell.module.css";
import { type RecentSearch, useDashboardAnalysis } from "./use-dashboard-analysis";

type DashboardShellProps = {
  initialStockCode?: string;
  config: {
    requestTimeoutMs: number;
    cacheTtlSeconds: number;
    freshness: {
      quoteMinutes: number;
      newsHours: number;
      communityHours: number;
      disclosureHours: number;
      financialDays: number;
    };
    enabledSources: Array<{
      label: string;
      enabled: boolean;
    }>;
  };
};

const STOCK_RESOLUTION_SOURCE_ID = "krx-stock-code-resolver";
const STOCK_QUOTE_SOURCE_ID = "naver-domestic-market-data";
const STOCK_FINANCIAL_SOURCE_ID = "public-financial-statements";

const WATCHLIST_KEY = "kstock-dashboard.watchlist";
const THEME_KEY = "kstock-dashboard.theme";
const AUTO_REFRESH_KEY = "kstock-dashboard.auto-refresh";
const AUTO_REFRESH_INTERVAL_MS = 60_000;

/* ── Watchlist hook ──────────────────────────────────────── */
type WatchlistEntry = { stockCode: string; companyName: string; addedAt: string };

function useWatchlist() {
  const [items, setItems] = useState<WatchlistEntry[]>([]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(WATCHLIST_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as WatchlistEntry[];
        if (Array.isArray(parsed)) setItems(parsed);
      }
    } catch {
      window.localStorage.removeItem(WATCHLIST_KEY);
    }
  }, []);

  function persist(next: WatchlistEntry[]) {
    setItems(next);
    try { window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  function add(stockCode: string, companyName: string) {
    persist([
      { stockCode, companyName, addedAt: new Date().toISOString() },
      ...items.filter((i) => i.stockCode !== stockCode),
    ].slice(0, 20));
  }

  function remove(stockCode: string) {
    persist(items.filter((i) => i.stockCode !== stockCode));
  }

  function has(stockCode: string) {
    return items.some((i) => i.stockCode === stockCode);
  }

  return { items, add, remove, has };
}

/* ── Theme hook ──────────────────────────────────────────── */
function useTheme() {
  const [theme, setThemeState] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light") {
      setThemeState("light");
      document.documentElement.setAttribute("data-theme", "light");
    }
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setThemeState(next);
    document.documentElement.setAttribute("data-theme", next);
    try { window.localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  }

  return { theme, toggle };
}

/* ── Auto-refresh hook ───────────────────────────────────── */
function useAutoRefresh(
  enabled: boolean,
  isLoading: boolean,
  stockCode: string,
  analyze: (code: string) => void,
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!enabled || !stockCode || isLoading) return;

    intervalRef.current = setInterval(() => {
      if (stockCode) analyze(stockCode);
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled, isLoading, stockCode, analyze]);
}

/* ── Sparkline SVG ───────────────────────────────────────── */
function Sparkline({ points, width = 120, height = 32 }: {
  points: Array<{ price: number }>;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;

  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const stepX = width / (prices.length - 1);

  const pathD = prices
    .map((price, i) => {
      const x = i * stepX;
      const y = height - ((price - min) / range) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? "var(--accent)" : "var(--warning)";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={styles.sparkline} aria-hidden>
      <defs>
        <linearGradient id={`spark-${isUp ? "up" : "down"}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${pathD} L${width},${height} L0,${height} Z`}
        fill={`url(#spark-${isUp ? "up" : "down"})`}
      />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Volume anomaly detection ────────────────────────────── */
function detectVolumeAnomaly(quote: DashboardResult["quote"]): { isAnomaly: boolean; ratio: number } {
  if (!quote || quote.trendPoints.length < 10) return { isAnomaly: false, ratio: 0 };
  // Simple heuristic: if volume is 2x+ the implied average from trend volatility
  // Since we don't have historical volume, we use current volume vs a rough threshold
  const avgPrice = quote.trendPoints.reduce((s, p) => s + p.price, 0) / quote.trendPoints.length;
  const expectedDailyTurnover = avgPrice * 100_000; // rough baseline
  const ratio = expectedDailyTurnover > 0 ? (quote.volume * avgPrice) / expectedDailyTurnover : 0;
  return { isAnomaly: ratio > 2, ratio: Math.round(ratio * 10) / 10 };
}

/* ── 52-week position ────────────────────────────────────── */
function get52WeekPosition(currentPrice: number, high: number | null, low: number | null): number | null {
  if (high === null || low === null || high === low) return null;
  return Math.round(((currentPrice - low) / (high - low)) * 100);
}

/* ── Share function ──────────────────────────────────────── */
function shareResult(result: DashboardResult) {
  const text = `${result.companyName} (${result.stockCode}) 분석 결과\n` +
    (result.quote ? `현재가: ${numberFormatter.format(result.quote.currentPrice)}원 (${formatSignedPercent(result.quote.changePercent)})\n` : "") +
    result.signals.map((s) => `${formatHorizonLabel(s.horizon as "1d" | "1w" | "1m")}: ${formatDirection(s.direction)} ${decimalFormatter.format(s.score)}`).join(" | ") +
    `\n${window.location.href}`;

  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text);
  }
}

/* ── Main Shell ──────────────────────────────────────────── */
export function DashboardShell({
  config,
  initialStockCode = "",
}: DashboardShellProps) {
  const router = useRouter();
  const routeStockCode = sanitizeStockCodeDigits(initialStockCode);
  const {
    analyzeStockCode,
    currentSourceStatus,
    currentWarnings,
    dashboardState,
    feedback,
    isInvalid,
    isLoading,
    isRequestFailure,
    recentSearches,
    result,
    showInvalidCodeFeedback,
    setStockCode,
    stockCode,
  } = useDashboardAnalysis(routeStockCode, config.requestTimeoutMs);

  const watchlist = useWatchlist();
  const { theme, toggle: toggleTheme } = useTheme();
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [shareConfirm, setShareConfirm] = useState(false);
  const signalHistory = useSignalHistory(result);

  useEffect(() => {
    const stored = window.localStorage.getItem(AUTO_REFRESH_KEY);
    if (stored === "true") setAutoRefresh(true);
  }, []);

  const stableAnalyze = useCallback((code: string) => {
    void analyzeStockCode(code);
  }, [analyzeStockCode]);

  useAutoRefresh(autoRefresh, isLoading, routeStockCode, stableAnalyze);

  function handleAutoRefreshToggle() {
    const next = !autoRefresh;
    setAutoRefresh(next);
    try { window.localStorage.setItem(AUTO_REFRESH_KEY, String(next)); } catch { /* ignore */ }
  }

  function handleShare() {
    if (result) {
      shareResult(result);
      setShareConfirm(true);
      setTimeout(() => setShareConfirm(false), 2000);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedStockCode = formData.get("stockCode");
    const normalizedStockCode = sanitizeStockCodeDigits(
      typeof submittedStockCode === "string" ? submittedStockCode : stockCode,
    );

    if (!/^\d{6}$/.test(normalizedStockCode)) {
      showInvalidCodeFeedback();
      return;
    }

    setStockCode(normalizedStockCode);

    if (isLoading && normalizedStockCode === routeStockCode) {
      return;
    }

    if (normalizedStockCode === routeStockCode) {
      void analyzeStockCode(normalizedStockCode);
      return;
    }

    router.push(`/${normalizedStockCode}`);
  }

  const isWatched = result ? watchlist.has(result.stockCode) : false;

  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <section className={styles.hero}>
          <div className={styles.heroContent}>
            <div className={styles.heroIntro}>
              <p className={styles.eyebrow}>로그인 없는 공개 종목 대시보드</p>
              <h1 className={styles.headline}>한 종목 코드로 보는 압축 분석</h1>
              <p className={styles.lede}>
                시세, 뉴스, 커뮤니티, 공시, 재무를 1일, 1주, 1개월 시그널과 함께
                한 화면에 최대한 촘촘하게 보여줍니다.
              </p>
            </div>

            <div className={styles.heroUtility}>
              <StockCodeSearchForm
                feedback={feedback}
                isInvalid={isInvalid}
                isLoading={isLoading}
                isRequestFailure={isRequestFailure}
                recentSearches={recentSearches}
                stockCode={stockCode}
                onChange={setStockCode}
                onSelectRecent={(recentStockCode) => {
                  setStockCode(recentStockCode);
                  if (recentStockCode === routeStockCode) {
                    if (!isLoading) void analyzeStockCode(recentStockCode);
                    return;
                  }
                  router.push(`/${recentStockCode}`);
                }}
                onSubmit={handleSubmit}
              />

              <div className={styles.toolStrip}>
                <div className={styles.configStrip}>
                  <span className={styles.configTag}>
                    응답 제한 {Math.round(config.requestTimeoutMs / 1000)}초
                  </span>
                  <span className={styles.configTag}>
                    캐시 {config.cacheTtlSeconds}초
                  </span>
                </div>
                <div className={styles.actionStrip}>
                  <button className={styles.actionBtn} type="button" onClick={toggleTheme} title="테마 전환">
                    {theme === "dark" ? "Light" : "Dark"}
                  </button>
                  <button
                    className={`${styles.actionBtn} ${autoRefresh ? styles.actionBtnActive : ""}`}
                    type="button"
                    onClick={handleAutoRefreshToggle}
                    title={autoRefresh ? "자동 갱신 끄기" : "자동 갱신 켜기 (60초)"}
                  >
                    {autoRefresh ? "Auto ON" : "Auto OFF"}
                  </button>
                  {result ? (
                    <>
                      <button className={styles.actionBtn} type="button" onClick={handlePrint}>
                        PDF
                      </button>
                      <button className={styles.actionBtn} type="button" onClick={handleShare}>
                        {shareConfirm ? "Copied!" : "Share"}
                      </button>
                      <button
                        className={`${styles.actionBtn} ${isWatched ? styles.actionBtnActive : ""}`}
                        type="button"
                        onClick={() => {
                          if (isWatched) watchlist.remove(result.stockCode);
                          else watchlist.add(result.stockCode, result.companyName);
                        }}
                      >
                        {isWatched ? "Watched" : "Watch"}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Watchlist */}
        {watchlist.items.length > 0 ? (
          <section className={styles.card}>
            <div className={styles.sectionHeader}>
              <div>
                <h2 className={styles.sectionTitle}>관심종목</h2>
                <p className={styles.sectionCopy}>
                  즐겨찾기한 종목을 빠르게 조회합니다.
                </p>
              </div>
              <span className={styles.badge}>{watchlist.items.length}종목</span>
            </div>
            <div className={styles.recentSearchList}>
              {watchlist.items.map((item) => (
                <button
                  className={`${styles.recentSearchChip} ${item.stockCode === routeStockCode ? styles.recentSearchChipActive : ""}`}
                  key={item.stockCode}
                  type="button"
                  onClick={() => {
                    setStockCode(item.stockCode);
                    if (item.stockCode === routeStockCode) {
                      if (!isLoading) void analyzeStockCode(item.stockCode);
                    } else {
                      router.push(`/${item.stockCode}`);
                    }
                  }}
                >
                  <span>{item.stockCode}</span>
                  <span>{item.companyName}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className={styles.topMeta}>
          <section className={styles.disclaimerCard}>
            <p className={styles.disclaimerTitle}>확인 사항</p>
            <p className={styles.disclaimerCopy}>
              정보 제공용 화면입니다. 매매 실행 기능은 없고, 신뢰도가 낮은 시그널은
              그대로 낮음으로 표시합니다.
            </p>
            <div className={styles.disclaimerMeta}>
              <span className={styles.disclaimerTag}>
                상태 {formatDashboardState(dashboardState)}
              </span>
              <span className={styles.disclaimerTag}>
                사용 소스 {config.enabledSources.filter((source) => source.enabled).length}/
                {config.enabledSources.length}
              </span>
              {autoRefresh ? (
                <span className={styles.disclaimerTag}>자동 갱신 60초</span>
              ) : null}
            </div>
          </section>

          <section className={`${styles.card} ${styles.warningCard}`}>
            <div className={styles.sectionHeader}>
              <div>
                <h2 className={styles.sectionTitle}>경고</h2>
                <p className={styles.sectionCopy}>
                  실패와 오래된 근거를 숨기지 않고 그대로 노출합니다.
                </p>
              </div>
              <span className={styles.badge}>
                {currentWarnings.length > 0 ? `${currentWarnings.length}건` : "없음"}
              </span>
            </div>
            {currentWarnings.length > 0 ? (
              <ul className={styles.warningList}>
                {currentWarnings.slice(0, 4).map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            ) : (
              <p className={styles.emptyState}>현재 결과에 활성 경고가 없습니다.</p>
            )}
          </section>
        </section>

        <SummaryBand result={result} state={dashboardState} />

        {/* Market Overview: 52-week, dividend, foreign, sector, volume anomaly */}
        <MarketOverviewBand result={result} state={dashboardState} />

        <PredictionCards result={result} state={dashboardState} />

        {/* Charts Section */}
        {result?.quote && result.quote.trendPoints.length >= 10 ? (
          <LazySection className={styles.chartSection}>
            <article className={styles.card}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>기술적 분석</h2>
                  <p className={styles.sectionCopy}>
                    가격 추이, MA5/MA20 이동평균선, RSI(14) 지표를 보여줍니다.
                  </p>
                </div>
                <span className={styles.badge}>{result.quote.trendPoints.length}포인트</span>
              </div>
              <TechnicalChart points={result.quote.trendPoints} />
            </article>
            <article className={styles.card}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>시간별 캔들차트</h2>
                  <p className={styles.sectionCopy}>
                    5분봉 데이터를 시간 단위로 묶어 시가/고가/저가/종가를 표시합니다.
                  </p>
                </div>
                <span className={styles.badge}>Hourly</span>
              </div>
              <CandleChart points={result.quote.trendPoints} />
            </article>
            <article className={styles.card}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>MACD</h2>
                  <p className={styles.sectionCopy}>
                    12/26 EMA 기반 모멘텀 지표와 시그널(9) 라인을 보여줍니다.
                  </p>
                </div>
                <span className={styles.badge}>Momentum</span>
              </div>
              <MACDChart points={result.quote.trendPoints} />
            </article>
            <article className={styles.card}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>거래량 프로필</h2>
                  <p className={styles.sectionCopy}>
                    시간대별 가격 변동 강도를 히트맵으로 보여줍니다.
                  </p>
                </div>
                <span className={styles.badge}>Heatmap</span>
              </div>
              <VolumeProfile points={result.quote.trendPoints} />
            </article>
          </LazySection>
        ) : null}

        {/* Sector Comparison + Earnings Calendar */}
        {result ? (
          <section className={styles.chartSection}>
            <SectorComparison result={result} />
            <EarningsCalendar result={result} />
          </section>
        ) : null}

        {/* Signal History + Investor Chart */}
        <section className={styles.chartSection}>
          {result ? (
            <article className={styles.card}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>시그널 히스토리</h2>
                  <p className={styles.sectionCopy}>
                    과거 분석 기록의 시그널 점수 추이를 보여줍니다.
                  </p>
                </div>
                <span className={styles.badge}>
                  {signalHistory.filter((e) => e.stockCode === result.stockCode).length}회
                </span>
              </div>
              <SignalHistoryChart history={signalHistory} stockCode={result.stockCode} />
              {signalHistory.filter((e) => e.stockCode === result.stockCode).length < 2 ? (
                <p className={styles.emptyState}>
                  같은 종목을 2회 이상 분석하면 시그널 추이 그래프가 표시됩니다.
                </p>
              ) : null}
            </article>
          ) : null}
          {result?.marketOverview ? (
            <article className={styles.card}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>투자자별 수급</h2>
                  <p className={styles.sectionCopy}>
                    외국인과 기관의 순매수 규모를 시각적으로 비교합니다.
                  </p>
                </div>
                <span className={styles.badge}>수급 차트</span>
              </div>
              <InvestorChart overview={result.marketOverview} />
              {result.marketOverview.foreignNetVolume === null && result.marketOverview.institutionalNetVolume === null ? (
                <p className={styles.emptyState}>투자자별 수급 데이터를 수집하지 못했습니다.</p>
              ) : null}
            </article>
          ) : null}
        </section>

        {/* Compare Panel */}
        <ComparePanel
          currentResult={result}
          onNavigate={(code) => router.push(`/${code}`)}
        />

        <section className={styles.sections}>
          <NewsList result={result} state={dashboardState} />
          <CommunitySummary result={result} state={dashboardState} />
          <DisclosureList result={result} state={dashboardState} />
          <FinancialSnapshotCard result={result} state={dashboardState} />
        </section>

        <section className={styles.card}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>런타임 설정</h2>
              <p className={styles.sectionCopy}>
                환경 검증, 신선도 기준, 소스 토글이 대시보드 시작 전에 적용됩니다.
              </p>
            </div>
            <span className={styles.badge}>시작 시 검증</span>
          </div>
          <div className={styles.configStrip}>
            {config.enabledSources.map((source) => (
              <span className={styles.configTag} key={source.label}>
                {formatEnabledSourceLabel(source.label)}: {source.enabled ? "사용" : "중지"}
              </span>
            ))}
            <span className={styles.configTag}>
              뉴스 신선도: {config.freshness.newsHours}시간
            </span>
            <span className={styles.configTag}>
              커뮤니티 신선도: {config.freshness.communityHours}시간
            </span>
            <span className={styles.configTag}>
              공시 신선도: {config.freshness.disclosureHours}시간
            </span>
          </div>
        </section>

        <SourceStatusPanel
          sourceStatus={currentSourceStatus}
          state={dashboardState}
          warnings={currentWarnings}
        />
      </div>
    </main>
  );
}

/* ── Sub Components ──────────────────────────────────────── */

function StockCodeSearchForm(props: {
  feedback: string;
  isInvalid: boolean;
  isLoading: boolean;
  isRequestFailure: boolean;
  recentSearches: RecentSearch[];
  stockCode: string;
  onChange: (value: string) => void;
  onSelectRecent: (stockCode: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className={styles.form} noValidate onSubmit={props.onSubmit}>
      <div className={styles.fieldRow}>
        <input
          aria-label="종목 코드"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className={styles.input}
          inputMode="numeric"
          name="stockCode"
          placeholder="005930"
          spellCheck={false}
          value={props.stockCode}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <button className={styles.submit} disabled={props.isLoading} type="submit">
          {props.isLoading ? "분석 중..." : "분석하기"}
        </button>
      </div>
      <p className={styles.hint}>
        시세 모멘텀, 뉴스 감성, 공개 커뮤니티 반응, 공식 공시, 분기 재무를 가중치로
        묶어 시그널을 계산합니다.
      </p>
      <p
        aria-live="polite"
        className={`${styles.feedback} ${
          props.isInvalid
            ? styles.feedbackInvalid
            : props.isRequestFailure
              ? styles.feedbackWarning
              : ""
        }`}
      >
        {props.feedback}
      </p>
      {props.recentSearches.length > 0 ? (
        <div className={styles.recentSearchBlock}>
          <p className={styles.recentSearchTitle}>최근 조회</p>
          <div className={styles.recentSearchList}>
            {props.recentSearches.map((search) => (
              <button
                className={styles.recentSearchChip}
                key={search.stockCode}
                type="button"
                onClick={() => props.onSelectRecent(search.stockCode)}
              >
                <span>{search.stockCode}</span>
                <span>{search.companyName}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </form>
  );
}

function SummaryBand({
  result,
  state,
}: {
  result: DashboardResult | null;
  state: DashboardState;
}) {
  const companySummary = result
    ? `${result.companyName} · ${result.market}`
    : state === "loading"
      ? "종목 정보를 불러오는 중"
      : "분석 대기 중";
  const resolutionStatus = result?.sourceStatus.find(
    (status) => status.sourceId === STOCK_RESOLUTION_SOURCE_ID,
  );
  const summaryCopy = result
    ? uniqueText([
        resolutionStatus?.status === "ready" ? `${result.stockCode} 식별 완료` : undefined,
        result.quote?.capturedAt
          ? `시세 ${formatTimestamp(result.quote.capturedAt)} 기준`
          : undefined,
        result.warnings.length > 0 ? `경고 ${result.warnings.length}건` : undefined,
      ]).join(" · ")
    : getSectionStateCopy(
        state,
        "종목명, 시장, 분석 시각, 시세 신선도가 여기에 표시됩니다.",
      );
  const quoteTone = getTone(result?.quote?.changeAmount ?? 0);

  return (
    <section className={styles.summaryBand}>
      <article className={`${styles.card} ${styles.metricLead}`}>
        <p className={styles.metricTitle}>종목 요약</p>
        <p className={styles.metricValue}>{companySummary}</p>
        {result?.quote && result.quote.trendPoints.length > 1 ? (
          <Sparkline points={result.quote.trendPoints} />
        ) : null}
        <p className={styles.metricCopy}>{summaryCopy}</p>
      </article>
      <MetricCard
        label="현재가"
        value={result?.quote ? `${numberFormatter.format(result.quote.currentPrice)}원` : "--"}
        copy={
          result?.quote
            ? `수집 시각 ${formatTimestamp(result.quote.capturedAt)}`
            : getMetricFallbackCopy(state, "시세 스냅샷이 표시됩니다.")
        }
      />
      <MetricCard
        label="전일 대비"
        tone={quoteTone}
        value={result?.quote ? `${formatSignedNumber(result.quote.changeAmount)}원` : "--"}
        copy="전일 종가 대비 절대 변동"
      />
      <MetricCard
        label="등락률"
        tone={quoteTone}
        value={result?.quote ? formatSignedPercent(result.quote.changePercent) : "--"}
        copy="전일 종가 대비 상대 변동"
      />
      <MetricCard
        label="분석 시각"
        value={result ? formatTimestamp(result.analyzedAt) : "--"}
        copy={
          result
            ? `${result.sourceStatus.filter((status) => status.status === "ready").length}개 소스 정상`
            : getMetricFallbackCopy(state, "분석 완료 시각이 표시됩니다.")
        }
      />
    </section>
  );
}

function MarketOverviewBand({
  result,
  state,
}: {
  result: DashboardResult | null;
  state: DashboardState;
}) {
  const overview = result?.marketOverview;
  const quote = result?.quote;
  const volumeAnomaly = quote ? detectVolumeAnomaly(quote) : null;
  const week52Pos = quote && overview
    ? get52WeekPosition(quote.currentPrice, overview.week52High, overview.week52Low)
    : null;

  const hasData = overview && (
    overview.week52High !== null ||
    overview.dividendYield !== null ||
    overview.foreignOwnershipPercent !== null ||
    overview.sectorName !== null
  );

  if (!result && state !== "loading") return null;

  return (
    <section className={styles.overviewBand}>
      <article className={`${styles.card} ${styles.overviewCard}`}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={styles.sectionTitle}>시장 개요</h2>
            <p className={styles.sectionCopy}>
              52주 범위, 배당, 외국인/기관 수급, 업종, 거래량 이상치를 한눈에 보여줍니다.
            </p>
          </div>
          {overview?.sectorName ? (
            <span className={styles.badge}>{overview.sectorName}</span>
          ) : (
            <span className={styles.badge}>{formatDashboardState(state)}</span>
          )}
        </div>
        {hasData ? (
          <div className={styles.overviewGrid}>
            {overview.week52High !== null ? (
              <div className={styles.overviewItem}>
                <span className={styles.communityMetricLabel}>52주 최고</span>
                <strong className={styles.financialMetricValue}>
                  {numberFormatter.format(overview.week52High)}원
                </strong>
              </div>
            ) : null}
            {overview.week52Low !== null ? (
              <div className={styles.overviewItem}>
                <span className={styles.communityMetricLabel}>52주 최저</span>
                <strong className={styles.financialMetricValue}>
                  {numberFormatter.format(overview.week52Low)}원
                </strong>
              </div>
            ) : null}
            {week52Pos !== null ? (
              <div className={styles.overviewItem}>
                <span className={styles.communityMetricLabel}>52주 위치</span>
                <strong className={`${styles.financialMetricValue} ${week52Pos > 70 ? styles.metricPositive : week52Pos < 30 ? styles.metricNegative : ""}`}>
                  {week52Pos}%
                </strong>
                <div className={styles.positionBar}>
                  <div className={styles.positionFill} style={{ width: `${week52Pos}%` }} />
                </div>
              </div>
            ) : null}
            {overview.dividendYield !== null ? (
              <div className={styles.overviewItem}>
                <span className={styles.communityMetricLabel}>배당수익률</span>
                <strong className={styles.financialMetricValue}>
                  {decimalFormatter.format(overview.dividendYield)}%
                </strong>
              </div>
            ) : null}
            {overview.foreignOwnershipPercent !== null ? (
              <div className={styles.overviewItem}>
                <span className={styles.communityMetricLabel}>외국인 지분</span>
                <strong className={styles.financialMetricValue}>
                  {decimalFormatter.format(overview.foreignOwnershipPercent)}%
                </strong>
              </div>
            ) : null}
            {overview.marketCap !== null ? (
              <div className={styles.overviewItem}>
                <span className={styles.communityMetricLabel}>시가총액</span>
                <strong className={styles.financialMetricValue}>
                  {formatLargeNumber(overview.marketCap)}
                </strong>
              </div>
            ) : null}
            {overview.foreignNetVolume !== null ? (
              <div className={styles.overviewItem}>
                <span className={styles.communityMetricLabel}>외국인 순매수</span>
                <strong className={`${styles.financialMetricValue} ${overview.foreignNetVolume > 0 ? styles.metricPositive : overview.foreignNetVolume < 0 ? styles.metricNegative : ""}`}>
                  {formatLargeNumber(overview.foreignNetVolume)}
                </strong>
              </div>
            ) : null}
            {overview.institutionalNetVolume !== null ? (
              <div className={styles.overviewItem}>
                <span className={styles.communityMetricLabel}>기관 순매수</span>
                <strong className={`${styles.financialMetricValue} ${overview.institutionalNetVolume > 0 ? styles.metricPositive : overview.institutionalNetVolume < 0 ? styles.metricNegative : ""}`}>
                  {formatLargeNumber(overview.institutionalNetVolume)}
                </strong>
              </div>
            ) : null}
            {quote ? (
              <div className={styles.overviewItem}>
                <span className={styles.communityMetricLabel}>거래량</span>
                <strong className={styles.financialMetricValue}>
                  {numberFormatter.format(quote.volume)}주
                </strong>
                {volumeAnomaly?.isAnomaly ? (
                  <span className={`${styles.sentimentTag} ${styles.sentimentNegative}`}>
                    이상 감지 x{volumeAnomaly.ratio}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <p className={styles.emptyState}>
            {getSectionStateCopy(state, "시장 개요 데이터를 수집 중입니다.")}
          </p>
        )}
      </article>
    </section>
  );
}

function PredictionCards({
  result,
  state,
}: {
  result: DashboardResult | null;
  state: DashboardState;
}) {
  const signalByHorizon = new Map(result?.signals.map((signal) => [signal.horizon, signal]));

  return (
    <section className={styles.signals}>
      {DEFAULT_HORIZONS.map((horizon) => {
        const signal = signalByHorizon.get(horizon);
        const signalTone = signal ? getSignalTone(signal.direction) : "neutral";

        return (
          <article className={styles.card} key={horizon}>
            <div className={styles.sectionHeader}>
              <div>
                <h2 className={styles.sectionTitle}>{formatHorizonLabel(horizon)} 시그널</h2>
                <p className={styles.sectionCopy}>
                  방향, 점수, 신뢰도, 핵심 근거를 압축해서 보여줍니다.
                </p>
              </div>
              <span className={`${styles.badge} ${styles[`badge${capitalize(signalTone)}`]}`}>
                {signal ? formatConfidence(signal.confidence) : formatDashboardState(state)}
              </span>
            </div>
            <div className={`${styles.signalValue} ${styles[`signal${capitalize(signalTone)}`]}`}>
              {signal ? `${formatDirection(signal.direction)} · ${decimalFormatter.format(signal.score)}` : "대기 중"}
            </div>
            <ul className={styles.signalList}>
              {signal
                ? signal.reasons.slice(0, 2).map((reason) => <li key={reason}>{reason}</li>)
                : [getSectionStateCopy(state, "분석이 완료되면 시그널이 표시됩니다.")].map(
                    (reason) => <li key={reason}>{reason}</li>,
                  )}
            </ul>
          </article>
        );
      })}
    </section>
  );
}

function SourceStatusPanel({
  sourceStatus,
  state,
  warnings,
}: {
  sourceStatus: SourceStatus[];
  state: DashboardState;
  warnings: string[];
}) {
  const sortedStatuses = [...sourceStatus].sort((left, right) => {
    const stateOrder: Record<SourceStatus["status"], number> = {
      failed: 0,
      stale: 1,
      ready: 2,
      excluded: 3,
    };

    return (
      stateOrder[left.status] - stateOrder[right.status] ||
      left.category.localeCompare(right.category) ||
      left.sourceId.localeCompare(right.sourceId)
    );
  });

  return (
    <article className={`${styles.card} ${styles.sourceStatusCard}`}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>소스 상태</h2>
          <p className={styles.sectionCopy}>
            정상, 오래됨, 실패, 제외 상태를 모두 하단에서 한 번에 확인할 수 있습니다.
          </p>
        </div>
        <span className={styles.badge}>
          {sortedStatuses.length > 0 ? `${sortedStatuses.length}개 추적` : formatDashboardState(state)}
        </span>
      </div>
      {sortedStatuses.length === 0 ? (
        <p className={styles.emptyState}>
          {getSectionStateCopy(
            state,
            "대시보드를 조회하면 소스별 런타임 상태가 여기에 표시됩니다.",
          )}
        </p>
      ) : (
        <div className={styles.statusGrid}>
          {sortedStatuses.map((status) => (
            <article className={styles.statusRow} key={status.sourceId}>
              <div className={styles.statusLead}>
                <div>
                  <p className={styles.statusTitle}>{formatSourceLabel(status.sourceId)}</p>
                  <p className={styles.statusMeta}>
                    {formatCategory(status.category)} · {formatSourceState(status.status)}
                  </p>
                </div>
                <span className={`${styles.badge} ${styles[`badge${capitalize(getStatusTone(status.status))}`]}`}>
                  {formatSourceState(status.status)}
                </span>
              </div>
              {status.notes.length > 0 ? (
                <ul className={styles.statusNotes}>
                  {status.notes.slice(0, 2).map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
              {status.diagnostics.length > 0 ? (
                <ul className={styles.diagnosticList}>
                  {status.diagnostics.slice(0, 2).map((diagnostic, index) => (
                    <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      )}
      {warnings.length > 0 ? (
        <p className={styles.sectionFootnote}>
          상단 경고 패널에는 가장 중요한 실패 또는 오래된 상태만 요약됩니다.
        </p>
      ) : null}
    </article>
  );
}

function NewsList({
  result,
  state,
}: {
  result: DashboardResult | null;
  state: DashboardState;
}) {
  return (
    <article className={`${styles.card} ${styles.newsCard}`}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>뉴스</h2>
          <p className={styles.sectionCopy}>
            제목, 시각, 감성을 빠르게 확인합니다.
          </p>
        </div>
        <span className={styles.badge}>
          {result ? `${result.news.length}건` : formatDashboardState(state)}
        </span>
      </div>
      {result?.news.length ? (
        <div className={styles.newsList}>
          {result.news.slice(0, 6).map((article) => (
            <article className={styles.newsRow} key={article.id}>
              <div className={styles.newsMeta}>
                <span>{article.publisher}</span>
                <span>·</span>
                <span>{formatTimestamp(article.publishedAt)}</span>
                <span
                  className={`${styles.sentimentTag} ${styles[`sentiment${capitalize(getSentimentTone(article.sentiment))}`]}`}
                >
                  {formatSentiment(article.sentiment)}
                </span>
              </div>
              <a
                className={styles.newsLink}
                href={article.url}
                rel="noreferrer"
                target="_blank"
              >
                {article.title}
              </a>
              <p className={styles.newsSummary}>{article.summary}</p>
            </article>
          ))}
        </div>
      ) : (
        <p className={styles.emptyState}>
          {getSectionStateCopy(state, "검증된 최근 뉴스가 없습니다.")}
        </p>
      )}
    </article>
  );
}

function CommunitySummary({
  result,
  state,
}: {
  result: DashboardResult | null;
  state: DashboardState;
}) {
  const communitySummary = summarizeCommunity(result?.community ?? []);
  const topThemes = extractCommunityThemes(result?.community ?? []);

  return (
    <article className={`${styles.card} ${styles.communityCard}`}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>커뮤니티 반응</h2>
          <p className={styles.sectionCopy}>
            개인 투자자 톤, 반복 주제, 주요 공개 글을 요약합니다.
          </p>
        </div>
        <span className={styles.badge}>
          {result ? `${communitySummary.totalPosts}건` : formatDashboardState(state)}
        </span>
      </div>
      {result?.community.length ? (
        <>
          <div className={styles.communitySummary}>
            <StatPill label="강세" value={String(communitySummary.bullishCount)} />
            <StatPill label="중립" value={String(communitySummary.neutralCount)} />
            <StatPill label="약세" value={String(communitySummary.bearishCount)} />
            <StatPill
              label="최신"
              value={formatTimestamp(
                getLatestTimestamp(result.community.map((post) => post.publishedAt)) ??
                  result.analyzedAt,
              )}
            />
          </div>
          {topThemes.length > 0 ? (
            <div className={styles.communityThemeBlock}>
              <p className={styles.communityThemeTitle}>반복 언급 주제</p>
              <div className={styles.communityThemeList}>
                {topThemes.map((theme) => (
                  <span className={styles.communityTheme} key={theme.label}>
                    {theme.label} · {theme.mentions}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div className={styles.communityList}>
            {result.community.slice(0, 6).map((post) => (
              <article className={styles.communityRow} key={post.id}>
                <div className={styles.newsMeta}>
                  <span>{post.source}</span>
                  <span>·</span>
                  <span>{formatTimestamp(post.publishedAt)}</span>
                  <span>·</span>
                  <span>{formatEngagement(post.engagement.likes ?? 0, post.engagement.comments ?? 0)}</span>
                  <span
                    className={`${styles.sentimentTag} ${styles[`sentiment${capitalize(getSentimentTone(post.sentiment))}`]}`}
                  >
                    {formatCommunitySentiment(post.sentiment)}
                  </span>
                </div>
                <a
                  className={styles.newsLink}
                  href={post.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {post.title}
                </a>
                <p className={styles.newsSummary}>{post.excerpt}</p>
              </article>
            ))}
          </div>
        </>
      ) : (
        <p className={styles.emptyState}>
          {getSectionStateCopy(state, "검증된 공개 커뮤니티 글이 없습니다.")}
        </p>
      )}
    </article>
  );
}

function DisclosureList({
  result,
  state,
}: {
  result: DashboardResult | null;
  state: DashboardState;
}) {
  return (
    <article className={`${styles.card} ${styles.disclosureCard}`}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>공시</h2>
          <p className={styles.sectionCopy}>
            최근 KIND 공시를 중요도 순으로 정리합니다.
          </p>
        </div>
        <span className={styles.badge}>
          {result ? `${result.disclosures.length}건` : formatDashboardState(state)}
        </span>
      </div>
      {result?.disclosures.length ? (
        <div className={styles.disclosureList}>
          {result.disclosures.slice(0, 6).map((disclosure) => (
            <article className={styles.disclosureRow} key={disclosure.id}>
              <div className={styles.newsMeta}>
                <span>{formatCategory(disclosure.category)}</span>
                <span>·</span>
                <span>{formatTimestamp(disclosure.publishedAt)}</span>
                <span
                  className={`${styles.sentimentTag} ${styles[`sentiment${capitalize(getImportanceTone(disclosure.importance))}`]}`}
                >
                  {formatImportance(disclosure.importance)}
                </span>
              </div>
              <a
                className={styles.newsLink}
                href={disclosure.url}
                rel="noreferrer"
                target="_blank"
              >
                {disclosure.title}
              </a>
            </article>
          ))}
        </div>
      ) : (
        <p className={styles.emptyState}>
          {getSectionStateCopy(state, "검증된 공식 공시가 없습니다.")}
        </p>
      )}
    </article>
  );
}

function FinancialSnapshotCard({
  result,
  state,
}: {
  result: DashboardResult | null;
  state: DashboardState;
}) {
  const financialSnapshot = result?.financials[0] ?? null;
  const financialStatus = result?.sourceStatus.find(
    (status) => status.sourceId === STOCK_FINANCIAL_SOURCE_ID,
  );

  return (
    <article className={`${styles.card} ${styles.financialCard}`}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>재무 요약</h2>
          <p className={styles.sectionCopy}>
            수익성과 밸류에이션을 보여주고, 누락과 오래된 값은 따로 표시합니다.
          </p>
        </div>
        <span className={`${styles.badge} ${styles[`badge${capitalize(getStatusTone(financialStatus?.status ?? "ready"))}`]}`}>
          {financialStatus ? formatSourceState(financialStatus.status) : formatDashboardState(state)}
        </span>
      </div>
      {financialSnapshot ? (
        <>
          <div className={styles.financialSummary}>
            <StatPill label="회계 기간" value={financialSnapshot.fiscalPeriod} />
            <StatPill
              label="수집 시각"
              value={formatTimestamp(financialSnapshot.capturedAt)}
            />
            <StatPill
              label="누락 항목"
              value={String(countMissingMetrics(financialSnapshot))}
            />
            <StatPill
              label="신선도"
              value={financialStatus?.status === "stale" ? "오래됨" : "기준 내"}
            />
          </div>
          <div className={styles.financialGrid}>
            <FinancialMetric label="매출액" value={formatFinancialMetric(financialSnapshot.revenue)} />
            <FinancialMetric
              label="영업이익"
              value={formatFinancialMetric(financialSnapshot.operatingProfit)}
            />
            <FinancialMetric
              label="당기순이익"
              value={formatFinancialMetric(financialSnapshot.netIncome)}
            />
            <FinancialMetric label="EPS" value={formatFinancialMetric(financialSnapshot.eps)} />
            <FinancialMetric label="BPS" value={formatFinancialMetric(financialSnapshot.bps)} />
            <FinancialMetric label="PER" value={formatFinancialMetric(financialSnapshot.per)} />
            <FinancialMetric label="PBR" value={formatFinancialMetric(financialSnapshot.pbr)} />
          </div>
          {(financialStatus?.status === "stale" || countMissingMetrics(financialSnapshot) > 0) && (
            <div className={styles.diagnosticPanel}>
              <p className={styles.diagnosticTitle}>신뢰도 체크</p>
              <ul className={styles.diagnosticList}>
                {financialStatus?.status === "stale" ? (
                  <li>
                    이 재무 스냅샷은 오래된 값이어서 중장기 시그널 신뢰도를 낮출 수 있습니다.
                  </li>
                ) : null}
                {countMissingMetrics(financialSnapshot) > 0 ? (
                  <li>
                    누락 항목: {getMissingMetricLabels(financialSnapshot).join(", ")}.
                  </li>
                ) : null}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className={styles.emptyState}>
          {getSectionStateCopy(state, "검증된 재무 스냅샷이 없습니다.")}
        </p>
      )}
    </article>
  );
}

function MetricCard(props: {
  label: string;
  value: string;
  copy: string;
  tone?: "neutral" | "positive" | "negative";
}) {
  return (
    <article className={`${styles.card} ${styles.metricLead}`}>
      <p className={styles.metricTitle}>{props.label}</p>
      <p
        className={`${styles.metricValue} ${
          props.tone === "positive"
            ? styles.metricPositive
            : props.tone === "negative"
              ? styles.metricNegative
              : ""
        }`}
      >
        {props.value}
      </p>
      <p className={styles.metricCopy}>{props.copy}</p>
    </article>
  );
}

function FinancialMetric(props: { label: string; value: string }) {
  return (
    <div className={styles.financialMetricCard}>
      <span className={styles.communityMetricLabel}>{props.label}</span>
      <strong className={styles.financialMetricValue}>{props.value}</strong>
    </div>
  );
}

function StatPill(props: { label: string; value: string }) {
  return (
    <div className={styles.communityMetric}>
      <span className={styles.communityMetricLabel}>{props.label}</span>
      <strong className={styles.communityMetricValueSmall}>{props.value}</strong>
    </div>
  );
}

/* ── Error Boundary ──────────────────────────────────────── */
type ErrorBoundaryProps = { fallback?: ReactNode; children: ReactNode };
type ErrorBoundaryState = { hasError: boolean };

class ChartErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <p className={styles.emptyState}>이 섹션을 렌더링하는 중 오류가 발생했습니다.</p>
      );
    }
    return this.props.children;
  }
}

/* ── Lazy Section (Intersection Observer) ────────────────── */
function LazySection({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); observer.disconnect(); } },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {isVisible ? (
        <ChartErrorBoundary>{children}</ChartErrorBoundary>
      ) : (
        <div className={styles.lazyPlaceholder} />
      )}
    </div>
  );
}

/* ── Technical Indicators (imported from @/lib/technical-indicators) ── */

type CandleData = { open: number; high: number; low: number; close: number; label: string };

function aggregateCandles(points: Array<{ at: string; price: number }>, groupMinutes: number): CandleData[] {
  if (points.length === 0) return [];
  const groups = new Map<string, number[]>();
  for (const p of points) {
    const d = new Date(p.at);
    const bucket = new Date(Math.floor(d.getTime() / (groupMinutes * 60000)) * groupMinutes * 60000);
    const key = bucket.toISOString();
    const arr = groups.get(key);
    if (arr) arr.push(p.price); else groups.set(key, [p.price]);
  }
  return [...groups.entries()].map(([key, prices]) => ({
    open: prices[0],
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices[prices.length - 1],
    label: formatTimestamp(key),
  }));
}


/* ── Technical Chart (Price + MA + Bollinger + RSI) ──────── */
function TechnicalChart({ points }: { points: Array<{ at: string; price: number }> }) {
  if (points.length < 5) return null;
  const W = 600, H_PRICE = 160, H_RSI = 60, PAD = 30;
  const prices = points.map((p) => p.price);
  const ma5 = calculateMA(prices, 5);
  const ma20 = calculateMA(prices, 20);
  const rsi = calculateRSI(prices, 14);
  const bb = calculateBollingerBands(prices, 20, 2);
  const allValues = [...prices, ...bb.upper.filter((v): v is number => v !== null), ...bb.lower.filter((v): v is number => v !== null)];
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 1;
  const xStep = (W - PAD * 2) / (prices.length - 1);

  function priceY(v: number) { return PAD + (H_PRICE - PAD * 2) * (1 - (v - min) / range); }
  function rsiY(v: number) { return H_PRICE + 8 + (H_RSI - 8) * (1 - v / 100); }

  const pricePath = prices.map((p, i) => `${i === 0 ? "M" : "L"}${(PAD + i * xStep).toFixed(1)},${priceY(p).toFixed(1)}`).join(" ");
  const ma5Path = ma5.map((v, i) => v !== null ? `${ma5.slice(0, i).some((x) => x !== null) ? "L" : "M"}${(PAD + i * xStep).toFixed(1)},${priceY(v).toFixed(1)}` : "").filter(Boolean).join(" ");
  const ma20Path = ma20.map((v, i) => v !== null ? `${ma20.slice(0, i).some((x) => x !== null) ? "L" : "M"}${(PAD + i * xStep).toFixed(1)},${priceY(v).toFixed(1)}` : "").filter(Boolean).join(" ");
  const rsiPath = rsi.map((v, i) => v !== null ? `${rsi.slice(0, i).some((x) => x !== null) ? "L" : "M"}${(PAD + i * xStep).toFixed(1)},${rsiY(v).toFixed(1)}` : "").filter(Boolean).join(" ");

  // Bollinger band fill
  const bbUpperPath = bb.upper.map((v, i) => v !== null ? `${bb.upper.slice(0, i).some((x) => x !== null) ? "L" : "M"}${(PAD + i * xStep).toFixed(1)},${priceY(v).toFixed(1)}` : "").filter(Boolean).join(" ");
  const bbLowerReverse = [...bb.lower].map((v, i) => ({ v, i })).filter((x) => x.v !== null).reverse()
    .map((x) => `L${(PAD + x.i * xStep).toFixed(1)},${priceY(x.v!).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H_PRICE + H_RSI + 16}`} className={styles.techChart} aria-label="기술적 분석 차트">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={PAD} y1={priceY(min + range * f)} x2={W - PAD} y2={priceY(min + range * f)} stroke="rgba(255,255,255,0.06)" />
          <text x={PAD - 4} y={priceY(min + range * f) + 3} fill="var(--ink-muted)" fontSize="8" textAnchor="end">
            {numberFormatter.format(Math.round(min + range * f))}
          </text>
        </g>
      ))}
      {/* Bollinger Band fill */}
      {bbUpperPath && bbLowerReverse && (
        <path d={`${bbUpperPath} ${bbLowerReverse} Z`} fill="rgba(77,180,255,0.06)" />
      )}
      <path d={pricePath} fill="none" stroke="var(--ink-strong)" strokeWidth="1.5" />
      {ma5Path && <path d={ma5Path} fill="none" stroke="var(--accent)" strokeWidth="1" opacity="0.7" />}
      {ma20Path && <path d={ma20Path} fill="none" stroke="var(--info)" strokeWidth="1" opacity="0.7" />}
      <text x={PAD} y={12} fill="var(--ink-muted)" fontSize="8">
        <tspan fill="var(--ink-strong)">Price</tspan>
        <tspan dx="6" fill="var(--accent)">MA5</tspan>
        <tspan dx="6" fill="var(--info)">MA20</tspan>
        <tspan dx="6" fill="rgba(77,180,255,0.5)">BB(20,2)</tspan>
      </text>
      {/* RSI */}
      <line x1={PAD} y1={rsiY(70)} x2={W - PAD} y2={rsiY(70)} stroke="rgba(255,138,76,0.3)" strokeDasharray="3,3" />
      <line x1={PAD} y1={rsiY(30)} x2={W - PAD} y2={rsiY(30)} stroke="rgba(0,220,195,0.3)" strokeDasharray="3,3" />
      <text x={PAD - 4} y={rsiY(70) + 3} fill="var(--warning)" fontSize="7" textAnchor="end">70</text>
      <text x={PAD - 4} y={rsiY(30) + 3} fill="var(--accent)" fontSize="7" textAnchor="end">30</text>
      {rsiPath && <path d={rsiPath} fill="none" stroke="#c084fc" strokeWidth="1.2" />}
      <text x={PAD} y={H_PRICE + 6} fill="var(--ink-muted)" fontSize="8">
        <tspan fill="#c084fc">RSI(14)</tspan>
        {rsi.filter((v): v is number => v !== null).length > 0 && (
          <tspan dx="6" fill="var(--ink-soft)">{decimalFormatter.format(rsi.filter((v): v is number => v !== null).pop()!)}</tspan>
        )}
      </text>
    </svg>
  );
}

/* ── MACD Chart ──────────────────────────────────────────── */
function MACDChart({ points }: { points: Array<{ at: string; price: number }> }) {
  const prices = points.map((p) => p.price);
  const macd = calculateMACD(prices);
  if (!macd || macd.histogram.length < 2) return null;
  const W = 600, H = 100, PAD = 30;
  const { macdLine, signalLine, histogram } = macd;
  const allValues = [...macdLine, ...signalLine, ...histogram];
  const maxAbs = Math.max(...allValues.map(Math.abs), 0.01);
  const xStep = (W - PAD * 2) / (histogram.length - 1);

  function y(v: number) { return PAD + (H - PAD * 2) * (1 - v / maxAbs) / 2; }
  const zeroY = y(0);

  const macdPath = macdLine.map((v, i) => `${i === 0 ? "M" : "L"}${(PAD + i * xStep).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const signalPath = signalLine.map((v, i) => `${i === 0 ? "M" : "L"}${(PAD + i * xStep).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.techChart} aria-label="MACD 차트">
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="rgba(255,255,255,0.10)" />
      {histogram.map((v, i) => {
        const x = PAD + i * xStep;
        const barH = Math.abs(y(v) - zeroY);
        const barY = v >= 0 ? y(v) : zeroY;
        return <rect key={i} x={x - 1.5} y={barY} width={3} height={barH} fill={v >= 0 ? "var(--accent)" : "var(--warning)"} opacity="0.5" rx="0.5" />;
      })}
      <path d={macdPath} fill="none" stroke="var(--info)" strokeWidth="1.2" />
      <path d={signalPath} fill="none" stroke="var(--warning)" strokeWidth="1" opacity="0.8" />
      <text x={PAD} y={12} fill="var(--ink-muted)" fontSize="8">
        <tspan fill="var(--info)">MACD</tspan>
        <tspan dx="6" fill="var(--warning)">Signal(9)</tspan>
        <tspan dx="6" fill="var(--ink-muted)">Histogram</tspan>
      </text>
    </svg>
  );
}

/* ── Volume Profile (time-of-day activity) ───────────────── */
function VolumeProfile({ points }: { points: Array<{ at: string; price: number }> }) {
  if (points.length < 20) return null;
  const hourBuckets = new Map<number, { count: number; movement: number }>();
  for (let i = 1; i < points.length; i++) {
    const hour = new Date(points[i].at).getHours();
    const move = Math.abs(points[i].price - points[i - 1].price);
    const bucket = hourBuckets.get(hour) ?? { count: 0, movement: 0 };
    bucket.count += 1;
    bucket.movement += move;
    hourBuckets.set(hour, bucket);
  }
  const hours = [...hourBuckets.entries()].sort((a, b) => a[0] - b[0]);
  if (hours.length < 2) return null;
  const maxMove = Math.max(...hours.map(([, b]) => b.movement), 1);
  const W = 400, H = 100, PAD = 30;
  const barW = Math.max(8, (W - PAD * 2) / hours.length - 4);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.techChart} aria-label="거래량 프로필">
      {hours.map(([hour, bucket], i) => {
        const x = PAD + i * ((W - PAD * 2) / hours.length) + barW / 4;
        const barH = (bucket.movement / maxMove) * (H - PAD - 16);
        const intensity = bucket.movement / maxMove;
        const color = intensity > 0.7 ? "var(--warning)" : intensity > 0.4 ? "var(--info)" : "var(--accent)";
        return (
          <g key={hour}>
            <rect x={x} y={H - PAD - barH} width={barW} height={barH} fill={color} opacity="0.6" rx="2" />
            <text x={x + barW / 2} y={H - PAD + 10} fill="var(--ink-muted)" fontSize="7" textAnchor="middle">{hour}시</text>
          </g>
        );
      })}
      <text x={PAD} y={10} fill="var(--ink-muted)" fontSize="8">시간대별 가격 변동 강도</text>
    </svg>
  );
}

/* ── Sector Comparison ───────────────────────────────────── */
function SectorComparison({ result }: { result: DashboardResult }) {
  const overview = result.marketOverview;
  const financial = result.financials[0];
  if (!overview || !financial) return null;
  const stockPer = financial.per;
  const stockPbr = financial.pbr;
  const { sectorPer, sectorPbr, sectorName } = overview;
  if (stockPer === null && stockPbr === null) return null;
  if (sectorPer === null && sectorPbr === null) return null;

  const metrics = [
    stockPer !== null && sectorPer !== null ? { label: "PER", stock: stockPer, sector: sectorPer } : null,
    stockPbr !== null && sectorPbr !== null ? { label: "PBR", stock: stockPbr, sector: sectorPbr } : null,
  ].filter((m): m is NonNullable<typeof m> => m !== null);

  if (metrics.length === 0) return null;

  const W = 300, H = 80, PAD = 40;
  const barH = 14;

  return (
    <article className={styles.card}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>업종 비교</h2>
          <p className={styles.sectionCopy}>
            {sectorName ? `${sectorName} 업종` : "동일업종"} 평균 대비 밸류에이션 위치를 비교합니다.
          </p>
        </div>
        <span className={styles.badge}>{sectorName ?? "업종"}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.techChart} aria-label="업종 비교">
        {metrics.map((m, i) => {
          const maxVal = Math.max(m.stock, m.sector) * 1.3;
          const stockW = (m.stock / maxVal) * (W - PAD * 2);
          const sectorW = (m.sector / maxVal) * (W - PAD * 2);
          const yBase = 14 + i * 36;
          const stockTone = m.stock < m.sector ? "var(--accent)" : m.stock > m.sector * 1.5 ? "var(--warning)" : "var(--info)";
          return (
            <g key={m.label}>
              <text x={PAD - 4} y={yBase + 8} fill="var(--ink-muted)" fontSize="8" textAnchor="end">{m.label}</text>
              <rect x={PAD} y={yBase} width={stockW} height={barH} fill={stockTone} opacity="0.7" rx="3" />
              <text x={PAD + stockW + 4} y={yBase + 10} fill="var(--ink-soft)" fontSize="8">{decimalFormatter.format(m.stock)}</text>
              <rect x={PAD} y={yBase + barH + 2} width={sectorW} height={barH} fill="rgba(255,255,255,0.15)" rx="3" />
              <text x={PAD + sectorW + 4} y={yBase + barH + 12} fill="var(--ink-muted)" fontSize="7">업종 {decimalFormatter.format(m.sector)}</text>
            </g>
          );
        })}
      </svg>
    </article>
  );
}

/* ── Earnings Calendar ───────────────────────────────────── */
function EarningsCalendar({ result }: { result: DashboardResult }) {
  const overview = result.marketOverview;
  const financial = result.financials[0];
  if (!overview?.earningsDate && !financial) return null;

  const earningsDate = overview?.earningsDate;
  const daysUntil = earningsDate ? Math.ceil((new Date(earningsDate).getTime() - Date.now()) / (86400000)) : null;

  return (
    <article className={styles.card}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>실적 캘린더</h2>
          <p className={styles.sectionCopy}>예상 실적 발표 시점과 현재 회계 기간을 보여줍니다.</p>
        </div>
        <span className={styles.badge}>
          {daysUntil !== null && daysUntil > 0 ? `D-${daysUntil}` : "확인 필요"}
        </span>
      </div>
      <div className={styles.overviewGrid}>
        {financial ? (
          <div className={styles.overviewItem}>
            <span className={styles.communityMetricLabel}>현재 회계기간</span>
            <strong className={styles.financialMetricValue}>{financial.fiscalPeriod}</strong>
          </div>
        ) : null}
        {earningsDate ? (
          <div className={styles.overviewItem}>
            <span className={styles.communityMetricLabel}>다음 실적 예상</span>
            <strong className={styles.financialMetricValue}>{earningsDate}</strong>
          </div>
        ) : null}
        {daysUntil !== null && daysUntil > 0 ? (
          <div className={styles.overviewItem}>
            <span className={styles.communityMetricLabel}>남은 일수</span>
            <strong className={`${styles.financialMetricValue} ${daysUntil <= 14 ? styles.metricNegative : ""}`}>
              {daysUntil}일
            </strong>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/* ── Correlation Matrix (for compare panel) ──────────────── */
function CorrelationMatrix({ results }: { results: DashboardResult[] }) {
  if (results.length < 2) return null;
  const priceSeries = results.map((r) => ({
    name: r.companyName,
    prices: r.quote?.trendPoints.map((p) => p.price) ?? [],
  }));

  const matrix: Array<{ a: string; b: string; corr: number | null }> = [];
  for (let i = 0; i < priceSeries.length; i++) {
    for (let j = i + 1; j < priceSeries.length; j++) {
      matrix.push({
        a: priceSeries[i].name,
        b: priceSeries[j].name,
        corr: calculateCorrelation(priceSeries[i].prices, priceSeries[j].prices),
      });
    }
  }

  if (matrix.every((m) => m.corr === null)) return null;

  return (
    <div className={styles.overviewGrid}>
      {matrix.map((m) => (
        <div className={styles.overviewItem} key={`${m.a}-${m.b}`}>
          <span className={styles.communityMetricLabel}>{m.a} vs {m.b}</span>
          <strong className={`${styles.financialMetricValue} ${m.corr !== null && m.corr > 0.7 ? styles.metricPositive : m.corr !== null && m.corr < -0.3 ? styles.metricNegative : ""}`}>
            {m.corr !== null ? decimalFormatter.format(m.corr) : "N/A"}
          </strong>
          <span className={styles.communityMetricLabel} style={{ textTransform: "none", letterSpacing: 0 }}>
            {m.corr !== null ? (m.corr > 0.7 ? "강한 양의 상관" : m.corr > 0.3 ? "약한 양의 상관" : m.corr > -0.3 ? "상관 없음" : m.corr > -0.7 ? "약한 음의 상관" : "강한 음의 상관") : "데이터 부족"}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Candle Chart ────────────────────────────────────────── */
function CandleChart({ points }: { points: Array<{ at: string; price: number }> }) {
  if (points.length < 10) return null;
  const candles = aggregateCandles(points, 60); // hourly candles
  if (candles.length < 2) return null;
  const W = 600, H = 160, PAD = 30;
  const allPrices = candles.flatMap((c) => [c.high, c.low]);
  const min = Math.min(...allPrices);
  const max = Math.max(...allPrices);
  const range = max - min || 1;
  const candleW = Math.max(3, Math.min(12, (W - PAD * 2) / candles.length - 2));
  const step = (W - PAD * 2) / candles.length;

  function y(v: number) { return PAD + (H - PAD * 2) * (1 - (v - min) / range); }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.techChart} aria-label="시간별 캔들차트">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD} y1={y(min + range * f)} x2={W - PAD} y2={y(min + range * f)} stroke="rgba(255,255,255,0.06)" />
          <text x={PAD - 4} y={y(min + range * f) + 3} fill="var(--ink-muted)" fontSize="8" textAnchor="end">
            {numberFormatter.format(Math.round(min + range * f))}
          </text>
        </g>
      ))}
      {candles.map((c, i) => {
        const x = PAD + i * step + step / 2;
        const isUp = c.close >= c.open;
        const color = isUp ? "var(--accent)" : "var(--warning)";
        const bodyTop = y(Math.max(c.open, c.close));
        const bodyBottom = y(Math.min(c.open, c.close));
        const bodyH = Math.max(1, bodyBottom - bodyTop);
        return (
          <g key={i}>
            <line x1={x} y1={y(c.high)} x2={x} y2={y(c.low)} stroke={color} strokeWidth="1" />
            <rect x={x - candleW / 2} y={bodyTop} width={candleW} height={bodyH} fill={isUp ? color : color} rx="1" opacity="0.85" />
          </g>
        );
      })}
      <text x={PAD} y={12} fill="var(--ink-muted)" fontSize="8">시간별 캔들 ({candles.length}봉)</text>
    </svg>
  );
}

/* ── Signal History ──────────────────────────────────────── */
const SIGNAL_HISTORY_KEY = "kstock-dashboard.signal-history";
const MAX_SIGNAL_HISTORY = 50;

type SignalHistoryEntry = {
  stockCode: string;
  analyzedAt: string;
  scores: Record<string, number>;
};

function useSignalHistory(result: DashboardResult | null) {
  const [history, setHistory] = useState<SignalHistoryEntry[]>([]);
  const savedRef = useRef(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIGNAL_HISTORY_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as SignalHistoryEntry[];
        if (Array.isArray(parsed)) setHistory(parsed);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!result || savedRef.current) return;
    savedRef.current = true;
    const entry: SignalHistoryEntry = {
      stockCode: result.stockCode,
      analyzedAt: result.analyzedAt,
      scores: Object.fromEntries(result.signals.map((s) => [s.horizon, s.score])),
    };
    setHistory((prev) => {
      const next = [entry, ...prev.filter((e) => !(e.stockCode === entry.stockCode && e.analyzedAt === entry.analyzedAt))].slice(0, MAX_SIGNAL_HISTORY);
      try { window.localStorage.setItem(SIGNAL_HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    return () => { savedRef.current = false; };
  }, [result]);

  return history;
}

function SignalHistoryChart({ history, stockCode }: { history: SignalHistoryEntry[]; stockCode: string }) {
  const entries = history.filter((e) => e.stockCode === stockCode).reverse();
  if (entries.length < 2) return null;
  const W = 400, H = 100, PAD = 24;
  const xStep = (W - PAD * 2) / (entries.length - 1);
  const horizons = ["1d", "1w", "1m"] as const;
  const colors = { "1d": "var(--accent)", "1w": "var(--info)", "1m": "#c084fc" };

  function y(score: number) { return PAD + (H - PAD * 2) * (1 - (score + 1) / 2); }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.techChart} aria-label="시그널 히스토리">
      <line x1={PAD} y1={y(0)} x2={W - PAD} y2={y(0)} stroke="rgba(255,255,255,0.10)" strokeDasharray="3,3" />
      <text x={PAD - 4} y={y(0) + 3} fill="var(--ink-muted)" fontSize="7" textAnchor="end">0</text>
      {horizons.map((h) => {
        const path = entries
          .map((e, i) => {
            const score = e.scores[h] ?? 0;
            return `${i === 0 ? "M" : "L"}${(PAD + i * xStep).toFixed(1)},${y(score).toFixed(1)}`;
          })
          .join(" ");
        return <path key={h} d={path} fill="none" stroke={colors[h]} strokeWidth="1.5" opacity="0.8" />;
      })}
      <text x={PAD} y={10} fill="var(--ink-muted)" fontSize="8">
        <tspan fill="var(--accent)">1D</tspan>
        <tspan dx="6" fill="var(--info)">1W</tspan>
        <tspan dx="6" fill="#c084fc">1M</tspan>
        <tspan dx="6" fill="var(--ink-muted)">({entries.length}회 기록)</tspan>
      </text>
    </svg>
  );
}

/* ── Investor Chart ──────────────────────────────────────── */
function InvestorChart({ overview }: { overview: DashboardResult["marketOverview"] }) {
  if (!overview) return null;
  const { foreignNetVolume, institutionalNetVolume } = overview;
  if (foreignNetVolume === null && institutionalNetVolume === null) return null;
  const values = [
    { label: "외국인", value: foreignNetVolume ?? 0 },
    { label: "기관", value: institutionalNetVolume ?? 0 },
  ];
  const maxAbs = Math.max(...values.map((v) => Math.abs(v.value)), 1);
  const W = 300, H = 80, BAR_H = 20, PAD = 50;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.techChart} aria-label="투자자별 수급">
      <line x1={W / 2} y1={0} x2={W / 2} y2={H} stroke="rgba(255,255,255,0.08)" />
      {values.map((v, i) => {
        const barW = (Math.abs(v.value) / maxAbs) * (W / 2 - PAD);
        const isPositive = v.value >= 0;
        const x = isPositive ? W / 2 : W / 2 - barW;
        const yPos = 16 + i * (BAR_H + 14);
        const color = isPositive ? "var(--accent)" : "var(--warning)";
        return (
          <g key={v.label}>
            <text x={isPositive ? W / 2 - 4 : W / 2 + 4} y={yPos + BAR_H / 2 + 3} fill="var(--ink-muted)" fontSize="9" textAnchor={isPositive ? "end" : "start"}>{v.label}</text>
            <rect x={x} y={yPos} width={barW} height={BAR_H} fill={color} opacity="0.7" rx="3" />
            <text x={isPositive ? x + barW + 4 : x - 4} y={yPos + BAR_H / 2 + 3} fill="var(--ink-soft)" fontSize="8" textAnchor={isPositive ? "start" : "end"}>
              {formatLargeNumber(v.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── Compare Panel ───────────────────────────────────────── */
function ComparePanel({
  currentResult,
  onNavigate,
}: {
  currentResult: DashboardResult | null;
  onNavigate: (code: string) => void;
}) {
  const [compareCodes, setCompareCodes] = useState<string[]>([]);
  const [compareResults, setCompareResults] = useState<DashboardResult[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);

  async function addCompare() {
    const code = sanitizeStockCodeDigits(inputValue);
    if (!/^\d{6}$/.test(code) || compareCodes.includes(code)) return;
    if (currentResult && code === currentResult.stockCode) return;
    setLoading(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stockCode: code, horizons: ["1d", "1w", "1m"] }),
      });
      const payload = await response.json() as DashboardResult | null;
      if (payload && "signals" in payload) {
        setCompareCodes((prev) => [...prev, code].slice(0, 3));
        setCompareResults((prev) => [...prev, payload].slice(0, 3));
      }
    } catch { /* ignore */ }
    setLoading(false);
    setInputValue("");
  }

  function removeCompare(code: string) {
    setCompareCodes((prev) => prev.filter((c) => c !== code));
    setCompareResults((prev) => prev.filter((r) => r.stockCode !== code));
  }

  const allResults = [currentResult, ...compareResults].filter((r): r is DashboardResult => r !== null);
  if (!currentResult) return null;

  return (
    <article className={styles.card}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>종목 비교</h2>
          <p className={styles.sectionCopy}>최대 3종목을 추가하여 시그널과 주요 지표를 나란히 비교합니다.</p>
        </div>
        <span className={styles.badge}>{allResults.length}종목</span>
      </div>
      <div className={styles.fieldRow}>
        <input
          className={styles.input}
          placeholder="비교할 종목 코드"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addCompare(); } }}
        />
        <button className={styles.submit} type="button" disabled={loading || compareCodes.length >= 3} onClick={() => void addCompare()}>
          {loading ? "로딩..." : "추가"}
        </button>
      </div>
      {compareCodes.length > 0 ? (
        <div className={styles.configStrip}>
          {compareCodes.map((code) => {
            const r = compareResults.find((x) => x.stockCode === code);
            return (
              <button key={code} className={styles.recentSearchChip} type="button" onClick={() => removeCompare(code)}>
                <span>{code}</span>
                <span>{r?.companyName ?? "..."}</span>
                <span style={{ opacity: 0.5 }}>x</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {allResults.length > 1 ? (
        <div className={styles.compareTable}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.tableHeader}>지표</th>
                {allResults.map((r) => (
                  <th key={r.stockCode} className={styles.tableHeader}>
                    <button className={styles.tableHeaderBtn} type="button" onClick={() => onNavigate(r.stockCode)}>
                      {r.companyName}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={styles.tableCell}>현재가</td>
                {allResults.map((r) => (
                  <td key={r.stockCode} className={styles.tableCell}>
                    {r.quote ? `${numberFormatter.format(r.quote.currentPrice)}원` : "--"}
                  </td>
                ))}
              </tr>
              <tr>
                <td className={styles.tableCell}>등락률</td>
                {allResults.map((r) => (
                  <td key={r.stockCode} className={`${styles.tableCell} ${r.quote && r.quote.changePercent > 0 ? styles.metricPositive : r.quote && r.quote.changePercent < 0 ? styles.metricNegative : ""}`}>
                    {r.quote ? formatSignedPercent(r.quote.changePercent) : "--"}
                  </td>
                ))}
              </tr>
              {(["1d", "1w", "1m"] as const).map((h) => (
                <tr key={h}>
                  <td className={styles.tableCell}>{formatHorizonLabel(h)} 시그널</td>
                  {allResults.map((r) => {
                    const sig = r.signals.find((s) => s.horizon === h);
                    return (
                      <td key={r.stockCode} className={`${styles.tableCell} ${sig && sig.score > 0.2 ? styles.metricPositive : sig && sig.score < -0.2 ? styles.metricNegative : ""}`}>
                        {sig ? `${formatDirection(sig.direction)} ${decimalFormatter.format(sig.score)}` : "--"}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td className={styles.tableCell}>PER</td>
                {allResults.map((r) => (
                  <td key={r.stockCode} className={styles.tableCell}>
                    {r.financials[0]?.per !== null && r.financials[0]?.per !== undefined ? decimalFormatter.format(r.financials[0].per) : "--"}
                  </td>
                ))}
              </tr>
              <tr>
                <td className={styles.tableCell}>PBR</td>
                {allResults.map((r) => (
                  <td key={r.stockCode} className={styles.tableCell}>
                    {r.financials[0]?.pbr !== null && r.financials[0]?.pbr !== undefined ? decimalFormatter.format(r.financials[0].pbr) : "--"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          {/* Correlation Analysis */}
          {allResults.length >= 2 ? (
            <div style={{ marginTop: 12 }}>
              <p className={styles.diagnosticTitle}>상관관계 분석</p>
              <CorrelationMatrix results={allResults} />
            </div>
          ) : null}
        </div>
      ) : (
        <p className={styles.emptyState}>비교할 종목 코드를 입력하면 현재 종목과 나란히 비교합니다.</p>
      )}
    </article>
  );
}

/* ── PDF Export ───────────────────────────────────────────── */
function handlePrint() {
  window.print();
}

/* ── Helpers ─────────────────────────────────────────────── */
function formatLargeNumber(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000_000) return `${sign}${decimalFormatter.format(abs / 1_000_000_000_000)}조`;
  if (abs >= 100_000_000) return `${sign}${numberFormatter.format(Math.round(abs / 100_000_000))}억`;
  if (abs >= 10_000) return `${sign}${numberFormatter.format(Math.round(abs / 10_000))}만`;
  return numberFormatter.format(value);
}
