import { z } from "zod";

function wholeNumberString(name: string, minimum: number) {
  return z
    .string()
    .trim()
    .min(1, `${name} is required`)
    .refine((value) => /^\d+$/.test(value), `${name} must be a whole number`)
    .transform((value) => Number(value))
    .refine((value) => value >= minimum, `${name} must be at least ${minimum}`);
}

function booleanString(name: string) {
  return z
    .string()
    .trim()
    .min(1, `${name} is required`)
    .refine(
      (value) => value === "true" || value === "false",
      `${name} must be either "true" or "false"`,
    )
    .transform((value) => value === "true");
}

const envSchema = z.object({
  REQUEST_TIMEOUT_MS: wholeNumberString("REQUEST_TIMEOUT_MS", 1000),
  CACHE_TTL_SECONDS: wholeNumberString("CACHE_TTL_SECONDS", 1),
  DEFAULT_USER_AGENT: z.string().trim().min(1, "DEFAULT_USER_AGENT is required"),
  QUOTE_FRESHNESS_MINUTES: wholeNumberString("QUOTE_FRESHNESS_MINUTES", 1),
  NEWS_FRESHNESS_HOURS: wholeNumberString("NEWS_FRESHNESS_HOURS", 1),
  COMMUNITY_FRESHNESS_HOURS: wholeNumberString("COMMUNITY_FRESHNESS_HOURS", 1),
  DISCLOSURE_FRESHNESS_HOURS: wholeNumberString("DISCLOSURE_FRESHNESS_HOURS", 1),
  FINANCIAL_FRESHNESS_DAYS: wholeNumberString("FINANCIAL_FRESHNESS_DAYS", 1),
  ENABLE_QUOTE_SOURCE: booleanString("ENABLE_QUOTE_SOURCE"),
  ENABLE_NEWS_SOURCE: booleanString("ENABLE_NEWS_SOURCE"),
  ENABLE_COMMUNITY_SOURCE: booleanString("ENABLE_COMMUNITY_SOURCE"),
  ENABLE_DISCLOSURE_SOURCE: booleanString("ENABLE_DISCLOSURE_SOURCE"),
  ENABLE_FINANCIAL_SOURCE: booleanString("ENABLE_FINANCIAL_SOURCE"),
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

export function validateEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formattedIssues = result.error.issues
      .map((issue) => {
        const key = issue.path[0];
        return `- ${String(key)}: ${issue.message}`;
      })
      .join("\n");

    throw new Error(
      `Invalid environment configuration.\n${formattedIssues}\nCopy .env.example to .env.local and provide valid non-secret values before starting the app.`,
    );
  }

  cachedEnv = result.data;
  return cachedEnv;
}

export const env = validateEnv();
