"use client";

import { FormEvent, useState } from "react";

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

const placeholderSections = [
  {
    title: "News",
    badge: "Queued for US-004",
    copy: "Recent headlines, summaries, sentiment, and publisher timestamps will land here.",
    rows: [
      ["Earnings headline placeholder", "Summary, publisher, sentiment"],
      ["Macro event placeholder", "Timestamps and deduped coverage"],
    ],
  },
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
    "Use the form to validate the 6-digit stock code entry flow before data collectors arrive.",
  );
  const [isInvalid, setIsInvalid] = useState(false);

  const sourceSummary = config.enabledSources.map(({ label, enabled }) => ({
    label,
    state: enabled ? "Enabled" : "Disabled",
  }));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalized = stockCode.trim();

    if (!/^\d{6}$/.test(normalized)) {
      setIsInvalid(true);
      setFeedback("Enter exactly six numeric digits. Example: 005930.");
      return;
    }

    setIsInvalid(false);
    setFeedback(
      `Stock code ${normalized} is queued for the upcoming data stories. This scaffold keeps the dashboard shell and validation flow ready.`,
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <section className={styles.hero}>
          <div className={styles.heroContent}>
            <p className={styles.eyebrow}>Public Next.js dashboard scaffold</p>
            <h1 className={styles.headline}>Enter a Korean stock code.</h1>
            <p className={styles.lede}>
              This first story wires the dashboard shell, operational docs, deployment
              basics, and environment validation so later source collectors can plug in
              without more setup work.
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
                <button className={styles.submit} type="submit">
                  Preview dashboard
                </button>
              </div>
              <p className={styles.hint}>
                Local validation is active now. Market quote, news, community,
                disclosure, and financial collection will be added in later stories.
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
            <p className={styles.metricValue}>Awaiting lookup</p>
            <p className={styles.metricCopy}>
              Company name, market, latest price, and last updated timestamp will appear
              here after quote resolution is connected.
            </p>
          </article>
          <MetricCard label="Current price" value="--" copy="Normalized quote snapshot" />
          <MetricCard label="Change" value="--" copy="Absolute move" />
          <MetricCard label="Change %" value="--" copy="Relative move" />
          <MetricCard label="Source health" value="5" copy="Configured source categories" />
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
};

function MetricCard({ label, value, copy }: MetricCardProps) {
  return (
    <article className={`${styles.card} ${styles.metricLead}`}>
      <p className={styles.metricTitle}>{label}</p>
      <p className={styles.metricValue}>{value}</p>
      <p className={styles.metricCopy}>{copy}</p>
    </article>
  );
}
