import { NextRequest, NextResponse } from "next/server";

import { env } from "@/lib/env";
import {
  STOCK_NEWS_SOURCE_ID,
  NewsLookupSourceError,
  NewsLookupValidationError,
  resolveRecentNews,
} from "@/lib/stock-news";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!env.ENABLE_NEWS_SOURCE) {
    return NextResponse.json(
      {
        error: {
          sourceId: STOCK_NEWS_SOURCE_ID,
          summary: "News collection is disabled by configuration.",
        },
      },
      { status: 503 },
    );
  }

  const stockCode = request.nextUrl.searchParams.get("stockCode") ?? "";
  const companyName = request.nextUrl.searchParams.get("companyName") ?? "";

  try {
    const result = await resolveRecentNews(stockCode, companyName);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NewsLookupValidationError) {
      return NextResponse.json(
        {
          error: error.validationError,
        },
        { status: error.statusCode },
      );
    }

    if (error instanceof NewsLookupSourceError) {
      return NextResponse.json(
        {
          error: {
            sourceId: error.sourceId,
            summary: error.message,
          },
        },
        { status: error.statusCode },
      );
    }

    return NextResponse.json(
      {
        error: {
          summary: "Unexpected news lookup failure.",
        },
      },
      { status: 500 },
    );
  }
}
