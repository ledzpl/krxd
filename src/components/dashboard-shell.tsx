"use client";

import { FormEvent, useEffect, useState } from "react";

import type {
  CommunityLookupResult,
  NewsLookupResult,
  QuoteLookupResult,
} from "@/lib/normalized-schemas";

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

type QuoteApiError = {
  error?: {
    summary?: string;
    issues?: Array<{
      message?: string;
    }>;
  };
};

type NewsApiError = {
  error?: {
    summary?: string;
    issues?: Array<{
      message?: string;
    }>;
  };
};

type CommunityApiError = {
  error?: {
    summary?: string;
    issues?: Array<{
      message?: string;
    }>;
  };
};

const numberFormatter = new Intl.NumberFormat("ko-KR");
const percentFormatter = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const placeholderSections = [
  {
    title: "Disclosures",
    badge: "Queued for US-006",
    copy: "Regulatory filings and importance scoring will stack in this panel.",
    rows: [
      ["KIND disclosure placeholder", "Category, importance, published time"],
      ["Corporate action placeholder", "Link, time, normalized summary"],
    ],
  },
  {
    title: "Financial Summary",
    badge: "Queued for US-007",
    copy: "Quarterly revenue, profit, valuation multiples, and capture time will live here.",
    rows: [
      ["Revenue placeholder", "Quarter, YoY change, source"],
      ["Valuation placeholder", "PER, PBR, EPS, BPS"],
    ],
  },
];

const defaultNewsFeedback =
  "Recent headlines, summaries, sentiment, and publisher timestamps will appear after a successful quote lookup.";
const defaultCommunityFeedback =
  "Public community reaction will appear after a successful quote lookup, with unavailable sources skipped automatically.";

const signals = [
  {
    horizon: "1D",
    score: "Pending",
    reasons: [
      "Quote momentum will be weighted most heavily for same-day direction.",
      "Freshness guards will cap confidence if recent evidence is stale.",
    ],
  },
  {
    horizon: "1W",
    score: "Pending",
    reasons: [
      "Balanced weighting will combine quote, news, community, disclosures, and financials.",
      "Partial source outages will remain visible instead of hiding the dashboard.",
    ],
  },
  {
    horizon: "1M",
    score: "Pending",
    reasons: [
      "Financial context will carry more weight on longer-horizon scoring.",
      "Every future signal card will explain confidence and top supporting evidence.",
    ],
  },
];

export function DashboardShell({ config }: DashboardShellProps) {
  const [stockCode, setStockCode] = useState("005930");
  const [feedback, setFeedback] = useState(
    "Enter a 6-digit Korean stock code to resolve the listing and collect a live quote snapshot.",
  );
  const [isInvalid, setIsInvalid] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isNewsLoading, setIsNewsLoading] = useState(false);
  const [isCommunityLoading, setIsCommunityLoading] = useState(false);
  const [quoteResult, setQuoteResult] = useState<QuoteLookupResult | null>(null);
  const [newsResult, setNewsResult] = useState<NewsLookupResult | null>(null);
  const [communityResult, setCommunityResult] = useState<CommunityLookupResult | null>(
    null,
  );
  const [newsFeedback, setNewsFeedback] = useState(defaultNewsFeedback);
  const [communityFeedback, setCommunityFeedback] = useState(
    defaultCommunityFeedback,
  );

  const sourceSummary = config.enabledSources.map(({ label, enabled }) => ({
    label,
    state: enabled ? "Enabled" : "Disabled",
  }));
  const isNewsEnabled =
    config.enabledSources.find((source) => source.label === "News")?.enabled ?? false;
  const isCommunityEnabled =
    config.enabledSources.find((source) => source.label === "Community")?.enabled ??
    false;

  useEffect(() => {
    void lookupQuote("005930", true);
  }, []);

  function resetNewsState(message = defaultNewsFeedback) {
    setIsNewsLoading(false);
    setNewsResult(null);
    setNewsFeedback(message);
  }

  function resetCommunityState(message = defaultCommunityFeedback) {
    setIsCommunityLoading(false);
    setCommunityResult(null);
    setCommunityFeedback(message);
  }

  async function lookupNews(
    resolvedStockCode: string,
    companyName: string,
    isInitialLoad = false,
  ) {
    if (!isNewsEnabled) {
      resetNewsState("News collection is disabled by configuration.");
      return;
    }

    setIsNewsLoading(true);
    setNewsFeedback(
      isInitialLoad
        ? `Loading recent news for ${companyName} (${resolvedStockCode})...`
        : `Collecting recent news for ${companyName}...`,
    );

    try {
      const response = await fetch(
        `/api/news?stockCode=${encodeURIComponent(resolvedStockCode)}&companyName=${encodeURIComponent(companyName)}`,
        {
          cache: "no-store",
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | NewsLookupResult
        | NewsApiError
        | null;

      if (
        !response.ok ||
        !payload ||
        typeof payload !== "object" ||
        !("news" in payload)
      ) {
        const apiError = payload as NewsApiError | null;
        const issueMessage = apiError?.error?.issues?.[0]?.message;
        const summary = apiError?.error?.summary;

        setNewsResult(null);
        setNewsFeedback(
          issueMessage ??
            summary ??
            `News lookup failed with status ${response.status}.`,
        );
        return;
      }

      const discardedCount = payload.diagnostics.filter((diagnostic) =>
        diagnostic.code.startsWith("discarded-"),
      ).length;

      setNewsResult(payload);
      setNewsFeedback(
        payload.news.length > 0
          ? `Loaded ${payload.news.length} recent articles via ${payload.source.source}${discardedCount > 0 ? ` with ${discardedCount} discarded during normalization.` : "."}`
          : discardedCount > 0
            ? "No valid recent articles remained after normalization."
            : `No recent articles were returned for ${companyName}.`,
      );
    } catch {
      setNewsResult(null);
      setNewsFeedback("News lookup failed because the source request could not be completed.");
    } finally {
      setIsNewsLoading(false);
    }
  }

  async function lookupCommunity(
    resolvedStockCode: string,
    companyName: string,
    isInitialLoad = false,
  ) {
    if (!isCommunityEnabled) {
      resetCommunityState("Community collection is disabled by configuration.");
      return;
    }

    setIsCommunityLoading(true);
    setCommunityFeedback(
      isInitialLoad
        ? `Loading public community reaction for ${companyName} (${resolvedStockCode})...`
        : `Collecting public community reaction for ${companyName}...`,
    );

    try {
      const response = await fetch(
        `/api/community?stockCode=${encodeURIComponent(resolvedStockCode)}&companyName=${encodeURIComponent(companyName)}`,
        {
          cache: "no-store",
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | CommunityLookupResult
        | CommunityApiError
        | null;

      if (
        !response.ok ||
        !payload ||
        typeof payload !== "object" ||
        !("community" in payload)
      ) {
        const apiError = payload as CommunityApiError | null;
        const issueMessage = apiError?.error?.issues?.[0]?.message;
        const summary = apiError?.error?.summary;

        setCommunityResult(null);
        setCommunityFeedback(
          issueMessage ??
            summary ??
            `Community lookup failed with status ${response.status}.`,
        );
        return;
      }

      const unavailableSources = payload.sourceStatus.filter(
        (status) => status.status !== "ready",
      ).length;

      setCommunityResult(payload);
      setCommunityFeedback(
        payload.community.length > 0
          ? `Loaded ${payload.community.length} public posts with ${payload.summary.bullishCount} bullish, ${payload.summary.bearishCount} bearish, and ${payload.summary.neutralCount} neutral mentions.${unavailableSources > 0 ? ` ${unavailableSources} unavailable sources were skipped.` : ""}`
          : unavailableSources > 0
            ? `No validated public community posts remained. ${unavailableSources} unavailable sources were skipped without bypass attempts.`
            : `No recent public community posts were returned for ${companyName}.`,
      );
    } catch {
      setCommunityResult(null);
      setCommunityFeedback(
        "Community lookup failed because the source request could not be completed.",
      );
    } finally {
      setIsCommunityLoading(false);
    }
  }

  async function lookupQuote(requestedCode: string, isInitialLoad = false) {
    const normalized = requestedCode.trim();

    setIsLoading(true);
    setIsInvalid(false);
    resetNewsState(
      isNewsEnabled
        ? "Recent news will load after a successful quote lookup."
        : "News collection is disabled by configuration.",
    );
    resetCommunityState(
      isCommunityEnabled
        ? "Public community reaction will load after a successful quote lookup."
        : "Community collection is disabled by configuration.",
    );
    setFeedback(
      isInitialLoad
        ? `Loading live quote data for ${normalized}...`
        : `Resolving ${normalized} and collecting current market data...`,
    );

    try {
      const response = await fetch(
        `/api/quote?stockCode=${encodeURIComponent(normalized)}`,
        {
          cache: "no-store",
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | QuoteLookupResult
        | QuoteApiError
        | null;

      if (
        !response.ok ||
        !payload ||
        typeof payload !== "object" ||
        !("quote" in payload)
      ) {
        const apiError = payload as QuoteApiError | null;
        const issueMessage = apiError?.error?.issues?.[0]?.message;
        const summary = apiError?.error?.summary;

        setQuoteResult(null);
        setIsInvalid(response.status === 400);
        resetNewsState(
          isNewsEnabled
            ? "Resolve a valid stock code to load recent news."
            : "News collection is disabled by configuration.",
        );
        resetCommunityState(
          isCommunityEnabled
            ? "Resolve a valid stock code to load public community reaction."
            : "Community collection is disabled by configuration.",
        );
        setFeedback(
          issueMessage ??
            summary ??
            `Quote lookup failed with status ${response.status}.`,
        );
        return;
      }

      setQuoteResult(payload);
      void lookupNews(payload.stockCode, payload.companyName, isInitialLoad);
      void lookupCommunity(payload.stockCode, payload.companyName, isInitialLoad);
      setFeedback(
        `Resolved ${payload.companyName} (${payload.market}) via ${payload.resolution.source} and captured ${payload.quote.trendPoints.length} recent price points from ${payload.quote.source}.`,
      );
    } catch {
      setQuoteResult(null);
      setIsInvalid(false);
      resetNewsState(
        isNewsEnabled
          ? "Resolve a valid stock code to load recent news."
          : "News collection is disabled by configuration.",
      );
      resetCommunityState(
        isCommunityEnabled
          ? "Resolve a valid stock code to load public community reaction."
          : "Community collection is disabled by configuration.",
      );
      setFeedback("Quote lookup failed because the source request could not be completed.");
    } finally {
      setIsLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = stockCode.trim();

    if (!/^\d{6}$/.test(normalized)) {
      setQuoteResult(null);
      resetNewsState(
        isNewsEnabled
          ? "Resolve a valid stock code to load recent news."
          : "News collection is disabled by configuration.",
      );
      resetCommunityState(
        isCommunityEnabled
          ? "Resolve a valid stock code to load public community reaction."
          : "Community collection is disabled by configuration.",
      );
      setIsInvalid(true);
      setFeedback("Enter exactly six numeric digits. Example: 005930.");
      return;
    }

    void lookupQuote(normalized);
  }

  const companySummary = quoteResult
    ? `${quoteResult.companyName} · ${quoteResult.market}`
    : "Awaiting lookup";
  const companySummaryCopy = quoteResult
    ? `${quoteResult.resolution.source} confirmed the listing at ${formatTimestamp(quoteResult.resolution.capturedAt)} KST. ${quoteResult.quote.source} captured ${quoteResult.quote.trendPoints.length} recent 5-minute points at ${formatTimestamp(quoteResult.quote.capturedAt)} KST.`
    : "Company name, market, source ids, and the latest quote timestamp appear here after a successful lookup.";
  const changeTone = getTone(quoteResult?.quote.changeAmount ?? 0);
  const unavailableCommunitySources =
    communityResult?.sourceStatus.filter((status) => status.status !== "ready") ?? [];

  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <section className={styles.hero}>
          <div className={styles.heroContent}>
            <p className={styles.eyebrow}>Public Next.js dashboard scaffold</p>
            <h1 className={styles.headline}>Enter a Korean stock code.</h1>
            <p className={styles.lede}>
              The dashboard now validates the 6-digit stock code, resolves the listed
              company and market, collects a normalized public quote snapshot, pulls
              recent deduplicated news, and summarizes public community reaction
              before downstream stories add disclosures and deeper financial context.
            </p>

            <form className={styles.form} noValidate onSubmit={handleSubmit}>
              <div className={styles.fieldRow}>
                <input
                  aria-label="Stock code"
                  className={styles.input}
                  inputMode="numeric"
                  maxLength={6}
                  name="stockCode"
                  placeholder="005930"
                  value={stockCode}
                  onChange={(event) => setStockCode(event.target.value.replace(/\D/g, ""))}
                />
                <button className={styles.submit} disabled={isLoading} type="submit">
                  {isLoading ? "Loading quote..." : "Fetch quote"}
                </button>
              </div>
              <p className={styles.hint}>
                The quote source resolves company metadata, latest price, change,
                change percentage, volume, and a recent trend series. The approved
                public news source adds recent headlines, summaries, timestamps, and
                sentiment. The public community source adds retail themes,
                engagement proxies, and bullish versus bearish counts. Later stories
                add disclosures and financials.
              </p>
              <p
                aria-live="polite"
                className={`${styles.feedback} ${isInvalid ? styles.feedbackInvalid : ""}`}
              >
                {feedback}
              </p>
            </form>

            <div className={styles.configStrip}>
              <span className={styles.configTag}>
                Timeout {Math.round(config.requestTimeoutMs / 1000)}s
              </span>
              <span className={styles.configTag}>Cache TTL {config.cacheTtlSeconds}s</span>
              <span className={styles.configTag}>
                Freshness quote {config.freshness.quoteMinutes}m
              </span>
              <span className={styles.configTag}>
                Financial freshness {config.freshness.financialDays}d
              </span>
            </div>
          </div>
        </section>

        <section className={styles.summaryBand} aria-label="Summary placeholders">
          <article className={`${styles.card} ${styles.metricLead}`}>
            <p className={styles.metricTitle}>Company summary</p>
            <p className={styles.metricValue}>{companySummary}</p>
            <p className={styles.metricCopy}>{companySummaryCopy}</p>
          </article>
          <MetricCard
            label="Current price"
            value={
              quoteResult
                ? `${numberFormatter.format(quoteResult.quote.currentPrice)} KRW`
                : "--"
            }
            copy="Normalized quote snapshot"
          />
          <MetricCard
            label="Change"
            tone={changeTone}
            value={
              quoteResult ? `${formatSignedNumber(quoteResult.quote.changeAmount)} KRW` : "--"
            }
            copy="Absolute move versus the prior close"
          />
          <MetricCard
            label="Change %"
            tone={changeTone}
            value={quoteResult ? formatSignedPercent(quoteResult.quote.changePercent) : "--"}
            copy="Relative move versus the prior close"
          />
          <MetricCard
            label="Volume"
            value={quoteResult ? numberFormatter.format(quoteResult.quote.volume) : "--"}
            copy={
              quoteResult
                ? `${quoteResult.quote.trendPoints.length} recent trend points ready`
                : "Accumulated trading volume"
            }
          />
        </section>

        <section className={styles.signals} aria-label="Signal placeholders">
          {signals.map((signal) => (
            <article className={styles.card} key={signal.horizon}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>{signal.horizon} directional signal</h2>
                  <p className={styles.sectionCopy}>
                    Explainable evidence and confidence will render here.
                  </p>
                </div>
                <span className={styles.badge}>Placeholder</span>
              </div>
              <div className={styles.signalValue}>{signal.score}</div>
              <ul className={styles.signalList}>
                {signal.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </article>
          ))}
        </section>

        <section className={styles.sections} aria-label="Dashboard sections">
          <article className={`${styles.card} ${styles.newsCard}`}>
            <div className={styles.sectionHeader}>
              <div>
                <h2 className={styles.sectionTitle}>News</h2>
                <p className={styles.sectionCopy}>
                  Recent stock-related coverage is normalized into title, publisher,
                  published time, short summary, URL, and a simple sentiment label.
                </p>
              </div>
              <span className={styles.badge}>
                {!isNewsEnabled
                  ? "Disabled"
                  : isNewsLoading
                    ? "Loading"
                    : newsResult
                      ? `${newsResult.news.length} live`
                      : "Live"}
              </span>
            </div>
            <p className={styles.newsStatus}>{newsFeedback}</p>
            {newsResult?.news.length ? (
              <div className={styles.newsList}>
                {newsResult.news.map((article) => (
                  <article className={styles.newsRow} key={article.id}>
                    <div className={styles.newsMeta}>
                      <span>{article.publisher}</span>
                      <span>·</span>
                      <span>{formatTimestamp(article.publishedAt)} KST</span>
                      <span
                        className={`${styles.sentimentTag} ${
                          article.sentiment === "positive"
                            ? styles.sentimentPositive
                            : article.sentiment === "negative"
                              ? styles.sentimentNegative
                              : article.sentiment === "mixed"
                                ? styles.sentimentMixed
                                : styles.sentimentNeutral
                        }`}
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
            ) : isNewsLoading ? null : (
              <p className={styles.emptyState}>
                {isNewsEnabled
                  ? "No validated recent articles are available yet."
                  : "News collection is disabled by configuration."}
              </p>
            )}
            {newsResult?.diagnostics.length ? (
              <div className={styles.diagnosticPanel}>
                <p className={styles.diagnosticTitle}>Normalization diagnostics</p>
                <ul className={styles.diagnosticList}>
                  {newsResult.diagnostics.slice(0, 3).map((diagnostic, index) => (
                    <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
          <article className={`${styles.card} ${styles.communityCard}`}>
            <div className={styles.sectionHeader}>
              <div>
                <h2 className={styles.sectionTitle}>Community Reaction</h2>
                <p className={styles.sectionCopy}>
                  Public blog and discussion posts are normalized into title, excerpt,
                  post source, publish time, URL, engagement proxy, and a retail
                  sentiment classification.
                </p>
              </div>
              <span className={styles.badge}>
                {!isCommunityEnabled
                  ? "Disabled"
                  : isCommunityLoading
                    ? "Loading"
                    : communityResult
                      ? `${communityResult.summary.totalPosts} live`
                      : "Live"}
              </span>
            </div>
            <p className={styles.newsStatus}>{communityFeedback}</p>
            {communityResult ? (
              <div className={styles.communitySummary}>
                <div className={styles.communityMetric}>
                  <span className={styles.communityMetricLabel}>Bullish</span>
                  <strong className={styles.communityMetricValue}>
                    {communityResult.summary.bullishCount}
                  </strong>
                </div>
                <div className={styles.communityMetric}>
                  <span className={styles.communityMetricLabel}>Neutral</span>
                  <strong className={styles.communityMetricValue}>
                    {communityResult.summary.neutralCount}
                  </strong>
                </div>
                <div className={styles.communityMetric}>
                  <span className={styles.communityMetricLabel}>Bearish</span>
                  <strong className={styles.communityMetricValue}>
                    {communityResult.summary.bearishCount}
                  </strong>
                </div>
                <div className={styles.communityMetric}>
                  <span className={styles.communityMetricLabel}>Captured</span>
                  <strong className={styles.communityMetricValueSmall}>
                    {formatTimestamp(communityResult.source.capturedAt)} KST
                  </strong>
                </div>
              </div>
            ) : null}
            {communityResult?.summary.topThemes.length ? (
              <div className={styles.communityThemeBlock}>
                <p className={styles.communityThemeTitle}>Top recurring themes</p>
                <div className={styles.communityThemeList}>
                  {communityResult.summary.topThemes.map((theme) => (
                    <span className={styles.communityTheme} key={theme.label}>
                      {theme.label} · {theme.mentions}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {communityResult?.community.length ? (
              <div className={styles.communityList}>
                {communityResult.community.slice(0, 6).map((post) => (
                  <article className={styles.communityRow} key={post.id}>
                    <div className={styles.newsMeta}>
                      <span>{post.source}</span>
                      <span>·</span>
                      <span>{formatTimestamp(post.publishedAt)} KST</span>
                      <span>·</span>
                      <span>{formatEngagement(post)}</span>
                      <span
                        className={`${styles.sentimentTag} ${
                          post.sentiment === "positive"
                            ? styles.sentimentPositive
                            : post.sentiment === "negative"
                              ? styles.sentimentNegative
                              : styles.sentimentNeutral
                        }`}
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
            ) : isCommunityLoading ? null : (
              <p className={styles.emptyState}>
                {isCommunityEnabled
                  ? "No validated public community posts are available yet."
                  : "Community collection is disabled by configuration."}
              </p>
            )}
            {unavailableCommunitySources.length ? (
              <div className={styles.diagnosticPanel}>
                <p className={styles.diagnosticTitle}>Skipped sources</p>
                <ul className={styles.diagnosticList}>
                  {unavailableCommunitySources.map((status) => (
                    <li key={status.sourceId}>
                      {formatSourceLabel(status.sourceId)}:{" "}
                      {status.diagnostics.length
                        ? status.diagnostics.map((diagnostic) => diagnostic.message).join(" ")
                        : "Unavailable at runtime."}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {communityResult?.diagnostics.length ? (
              <div className={styles.diagnosticPanel}>
                <p className={styles.diagnosticTitle}>Normalization diagnostics</p>
                <ul className={styles.diagnosticList}>
                  {communityResult.diagnostics.slice(0, 3).map((diagnostic, index) => (
                    <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
          {placeholderSections.map((section) => (
            <article className={styles.card} key={section.title}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>{section.title}</h2>
                  <p className={styles.sectionCopy}>{section.copy}</p>
                </div>
                <span className={styles.badge}>{section.badge}</span>
              </div>
              <div className={styles.placeholderList}>
                {section.rows.map(([headline, meta]) => (
                  <div className={styles.placeholderRow} key={headline}>
                    <strong>{headline}</strong>
                    <span className={styles.placeholderMeta}>{meta}</span>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>

        <section className={styles.card} aria-label="Source configuration">
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Source configuration</h2>
              <p className={styles.sectionCopy}>
                Non-secret env values are already part of the shell so future adapters can
                rely on explicit request budgets and freshness rules.
              </p>
            </div>
            <span className={styles.badge}>Validated at startup</span>
          </div>
          <div className={styles.configStrip}>
            {sourceSummary.map((source) => (
              <span className={styles.configTag} key={source.label}>
                {source.label}: {source.state}
              </span>
            ))}
            <span className={styles.configTag}>
              News freshness: {config.freshness.newsHours}h
            </span>
            <span className={styles.configTag}>
              Community freshness: {config.freshness.communityHours}h
            </span>
            <span className={styles.configTag}>
              Disclosure freshness: {config.freshness.disclosureHours}h
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}

type MetricCardProps = {
  label: string;
  value: string;
  copy: string;
  tone?: "neutral" | "positive" | "negative";
};

function MetricCard({
  label,
  value,
  copy,
  tone = "neutral",
}: MetricCardProps) {
  return (
    <article className={`${styles.card} ${styles.metricLead}`}>
      <p className={styles.metricTitle}>{label}</p>
      <p
        className={`${styles.metricValue} ${
          tone === "positive"
            ? styles.metricPositive
            : tone === "negative"
              ? styles.metricNegative
              : ""
        }`}
      >
        {value}
      </p>
      <p className={styles.metricCopy}>{copy}</p>
    </article>
  );
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
  const absoluteValue = percentFormatter.format(Math.abs(value));

  if (value > 0) {
    return `+${absoluteValue}%`;
  }

  if (value < 0) {
    return `-${absoluteValue}%`;
  }

  return `${absoluteValue}%`;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
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

function formatSentiment(sentiment: NewsLookupResult["news"][number]["sentiment"]) {
  switch (sentiment) {
    case "positive":
      return "Positive";
    case "negative":
      return "Negative";
    case "mixed":
      return "Mixed";
    case "unknown":
      return "Unknown";
    default:
      return "Neutral";
  }
}

function formatCommunitySentiment(
  sentiment: CommunityLookupResult["community"][number]["sentiment"],
) {
  switch (sentiment) {
    case "positive":
      return "Bullish";
    case "negative":
      return "Bearish";
    default:
      return "Neutral";
  }
}

function formatEngagement(post: CommunityLookupResult["community"][number]) {
  const likes = post.engagement.likes ?? 0;
  const comments = post.engagement.comments ?? 0;
  const total = likes + comments;

  if (total === 0) {
    return "Engagement low";
  }

  return `Engagement ${numberFormatter.format(total)} (${numberFormatter.format(
    likes,
  )} likes, ${numberFormatter.format(comments)} comments)`;
}

function formatSourceLabel(sourceId: string) {
  return sourceId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
