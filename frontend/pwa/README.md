PWA scaffold
============

Suggested structure:
- `src/`
  - `app/` (routing, layout)
  - `components/` (UI atoms/molecules)
  - `features/meal-entry/` (voice input, parser results, item selection)
  - `features/summary/` (daily + weekly views)
  - `lib/api/` (API client), `lib/db/` (local SQLite WASM wrapper), `lib/hooks/`
  - `styles/` (global styles, theme tokens)
  - `workers/` (service worker, optional web worker for WASM parsing)
- `public/` for icons/manifest.

Key needs:
- Installable PWA with manifest + service worker.
- Voice input hook (Web Speech API fallback to button text input).
- Offline cache for recent items and meals; sync when online.
- UI flow: chat-like meal entry → review parsed items → confirm → show nutrition + day-over-day cards.
