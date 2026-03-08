import { NextRequest, NextResponse } from "next/server";

import { env } from "@/lib/env";
import {
  DisclosureLookupSourceError,
  DisclosureLookupValidationError,
  STOCK_DISCLOSURE_SOURCE_ID,
  resolveRecentDisclosures,
} from "@/lib/stock-disclosures";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!env.ENABLE_DISCLOSURE_SOURCE) {
    return NextResponse.json(
      {
        error: {
          sourceId: STOCK_DISCLOSURE_SOURCE_ID,
          summary: "Disclosure collection is disabled by configuration.",
        },
      },
      { status: 503 },
    );
  }

  const stockCode = request.nextUrl.searchParams.get("stockCode") ?? "";

  try {
    const result = await resolveRecentDisclosures(stockCode);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DisclosureLookupValidationError) {
      return NextResponse.json(
        {
          error: error.validationError,
        },
        { status: error.statusCode },
      );
    }

    if (error instanceof DisclosureLookupSourceError) {
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
          summary: "Unexpected disclosure lookup failure.",
        },
      },
      { status: 500 },
    );
  }
}
