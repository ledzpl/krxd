import { DashboardShell } from "@/components/dashboard-shell";
import { env } from "@/lib/env";

export default function HomePage() {
  return (
    <DashboardShell
      config={{
        requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
        cacheTtlSeconds: env.CACHE_TTL_SECONDS,
        freshness: {
          quoteMinutes: env.QUOTE_FRESHNESS_MINUTES,
          newsHours: env.NEWS_FRESHNESS_HOURS,
          communityHours: env.COMMUNITY_FRESHNESS_HOURS,
          disclosureHours: env.DISCLOSURE_FRESHNESS_HOURS,
          financialDays: env.FINANCIAL_FRESHNESS_DAYS,
        },
        enabledSources: [
          { label: "Quote", enabled: env.ENABLE_QUOTE_SOURCE },
          { label: "News", enabled: env.ENABLE_NEWS_SOURCE },
          { label: "Community", enabled: env.ENABLE_COMMUNITY_SOURCE },
          { label: "Disclosures", enabled: env.ENABLE_DISCLOSURE_SOURCE },
          { label: "Financials", enabled: env.ENABLE_FINANCIAL_SOURCE },
        ],
      }}
    />
  );
}
