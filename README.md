Nutrition voice PWA scaffold
============================

Goal: voice-first nutrition tracker using local-first models, with PWA front-end and SQLite/FTS backend.

Current layout
--------------
- `backend/api/`: service entrypoint, routes, and business logic.
- `backend/preprocess/`: pipeline to build the searchable food DB from `data/`.
- `backend/llm/`: local LLM integration for missing items.
- `backend/db/`: schema and migrations.
- `frontend/pwa/`: PWA front-end scaffold.
- `public/`: static assets and manifests.
- `scripts/`: helper scripts (build, run, test).

Next steps
----------
- Implement preprocessing to generate `backend/db/nutrition.db` from `data/`.
- Flesh out API server with real parse → match → log → summary endpoints and DB wiring.
- Expand PWA (routing, offline caching strategy, richer UI for confirmations).
- Wire local model adapters (Whisper/ASR, small LLM for missing foods).

Quick start (stubbed flow)
--------------------------
1) Install backend deps: `cd backend/api && npm install`.
2) Run API + PWA static server: `npm run dev` (serves API and `frontend/pwa` on port 4000).
3) Open `http://localhost:4000` in a browser; allow mic access to test voice input.
4) Speak or type a meal; the backend uses stub catalog data and a placeholder LLM path for missing items.

Local stack with Docker (API + Ollama)
--------------------------------------
Run the API and a local LLM together:
```bash
docker compose up -d
```
- API: http://localhost:4000
- Ollama: http://localhost:11434 (pull a model once: `docker exec -it <ollama-container> ollama pull llama3`)
- Default DB is SQLite persisted in the `api_data` volume; set `DATABASE_URL` to Postgres if desired.

Local end-to-end testing (separate frontend)
--------------------------------------------
1) Start backend + Ollama: `docker compose up -d` and pull a model in Ollama if needed.
2) Run DB migrations in the API container:  
   `docker exec -it $(docker ps -qf name=api) npx prisma migrate deploy && npx prisma generate`
3) Serve the PWA locally:  
   ```
   cd frontend/pwa
   npx serve .   # or python3 -m http.server 5173
   ```  
   The frontend defaults to `http://localhost:4000/api` (set in `index.html` via `window.API_BASE`).
4) Open the served PWA URL, register/login, update profile, and log meals; unknown foods will call the local LLM.

Low-cost deployment plan
------------------------
- Frontend: host the static PWA on Vercel/Netlify/Cloudflare Pages (free tiers).
- Backend API: deploy the Node service to a small Fly.io/Render/Railway instance (hobby/free tier), pointing it at a managed Postgres (Neon/Supabase free tier). Set env vars: `DATABASE_URL`, `JWT_SECRET`, `OLLAMA_HOST`, `OLLAMA_MODEL`.
- LLM: run a tiny Ollama instance on the same VM if resources allow, or disable LLM calls and rely on cached food estimates; use a DB cache to avoid repeated LLM calls.
