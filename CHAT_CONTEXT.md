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
- Barcode→OCR fallback: barcode lookup happens before consume; on `barcode_not_found`, opens manual entry with OCR offer; camera-based nutrition label scan uses overlay crop + preprocessing, on-device Tesseract OCR, and validation gate.
- OCR parsing pipeline: token-based nutrient extraction with bilingual keywords, unit repair, confidence scoring, and multi-capture averaging stored in `state.ocr.captures`; merged values populate `state.barcodeEntry` and `ocrConfidence`.
- Label scan overlay now includes editable fields for name + key nutrients and a "Use values" button; shows hint when name is missing.
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
 - Full local stack: `docker compose up -d --build` (frontend `http://localhost:8080`, API `http://localhost:4000`).

## Known Issues/Notes
- Prod Ollama not installed; Groq used if key present.
- If meal edits revert: ensure frontend bundle rebuilt/deployed and API on latest; check PATCH response 200 and meal/day totals present.
# 2026-01-02 Codex session notes

Summary:
- Branches: started on `hotfix/history-calories-zero`, committed local change (commit `beb3eab` "merging fix for banana nut oatmeal"), fast-forward merged into `main` and `OCR`.
- Pushed: `main` pushed to `origin` at `beb3eab`. `OCR` left local (not pushed).
- Current branch used during later work: `OCR`.

Backend change committed earlier:
- `backend/api/src/server.js`: improved barcode cache lookup and meal text normalization; direct lookup of meal text, better fallback behavior; trusted source handling.

Frontend OCR/camera UX changes:
- `frontend/pwa/src/app.js`: label scan overlay toggles `active` class when camera open; added OCR debug toggle via `?debugOcr=1` or localStorage `debug_ocr=true` and displays raw OCR text in label form under Calories when enabled.
- `frontend/pwa/src/styles.css`: label scan overlay fullscreen when active; form fields hidden during camera; camera fills screen; overlay buttons positioned bottom center; added `.ocr-debug` styles.

Local Docker:
- `docker compose up -d --build` used multiple times; containers `api`, `frontend`, `db`, `ollama` running.
- HTTPS via mkcert: `certs/local.crt` includes IP SAN for `192.168.7.193`; iOS needs mkcert root CA trusted.

Debug instructions:
- Use `https://<local-ip>:8443/?debugOcr=1` to show raw OCR text in the label form (under Calories).
- Local IP checked via `ifconfig | awk '/inet / && $2 != "127.0.0.1" {print $2}'` (varies by network).

Files added to repo for reference:
- `label.png`
- `My Simple Nutrition Tracker 7.png`
