
Goal: Get an AI coding agent productive quickly by describing the repo shape, developer workflows, and project-specific conventions you must follow.

- **Big picture**: Voice-first nutrition tracker. Frontend PWA (`frontend/pwa`) talks to a Node API (`backend/api`). A preprocessing pipeline (`backend/preprocess`) normalizes many JSON slices from `data/` and writes a searchable DB (`backend/db/nutrition.db`). A small local-LLM helper (`backend/llm`) estimates nutrition when a match isn't found.

- **Service boundaries**:
  - `frontend/pwa`: UI, voice input, service worker, local caching; expects API at `window.API_BASE` (dev default `http://localhost:4000/api`).
  - `backend/api`: thin route handlers in `routes/`; business logic in `services/`; DB access in `db/`; schema/validation in `schemas/`.
  - `backend/preprocess`: idempotent ingestion + normalization from `data/*` → writes `backend/db/nutrition.db` (SQLite FTS5 or DuckDB).
  - `backend/llm`: prompt templates (`prompt/`), runners (`runner/`), validators (`validators/`), and a `cache/` to memoize estimates.

- **Key files to inspect first**:
  - `README.md` (repo root) — quickstart + Docker notes.
  - `backend/api/README.md` — route/service/db layout and dev commands.
  - `backend/preprocess/README.md` — ingestion flow and output DB.
  - `backend/llm/README.md` — LLM output JSON contract and validators.
  - `frontend/pwa/README.md` — PWA expectations and client API location (`lib/api`).

- **Concrete workflows / exact commands** (copy-paste these):
```
cd backend/api && npm install
# From repo root (dev stubbed flow)
npm run dev
# Docker local stack (API + Ollama)
docker compose up -d
# Serve PWA locally
cd frontend/pwa && npx serve .
# Run prisma migrations inside API container
docker exec -it $(docker ps -qf name=api) npx prisma migrate deploy && npx prisma generate
```

- **Env & integrations**:
  - `DATABASE_URL`: SQLite (default) or Postgres.
  - `JWT_SECRET`: session signing.
  - `OLLAMA_HOST`, `OLLAMA_MODEL`: when using local Ollama LLM.
  - API default port: `4000`; frontend expects `/api` via `window.API_BASE`.

- **DB & data conventions**:
  - Primary store is SQLite with FTS5. Tables: `foods`, `aliases`, `servings`, `nutrients`, `meals`, `meal_items`, `daily_totals`.
  - Matching uses FTS on `foods.name` + aliases; a trigram re-ranker is applied in `services/matcher.ts` (or equivalent).
  - Preprocess reads `data/*` JSON slices (e.g. `common_foods_*`, `grocery_brands_*`, `restaurant_foods_*`) and writes normalized rows into `backend/db/nutrition.db`.

- **LLM output contract (from `backend/llm/README.md`)** — validator expects this shape:
```json
{
  "name":"string","serving_g":number,"calories":number,
  "protein_g":number,"carbs_g":number,"fat_g":number,
  "fiber_g":number,"sugar_g":number,"sodium_mg":number,
  "confidence":number,"model_estimated":true
}
```
  - Validators enforce non-negative macros, plausible per-100g bounds, and basic calories↔macros consistency.

- **Code patterns & conventions to follow**:
  - Keep route handlers thin; put logic in `backend/api/services/*` for testability.
  - Use `backend/api/db/*` (DAL) for DB access; avoid ad-hoc SQL in handlers.
  - Preprocess scripts are idempotent; prefer incremental caches in `backend/preprocess/cache/` when available.
  - LLM adapters must be deterministic and cached — add validators + cache entries rather than relying on raw model randomness.

- **Testing & debugging**:
  - Unit tests: `backend/api/test/` — use `npx vitest` (check `backend/api/package.json`).
  - E2E (local): `docker compose up -d` → ensure Ollama model available → run migrations → serve PWA with `npx serve .` and test voice flow.

- **Where to change behavior for common tasks**:
  - Matching/re-ranking: `backend/api/services/matcher.ts`.
  - Ingestion rules/normalization: `backend/preprocess/normalize.*`.
  - New LLM prompts: `backend/llm/prompt/` and `backend/llm/runner/`.

- **Quick heuristics for agents**:
  - Prefer editing `services/` or `preprocess/` over touching route handlers directly.
  - If you change data shape (DB/LLM/API), update README snippets and add migrations/validators.
  - Keep LLM interactions deterministic: add validators + cache results.

If anything is unclear or you want a short example patch updating `services/matcher.ts` or a sample preprocess run, tell me which piece to expand.

# Copilot instructions for the Nutrition app

Goal: Help an AI coding agent be productive quickly by describing the repo architecture, developer workflows, important files, and project-specific conventions.

- **Big picture**: This is a voice-first nutrition tracker with a PWA frontend (`frontend/pwa`) and a Node backend API (`backend/api`). A preprocessing pipeline (`backend/preprocess`) builds a searchable food DB from `data/` and writes `backend/db/nutrition.db` (SQLite/FTS or DuckDB). A small local-LLM integration lives in `backend/llm` to estimate nutrition when the food isn't found.

- **Major boundaries**:
  - `frontend/pwa`: UI, voice input, local caching and service worker; communicates with the backend via `window.API_BASE` (set in `index.html`) and expects `http://localhost:4000/api` in local dev.
  - `backend/api`: HTTP routes (thin handlers in `routes/`) and business logic in `services/`. DB access lives in `db/` and validation/schema code in `schemas/`.
  - `backend/preprocess`: build/normalize data from `data/` and populate `backend/db/nutrition.db` for the API to use.
  - `backend/llm`: prompt templates (`prompt/`), runner adapters (`runner/`), validators (`validators/`), and a `cache/` for memoized estimates.

- **Key files and dirs to inspect first**:
  - `README.md` (repo root) — quick start, ports, and docker notes.
  - `backend/api/README.md` — routes/services/db layout and where to add handlers.
  - `backend/llm/README.md` — expected JSON schema for LLM output and validator responsibilities.
  - `backend/preprocess/README.md` — where ingestion/normalization happens; outputs `db/nutrition.db`.
  - `frontend/pwa/README.md` — PWA structure, voice input expectations, and where the API client lives (`lib/api`).

- **Common workflows & exact commands** (use these; they are referenced in multiple READMEs):
  - Install backend deps: `cd backend/api && npm install`
  - Run API + PWA (dev stubbed flow): `npm run dev` from repo root (wires API and serves `frontend/pwa` on port 4000).
  - Start local stack with Docker (API + Ollama): `docker compose up -d` (API → `http://localhost:4000`; Ollama → `http://localhost:11434`).
  - Serve the PWA locally (static server): `cd frontend/pwa && npx serve .` (or `python3 -m http.server 5173`).
  - Run DB migrations inside API container: `docker exec -it $(docker ps -qf name=api) npx prisma migrate deploy && npx prisma generate`

- **Env vars and integration points**:
  - `DATABASE_URL` — points to SQLite (default) or Postgres for production.
  - `JWT_SECRET` — user session signing.
  - `OLLAMA_HOST`, `OLLAMA_MODEL` — local LLM host and model names when using Ollama.
  - API defaults to port `4000`; frontend expects API under `/api` via `window.API_BASE`.

- **DB & data conventions** (discoverable in `backend/db/*` and preprocess):
  - Primary store: SQLite with FTS5. Tables: `foods`, `aliases`, `servings`, `nutrients`, `meals`, `meal_items`, `daily_totals`.
  - Use FTS on `foods.name` + aliases and trigram re-ranking for fuzzy matches.
  - Preprocessing reads from `data/*` (many JSON slices like `common_foods_*`, `grocery_brands_*`, `restaurant_foods_*`) and writes normalized rows into `backend/db/nutrition.db`.

- **LLM output schema (exact example)** — the `backend/llm` README defines the JSON contract agents should expect/produce:

  ```json
  {
    "name": "string",
    "serving_g": number,
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_g": number,
    "fiber_g": number,
    "sugar_g": number,
    "sodium_mg": number,
    "confidence": number,
    "model_estimated": true
  }
  ```

  - Validators must enforce non-negative macros, reasonable per-100g bounds, and consistency between calories and macros when possible.

- **Code patterns & conventions** (be specific to this repo)
  - Routes are thin: place heavy logic in `backend/api/services/*` so it is unit-testable.
  - DB access should be encapsulated in `backend/api/db/*` (or a small DAL) — avoid raw SQL scattered in handlers.
  - Preprocess scripts are idempotent and produce `backend/db/nutrition.db` — prefer incremental caching in `backend/preprocess/cache/` when available.
  - LLM adapters must be deterministic and idempotent; cache outputs to avoid repeated model calls.

- **Testing & debugging tips**:
  - Unit tests live under `backend/api/test/` and should run against a fixture DB. Use `npx vitest` if present (check `package.json`).
  - To reproduce E2E locally: `docker compose up -d` → ensure Ollama model is pulled → run migrations → serve PWA via `npx serve .` → open PWA and test voice flow.
  - When adding new migrations, place them in `backend/api/prisma/migrations` (or `migrations/`) and test `npx prisma migrate deploy` in container.

- **Where to modify behavior for common tasks**
  - Improve matching/re-ranking: `backend/api/services/matcher.ts` (or equivalent). Add trigram reranker and tweak FTS queries there.
  - Add new ingestion rules: update `backend/preprocess/normalize.py` (or `.ts`) and regenerate `nutrition.db`.
  - Add new LLM prompt/template: `backend/llm/prompt/` and update runner in `backend/llm/runner/`.

- **When uncertain, quick heuristics for the agent**:
  - Prefer changing `services/` and `preprocess/` over directly editing route handlers.
  - If a change touches data shape (DB, LLM schema, or API payloads), update README snippets and add a migration or validator.
  - Preserve deterministic behavior for LLM interactions: add validators + caching rather than relying on model randomness.

If anything here is unclear or you want certain parts expanded (examples of `services/matcher`, a sample migration, or typical test commands), tell me which section to expand and I will iterate.
