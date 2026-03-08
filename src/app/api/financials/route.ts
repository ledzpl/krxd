import { NextRequest, NextResponse } from "next/server";

import { env } from "@/lib/env";
import {
  FinancialLookupSourceError,
  FinancialLookupValidationError,
  STOCK_FINANCIAL_SOURCE_ID,
  resolveFinancialSummary,
} from "@/lib/stock-financials";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!env.ENABLE_FINANCIAL_SOURCE) {
    return NextResponse.json(
      {
        error: {
          sourceId: STOCK_FINANCIAL_SOURCE_ID,
          summary: "Financial collection is disabled by configuration.",
        },
      },
      { status: 503 },
    );
  }

  const stockCode = request.nextUrl.searchParams.get("stockCode") ?? "";

  try {
    const result = await resolveFinancialSummary(stockCode);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FinancialLookupValidationError) {
      return NextResponse.json(
        {
          error: error.validationError,
        },
        { status: error.statusCode },
      );
    }

    if (error instanceof FinancialLookupSourceError) {
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
          summary: "Unexpected financial lookup failure.",
        },
      },
      { status: 500 },
    );
  }
}
