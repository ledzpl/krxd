# AGENTS

Operational notes for this repo:

- Install dependencies with `npm install`.
- Copy `.env.example` to `.env.local` before running the app.
- Run the development server with `npm run dev`.
- Run the required quality gate with `npm run build`.
- Start the production server with `npm run start`.
- Environment validation lives in `src/lib/env.ts` and will stop `dev`, `build`, or `start` on invalid config.
