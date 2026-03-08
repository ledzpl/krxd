import { load } from "cheerio";
import { z } from "zod";

import {
  absoluteUrlSchema,
  createStructuredValidationError,
  disclosureItemSchema,
  isoTimestampSchema,
  validateNormalizedEntity,
  type DisclosureItem,
  type StructuredValidationIssue,
  type ValidationResult,
} from "./normalized-schemas";

const KIND_SOURCE_ID = "krx-kind-disclosures";

const kindDisclosurePageSchema = z.object({
  html: z.string().trim().min(1, "html is required"),
  url: absoluteUrlSchema,
  publishedAt: isoTimestampSchema,
  categoryHint: z.string().trim().min(1).optional(),
});

const highImportanceKeywords = [
  "dividend",
  "merger",
  "spin-off",
  "rights offering",
  "share buyback",
  "material contract",
];

const mediumImportanceKeywords = [
  "earnings",
  "board resolution",
  "amendment",
  "guidance",
  "investment",
];

function extractText(
  html: ReturnType<typeof load>,
  selectors: string[],
): string | undefined {
  for (const selector of selectors) {
    const value = html(selector).first().text().trim();

    if (value) {
      return value.replace(/\s+/g, " ");
    }
  }

  return undefined;
}

function inferImportance(title: string): DisclosureItem["importance"] {
  const normalizedTitle = title.toLowerCase();

  if (highImportanceKeywords.some((keyword) => normalizedTitle.includes(keyword))) {
    return "high";
  }

  if (mediumImportanceKeywords.some((keyword) => normalizedTitle.includes(keyword))) {
    return "medium";
  }

  return "low";
}

function buildDisclosureId(url: string, publishedAt: string, title: string) {
  const urlObject = new URL(url);
  const receiptId =
    urlObject.searchParams.get("acptNo") ??
    urlObject.pathname.split("/").filter(Boolean).at(-1) ??
    "item";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const dateKey = publishedAt.slice(0, 10);

  return `${dateKey}-${receiptId}-${slug || "disclosure"}`;
}

export function normalizeKindDisclosurePage(
  input: unknown,
): ValidationResult<DisclosureItem> {
  const inputResult = kindDisclosurePageSchema.safeParse(input);

  if (!inputResult.success) {
    return {
      success: false,
      error: createStructuredValidationError(
        {
          entity: "KindDisclosurePage",
          sourceId: KIND_SOURCE_ID,
        },
        inputResult.error.issues.map<StructuredValidationIssue>((issue) => ({
          path: issue.path.map((part) =>
            typeof part === "number" ? part : String(part),
          ),
          code: issue.code,
          message: issue.message,
        })),
      ),
    };
  }

  const document = load(inputResult.data.html);
  const title =
    extractText(document, [
      "meta[property='og:title']",
      "meta[name='twitter:title']",
      ".disclosure-title",
      "h1",
      "title",
    ]) ?? "";
  const category =
    inputResult.data.categoryHint ??
    extractText(document, [".disclosure-category", ".category", ".badge"]) ??
    "general";

  if (!title) {
    return {
      success: false,
      error: createStructuredValidationError(
        {
          entity: "DisclosureItem",
          sourceId: KIND_SOURCE_ID,
        },
        [
          {
            path: ["html"],
            code: "custom",
            message: "KIND disclosure page did not include a recognizable title",
          },
        ],
        "DisclosureItem validation failed",
      ),
    };
  }

  return validateNormalizedEntity(
    disclosureItemSchema,
    {
      id: buildDisclosureId(inputResult.data.url, inputResult.data.publishedAt, title),
      source: KIND_SOURCE_ID,
      category,
      title,
      publishedAt: inputResult.data.publishedAt,
      url: inputResult.data.url,
      importance: inferImportance(title),
    },
    {
      entity: "DisclosureItem",
      sourceId: KIND_SOURCE_ID,
    },
  );
}

export const kindDisclosureExamplePage = {
  html: `
    <html>
      <head>
        <title>Samsung Electronics cash dividend decision</title>
        <meta property="og:title" content="Samsung Electronics cash dividend decision" />
      </head>
      <body>
        <main>
          <span class="category">Dividend</span>
          <h1 class="disclosure-title">Samsung Electronics cash dividend decision</h1>
        </main>
      </body>
    </html>
  `,
  url: "https://kind.krx.co.kr/disclosure/example.do?acptNo=20260307000123",
  publishedAt: "2026-03-07T06:30:00Z",
} as const;

export const kindDisclosureExampleResult = normalizeKindDisclosurePage(
  kindDisclosureExamplePage,
);
