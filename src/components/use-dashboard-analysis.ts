import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { DashboardResult, SourceStatus } from "@/lib/normalized-schemas";
import { sanitizeStockCodeDigits } from "@/lib/stock-code";

import {
  DEFAULT_HORIZONS,
  getDashboardState,
  type DashboardState,
} from "./dashboard-formatters";

export type RecentSearch = {
  analyzedAt: string;
  companyName: string;
  stockCode: string;
};

export type AnalyzeApiError = {
  analyzedAt?: string;
  issues?: Array<{
    message?: string;
  }>;
  sourceStatus?: SourceStatus[];
  summary?: string;
  warnings?: string[];
};

const DEFAULT_FEEDBACK = "6자리 종목 코드를 입력하면 공개 소스를 묶어 한 번에 분석합니다.";
const MAX_RECENT_SEARCHES = 6;
const RECENT_SEARCHES_KEY = "kstock-dashboard.recent-searches";

export function useDashboardAnalysis(
  routeStockCode: string,
  requestTimeoutMs: number,
) {
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [stockCode, setStockCode] = useState("");
  const [feedback, setFeedback] = useState(DEFAULT_FEEDBACK);
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

  useEffect(() => () => abortControllerRef.current?.abort(), []);

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

  function showInvalidCodeFeedback(
    message = "종목 코드는 숫자 6자리로 입력해 주세요. 예: 005930.",
  ) {
    requestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setResult(null);
    setError(null);
    setIsInvalid(true);
    setIsRequestFailure(false);
    setIsLoading(false);
    setFeedback(message);
  }

  const analyzeStockCode = useEffectEvent(async (requestedStockCode: string) => {
    const normalizedStockCode = sanitizeStockCodeDigits(requestedStockCode);
    const requestId = requestIdRef.current + 1;
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = window.setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, requestTimeoutMs);

    requestIdRef.current = requestId;
    abortControllerRef.current?.abort();
    abortControllerRef.current = controller;

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
        signal: controller.signal,
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

      if (requestId !== requestIdRef.current) {
        return;
      }

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
          ? `${payload.companyName} (${payload.market}) · ${payload.signals.length}개 시그널 · ${payload.warnings.length}건 경고`
          : `${payload.companyName} (${payload.market}) 분석은 완료됐지만 실시간 시세 스냅샷은 수집되지 않았습니다. 누락 소스는 하단에서 확인할 수 있습니다.`,
      );
      persistRecentSearch({
        analyzedAt: payload.analyzedAt,
        companyName: payload.companyName,
        stockCode: payload.stockCode,
      });
    } catch (caughtError) {
      if (
        requestId !== requestIdRef.current ||
        (caughtError instanceof DOMException && caughtError.name === "AbortError")
      ) {
        if (!didTimeout) {
          return;
        }
      }

      if (didTimeout) {
        setError({
          summary: `응답 시간이 ${Math.round(requestTimeoutMs / 1000)}초를 넘어 요청을 중단했습니다.`,
        });
        setIsInvalid(false);
        setIsRequestFailure(true);
        setFeedback(
          `응답 시간이 ${Math.round(requestTimeoutMs / 1000)}초를 넘어 요청을 중단했습니다.`,
        );
        return;
      }

      setError({
        summary: "분석 요청을 완료하지 못했습니다.",
      });
      setIsInvalid(false);
      setIsRequestFailure(true);
      setFeedback("분석 요청을 완료하지 못했습니다.");
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  });

  useEffect(() => {
    setStockCode(routeStockCode);

    if (routeStockCode.length === 0) {
      requestIdRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setFeedback(DEFAULT_FEEDBACK);
      setIsInvalid(false);
      setIsRequestFailure(false);
      setIsLoading(false);
      setResult(null);
      setError(null);
      return;
    }

    void analyzeStockCode(routeStockCode);
  }, [routeStockCode]);

  const currentSourceStatus = result?.sourceStatus ?? error?.sourceStatus ?? [];
  const currentWarnings = result?.warnings ?? error?.warnings ?? [];
  const staleSourceCount = currentSourceStatus.filter(
    (status) => status.status === "stale",
  ).length;
  const failedSourceCount = currentSourceStatus.filter(
    (status) => status.status === "failed",
  ).length;
  const dashboardState: DashboardState = getDashboardState({
    error,
    failedSourceCount,
    isInvalid,
    isLoading,
    result,
    staleSourceCount,
    warnings: currentWarnings,
  });

  return {
    analyzeStockCode,
    currentSourceStatus,
    currentWarnings,
    dashboardState,
    error,
    feedback,
    isInvalid,
    isLoading,
    isRequestFailure,
    recentSearches,
    result,
    showInvalidCodeFeedback,
    setStockCode,
    stockCode,
  };
}
