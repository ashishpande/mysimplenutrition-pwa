# Chat Context Snapshot

Concise notes to resume work without rereading the full chat.

## Backend (API)
- Stack: Express + Prisma (Node 20). Main file `backend/api/src/server.js`.
- LLM strategy: DB/history first; Ollama if `OLLAMA_HOST` set; Groq if `GROQ_API_KEY` set; otherwise fallback. Health at `/api/health/llm`.
- Meal edit endpoint: `PATCH /api/meals/:mealId/items/:itemId` updates nutrients, sets `userEdited`, returns `{ ok, mealTotals, dayTotals }`.
- `recomputeDayTotals` now returns `{ userId, date, ...totals }`.
- Meal creation fixes: returns DB item IDs; daily totals recompute using mealTotals.
- Smoke test script: `backend/api/scripts/smoke.js --base=http://127.0.0.1:4000 --email=... --password=...` (register, login, create meal, edit first item, verify daily totals).
- Deployment: Dockerfile uses node:20-bullseye-slim with OpenSSL so Prisma works on Fly.

## Frontend (PWA)
- File: `frontend/pwa/src/app.js`; entry `index.html`.
- API base auto-selects localhost for local dev; otherwise Fly API URL.
- Edits: `saveItemEdits` now refreshes today, applies `mealTotals` to `state.result` and `state.today`, rehydrates nutrients, merges `dayTotals`, and renders—keeps Meal result/Day-so-far in sync after closing the editor.
- Input clears after submit; consumedAt adjusted for timezone.
- Wrangler Pages config: `frontend/pwa/wrangler.toml` with `pages_build_output_dir="."`; `API_BASE` secret set to Fly API for prod.

## Deploy/Secrets
- Fly app: `nutrition-api-spring-dust-1526`. Secrets set: DATABASE_URL (Neon), JWT_SECRET, GROQ_API_KEY, SKIP_LLM, FORCE_LLM, OLLAMA_HOST/MODEL (Ollama not installed in prod). Ensure `PORT=8080` if needed.
- Cloudflare Pages for frontend; API_BASE secret points to Fly API.
- Neon schema aligned manually (nutrient columns + `userEdited`); migration marked applied.
- `.secrets.sh` is local only, gitignored; don’t commit secrets.

## Local Run Tips
- Start DB: `docker compose up -d db`.
- Backend: `cd backend/api && npm install && npx prisma migrate deploy && npm run dev` (port 4000).
- Frontend: `cd frontend/pwa && npm install && npm run dev` (or build & serve). API_BASE auto-uses localhost on 127.0.0.1/localhost.
- Hard refresh to load latest JS.

## Known Issues/Notes
- Prod Ollama not installed; Groq used if key present.
- If meal edits revert: ensure frontend bundle rebuilt/deployed and API on latest; check PATCH response 200 and meal/day totals present.
