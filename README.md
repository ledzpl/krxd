# KStock Dashboard

This repository bootstraps the public Korean stock dashboard as a Next.js App Router project with TypeScript, `npm`, and fail-fast environment validation.

## Local development

Requirements:

- Node.js `>=20.9.0`
- npm `>=10`

Setup:

1. Run `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Adjust the non-secret runtime values for your environment.
4. Start the app with `npm run dev`.
5. Open `http://localhost:3000`.

The home route serves a stock-code entry form plus placeholder dashboard sections so the collection stories can layer on top without more setup.

## Environment configuration

The app validates required non-secret configuration in `src/lib/env.ts` during `next dev`, `next build`, and `next start`. Missing or invalid values throw a descriptive error instead of silently falling back.

Required variables:

| Variable | Purpose |
| --- | --- |
| `REQUEST_TIMEOUT_MS` | Upstream fetch timeout budget in milliseconds |
| `CACHE_TTL_SECONDS` | Server-side cache lifetime for public-source responses |
| `DEFAULT_USER_AGENT` | Shared public-source user agent string |
| `QUOTE_FRESHNESS_MINUTES` | Freshness threshold for quote data |
| `NEWS_FRESHNESS_HOURS` | Freshness threshold for news |
| `COMMUNITY_FRESHNESS_HOURS` | Freshness threshold for community posts |
| `DISCLOSURE_FRESHNESS_HOURS` | Freshness threshold for disclosures |
| `FINANCIAL_FRESHNESS_DAYS` | Freshness threshold for financial snapshots |
| `ENABLE_QUOTE_SOURCE` | Quote source toggle |
| `ENABLE_NEWS_SOURCE` | News source toggle |
| `ENABLE_COMMUNITY_SOURCE` | Community source toggle |
| `ENABLE_DISCLOSURE_SOURCE` | Disclosure source toggle |
| `ENABLE_FINANCIAL_SOURCE` | Financial source toggle |

## Build and deployment

Use `npm run build` as the required quality gate. The project is configured with `output: "standalone"` in `next.config.ts`, which keeps it ready for Vercel or any Node-compatible host that can run `npm run start`.

Production checklist:

1. Install dependencies with `npm install`.
2. Provide the same required environment variables listed in `.env.example`.
3. Run `npm run build`.
4. Launch the server with `npm run start`.

Because the runtime has no API keys in v1, all documented variables are safe to define through standard public-app deployment controls.
