import { NextRequest, NextResponse } from "next/server";

import { env } from "@/lib/env";
import {
  STOCK_QUOTE_SOURCE_ID,
  QuoteLookupSourceError,
  QuoteLookupValidationError,
  resolveQuoteLookup,
} from "@/lib/stock-quote";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!env.ENABLE_QUOTE_SOURCE) {
    return NextResponse.json(
      {
        error: {
          sourceId: STOCK_QUOTE_SOURCE_ID,
          summary: "Quote collection is disabled by configuration.",
        },
      },
      { status: 503 },
    );
  }

  const stockCode = request.nextUrl.searchParams.get("stockCode") ?? "";

  try {
    const result = await resolveQuoteLookup(stockCode);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof QuoteLookupValidationError) {
      return NextResponse.json(
        {
          error: error.validationError,
        },
        { status: error.statusCode },
      );
    }

    if (error instanceof QuoteLookupSourceError) {
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
          summary: "Unexpected quote lookup failure.",
        },
      },
      { status: 500 },
    );
  }
}
