import { NextRequest, NextResponse } from "next/server";

import { env } from "@/lib/env";
import {
  CommunityLookupSourceError,
  CommunityLookupValidationError,
  STOCK_COMMUNITY_SOURCE_ID,
  resolvePublicCommunityReaction,
} from "@/lib/stock-community";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!env.ENABLE_COMMUNITY_SOURCE) {
    return NextResponse.json(
      {
        error: {
          sourceId: STOCK_COMMUNITY_SOURCE_ID,
          summary: "Community collection is disabled by configuration.",
        },
      },
      { status: 503 },
    );
  }

  const stockCode = request.nextUrl.searchParams.get("stockCode") ?? "";
  const companyName = request.nextUrl.searchParams.get("companyName") ?? "";

  try {
    const result = await resolvePublicCommunityReaction(stockCode, companyName);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CommunityLookupValidationError) {
      return NextResponse.json(
        {
          error: error.validationError,
        },
        { status: error.statusCode },
      );
    }

    if (error instanceof CommunityLookupSourceError) {
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
          summary: "Unexpected community lookup failure.",
        },
      },
      { status: 500 },
    );
  }
}
