"use client";

import { FormEvent, useEffect, useState } from "react";

import type {
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

const numberFormatter = new Intl.NumberFormat("ko-KR");
const percentFormatter = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const placeholderSections = [
  {
    title: "Community Reaction",
    badge: "Queued for US-005",
    copy: "Public forum, blog, and sentiment excerpts will appear here after source approval.",
    rows: [
      ["Retail sentiment snapshot", "Bullish, neutral, bearish mix"],
      ["High-engagement post placeholder", "Engagement, source, excerpt"],
    ],
  },
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
  const [quoteResult, setQuoteResult] = useState<QuoteLookupResult | null>(null);
  const [newsResult, setNewsResult] = useState<NewsLookupResult | null>(null);
  const [newsFeedback, setNewsFeedback] = useState(defaultNewsFeedback);

  const sourceSummary = config.enabledSources.map(({ label, enabled }) => ({
    label,
    state: enabled ? "Enabled" : "Disabled",
  }));
  const isNewsEnabled =
    config.enabledSources.find((source) => source.label === "News")?.enabled ?? false;

  useEffect(() => {
    void lookupQuote("005930", true);
  }, []);

  function resetNewsState(message = defaultNewsFeedback) {
    setIsNewsLoading(false);
    setNewsResult(null);
    setNewsFeedback(message);
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

  async function lookupQuote(requestedCode: string, isInitialLoad = false) {
    const normalized = requestedCode.trim();

    setIsLoading(true);
    setIsInvalid(false);
    resetNewsState(
      isNewsEnabled
        ? "Recent news will load after a successful quote lookup."
        : "News collection is disabled by configuration.",
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
        setFeedback(
          issueMessage ??
            summary ??
            `Quote lookup failed with status ${response.status}.`,
        );
        return;
      }

      setQuoteResult(payload);
      void lookupNews(payload.stockCode, payload.companyName, isInitialLoad);
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

  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <section className={styles.hero}>
          <div className={styles.heroContent}>
            <p className={styles.eyebrow}>Public Next.js dashboard scaffold</p>
            <h1 className={styles.headline}>Enter a Korean stock code.</h1>
            <p className={styles.lede}>
              The dashboard now validates the 6-digit stock code, resolves the listed
              company and market, collects a normalized public quote snapshot, and
              pulls recent deduplicated news before downstream stories add more
              evidence.
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
                sentiment. Later stories add community, disclosures, and financials.
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
