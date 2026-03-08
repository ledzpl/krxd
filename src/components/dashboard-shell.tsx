"use client";

import { FormEvent, useEffect, useState } from "react";

import type { DashboardResult, SourceStatus } from "@/lib/normalized-schemas";
import { sanitizeStockCodeDigits } from "@/lib/stock-code";

import styles from "./dashboard-shell.module.css";

type DashboardShellProps = {
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

type DashboardState =
  | "empty"
  | "loading"
  | "success"
  | "partial-data"
  | "invalid-code"
  | "stale-data"
  | "all-sources-failed";

type RecentSearch = {
  analyzedAt: string;
  companyName: string;
  stockCode: string;
};

type AnalyzeApiError = {
  analyzedAt?: string;
  issues?: Array<{
    message?: string;
  }>;
  sourceStatus?: SourceStatus[];
  summary?: string;
  warnings?: string[];
};

const DEFAULT_HORIZONS = ["1d", "1w", "1m"] as const;
const RECENT_SEARCHES_KEY = "kstock-dashboard.recent-searches";
const MAX_RECENT_SEARCHES = 6;
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

const numberFormatter = new Intl.NumberFormat("ko-KR");
const decimalFormatter = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function DashboardShell({ config }: DashboardShellProps) {
  const [stockCode, setStockCode] = useState("");
  const [feedback, setFeedback] = useState(
    "6자리 종목 코드를 입력하면 공개 소스를 묶어 한 번에 분석합니다.",
  );
  const [isInvalid, setIsInvalid] = useState(false);
  const [isRequestFailure, setIsRequestFailure] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<DashboardResult | null>(null);
  const [error, setError] = useState<AnalyzeApiError | null>(null);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);

  useEffect(() => {
    try {
      const storedValue = window.localStorage.getItem(RECENT_SEARCHES_KEY);

      if (!storedValue) {
        return;
      }

      const parsed = JSON.parse(storedValue) as RecentSearch[];

      if (!Array.isArray(parsed)) {
        return;
      }

      setRecentSearches(
        parsed.filter(
          (entry) =>
            typeof entry?.stockCode === "string" &&
            typeof entry?.companyName === "string" &&
            typeof entry?.analyzedAt === "string",
        ),
      );
    } catch {
      window.localStorage.removeItem(RECENT_SEARCHES_KEY);
    }
  }, []);

  const currentSourceStatus = result?.sourceStatus ?? error?.sourceStatus ?? [];
  const currentWarnings = result?.warnings ?? error?.warnings ?? [];
  const staleSourceCount = currentSourceStatus.filter(
    (status) => status.status === "stale",
  ).length;
  const failedSourceCount = currentSourceStatus.filter(
    (status) => status.status === "failed",
  ).length;
  const dashboardState = getDashboardState({
    error,
    failedSourceCount,
    isInvalid,
    isLoading,
    result,
    staleSourceCount,
    warnings: currentWarnings,
  });

  async function handleAnalyze(requestedStockCode: string) {
    const normalizedStockCode = sanitizeStockCodeDigits(requestedStockCode);

    setIsLoading(true);
    setIsInvalid(false);
    setIsRequestFailure(false);
    setError(null);
    setResult(null);
    setFeedback(`${normalizedStockCode} 종목을 분석 중입니다...`);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          stockCode: normalizedStockCode,
          horizons: [...DEFAULT_HORIZONS],
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | DashboardResult
        | {
            error?: AnalyzeApiError;
          }
        | null;

      if (
        !response.ok ||
        !payload ||
        typeof payload !== "object" ||
        !("signals" in payload)
      ) {
        const apiError = (payload as { error?: AnalyzeApiError } | null)?.error ?? null;
        const invalidIssue = apiError?.issues?.[0]?.message;
        const summary =
          response.status === 400
            ? invalidIssue ??
              apiError?.summary ??
              "종목 코드는 숫자 6자리로 입력해 주세요. 예: 005930."
            : response.status === 503
              ? `${normalizedStockCode} 코드는 유효하지만 현재 공개 데이터 소스에 접근할 수 없습니다. 잠시 후 다시 시도해 주세요.`
              : apiError?.summary ?? `분석 요청이 실패했습니다. 상태 코드: ${response.status}`;

        setError(apiError);
        setIsInvalid(response.status === 400);
        setIsRequestFailure(response.status !== 400);
        setFeedback(summary);
        return;
      }

      setResult(payload);
      setError(null);
      setIsInvalid(false);
      setIsRequestFailure(false);
      setFeedback(
        payload.quote
          ? `${payload.companyName} (${payload.market}) · ${formatTimestamp(payload.analyzedAt)} 기준 · 시그널 ${payload.signals.length}개 · 경고 ${payload.warnings.length}건`
          : `${payload.companyName} (${payload.market}) 분석은 완료됐지만 실시간 시세 스냅샷은 수집되지 않았습니다. 누락 소스는 하단에서 확인할 수 있습니다.`,
      );
      persistRecentSearch({
        analyzedAt: payload.analyzedAt,
        companyName: payload.companyName,
        stockCode: payload.stockCode,
      });
    } catch {
      setError({
        summary: "분석 요청을 완료하지 못했습니다.",
      });
      setIsInvalid(false);
      setIsRequestFailure(true);
      setFeedback("분석 요청을 완료하지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }

  function persistRecentSearch(entry: RecentSearch) {
    setRecentSearches((previous) => {
      const next = [
        entry,
        ...previous.filter((item) => item.stockCode !== entry.stockCode),
      ].slice(0, MAX_RECENT_SEARCHES);

      try {
        window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors and keep the in-memory list.
      }

      return next;
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedStockCode = formData.get("stockCode");
    const normalizedStockCode = sanitizeStockCodeDigits(
      typeof submittedStockCode === "string" ? submittedStockCode : stockCode,
    );

    if (!/^\d{6}$/.test(normalizedStockCode)) {
      setResult(null);
      setError(null);
      setIsInvalid(true);
      setIsRequestFailure(false);
      setFeedback("종목 코드는 숫자 6자리로 입력해 주세요. 예: 005930.");
      return;
    }

    setStockCode(normalizedStockCode);
    void handleAnalyze(normalizedStockCode);
  }

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
                  void handleAnalyze(recentStockCode);
                }}
                onSubmit={handleSubmit}
              />

              <div className={styles.configStrip}>
                <span className={styles.configTag}>
                  응답 제한 {Math.round(config.requestTimeoutMs / 1000)}초
                </span>
                <span className={styles.configTag}>
                  캐시 {config.cacheTtlSeconds}초
                </span>
                <span className={styles.configTag}>
                  시세 신선도 {config.freshness.quoteMinutes}분
                </span>
                <span className={styles.configTag}>
                  재무 신선도 {config.freshness.financialDays}일
                </span>
              </div>
            </div>
          </div>
        </section>

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
        <PredictionCards result={result} state={dashboardState} />

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
  const quoteStatus = result?.sourceStatus.find(
    (status) => status.sourceId === STOCK_QUOTE_SOURCE_ID,
  );
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
                  <p className={styles.statusTitle}>{sourceLabels[status.sourceId] ?? status.sourceId}</p>
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
          {getSectionStateCopy(
            state,
            "검증된 최근 뉴스가 없습니다.",
          )}
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
          {getSectionStateCopy(
            state,
            "검증된 공개 커뮤니티 글이 없습니다.",
          )}
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
          {getSectionStateCopy(
            state,
            "검증된 공식 공시가 없습니다.",
          )}
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
          {getSectionStateCopy(
            state,
            "검증된 재무 스냅샷이 없습니다.",
          )}
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

function getDashboardState(options: {
  error: AnalyzeApiError | null;
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

function getMetricFallbackCopy(state: DashboardState, fallback: string) {
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

function getSectionStateCopy(state: DashboardState, successFallback: string) {
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

function formatDashboardState(state: DashboardState) {
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

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function formatSignedNumber(value: number) {
  const absoluteValue = numberFormatter.format(Math.abs(value));

  if (value > 0) {
    return `+${absoluteValue}`;
  }

  if (value < 0) {
    return `-${absoluteValue}`;
  }

  return absoluteValue;
}

function formatSignedPercent(value: number) {
  const absoluteValue = decimalFormatter.format(Math.abs(value));

  if (value > 0) {
    return `+${absoluteValue}%`;
  }

  if (value < 0) {
    return `-${absoluteValue}%`;
  }

  return `${absoluteValue}%`;
}

function formatDirection(direction: DashboardResult["signals"][number]["direction"]) {
  switch (direction) {
    case "up":
      return "상승";
    case "down":
      return "하락";
    default:
      return "보합";
  }
}

function formatConfidence(confidence: DashboardResult["signals"][number]["confidence"]) {
  switch (confidence) {
    case "high":
      return "높음";
    case "medium":
      return "보통";
    default:
      return "낮음";
  }
}

function formatSentiment(sentiment: string) {
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

function formatCommunitySentiment(sentiment: string) {
  if (sentiment === "positive") {
    return "강세";
  }

  if (sentiment === "negative") {
    return "약세";
  }

  return "중립";
}

function formatImportance(importance: string) {
  if (importance === "high") {
    return "높음";
  }

  if (importance === "medium") {
    return "보통";
  }

  return "낮음";
}

function formatSourceState(state: SourceStatus["status"]) {
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

function formatCategory(category: string) {
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

function formatFinancialMetric(value: number | null) {
  return value === null ? "없음" : numberFormatter.format(value);
}

function getTone(value: number): "neutral" | "positive" | "negative" {
  if (value > 0) {
    return "positive";
  }

  if (value < 0) {
    return "negative";
  }

  return "neutral";
}

function getSignalTone(direction: DashboardResult["signals"][number]["direction"]) {
  if (direction === "up") {
    return "positive";
  }

  if (direction === "down") {
    return "negative";
  }

  return "neutral";
}

function getStatusTone(status: SourceStatus["status"]) {
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

function getSentimentTone(sentiment: string) {
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

function getImportanceTone(importance: string) {
  if (importance === "high") {
    return "positive";
  }

  if (importance === "medium") {
    return "mixed";
  }

  return "neutral";
}

function formatEngagement(likes: number, comments: number) {
  const total = likes + comments;

  if (total === 0) {
    return "반응 적음";
  }

  return `반응 ${numberFormatter.format(total)}회`;
}

function getLatestTimestamp(values: string[]) {
  return values.reduce<string | null>((latest, current) => {
    if (!latest) {
      return current;
    }

    return Date.parse(current) > Date.parse(latest) ? current : latest;
  }, null);
}

function summarizeCommunity(community: DashboardResult["community"]) {
  const bullishCount = community.filter((post) => post.sentiment === "positive").length;
  const bearishCount = community.filter((post) => post.sentiment === "negative").length;

  return {
    totalPosts: community.length,
    bullishCount,
    bearishCount,
    neutralCount: community.length - bullishCount - bearishCount,
  };
}

function extractCommunityThemes(community: DashboardResult["community"]) {
  const counts = new Map<string, number>();

  community.forEach((post) => {
    const tokens = `${post.title} ${post.excerpt}`
      .match(/[가-힣A-Za-z]{3,}/g)
      ?.map((token) => token.trim())
      .filter((token) => !["주식", "투자", "시장", "종목", "전망", "분석"].includes(token));

    [...new Set(tokens ?? [])].forEach((token) => {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    });
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([label, mentions]) => ({ label, mentions }));
}

function countMissingMetrics(snapshot: DashboardResult["financials"][number]) {
  return getMissingMetricLabels(snapshot).length;
}

function getMissingMetricLabels(snapshot: DashboardResult["financials"][number]) {
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

function uniqueText(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function formatHorizonLabel(horizon: (typeof DEFAULT_HORIZONS)[number]) {
  switch (horizon) {
    case "1d":
      return "1일";
    case "1w":
      return "1주";
    default:
      return "1개월";
  }
}

function formatEnabledSourceLabel(label: string) {
  return enabledSourceLabels[label] ?? label;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
