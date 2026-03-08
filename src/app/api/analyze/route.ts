import { NextRequest, NextResponse } from "next/server";

import {
  AnalyzeDashboardSourceError,
  AnalyzeDashboardValidationError,
  analyzeStockDashboard,
} from "@/lib/stock-analysis";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          summary: "Request body must be valid JSON.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const result = await analyzeStockDashboard(payload);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AnalyzeDashboardValidationError) {
      return NextResponse.json(
        {
          error: error.validationError,
        },
        { status: error.statusCode },
      );
    }

    if (error instanceof AnalyzeDashboardSourceError) {
      return NextResponse.json(
        {
          error: {
            analyzedAt: error.details.analyzedAt,
            sourceStatus: error.details.sourceStatus,
            stockCode: error.details.stockCode,
            summary: error.message,
            warnings: error.details.warnings,
          },
        },
        { status: error.statusCode },
      );
    }

    return NextResponse.json(
      {
        error: {
          summary: "Unexpected dashboard analysis failure.",
        },
      },
      { status: 500 },
    );
  }
}
