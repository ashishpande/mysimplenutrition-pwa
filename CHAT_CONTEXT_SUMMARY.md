# Project Context Summary

This file captures the recent conversation and changes so future contributors understand the current state and decisions.

## Key Features & Changes
- **Meal date parsing**: Backend now uses `chrono-node` plus a custom “X days ago” handler. It detects meal slots (breakfast/lunch/dinner/snack) and sets default times. Relative phrases are parsed in the client’s timezone; consumedAt is stored in UTC.
- **Fix Time flow**: Frontend allows editing meal date/time/slot inline in the “We heard” card. Save calls a new backend PATCH `/api/meals/:id` to update `consumedAt` and `mealType`, then refreshes Today/Days.
- **Local time handling**: Frontend builds consumedAt from local date/time and converts to UTC before sending. Inputs pre-fill with local hours/minutes (no UTC slicing).
- **Spinner/disable on Fix Time**: Save button disables and shows a spinner while saving; on completion it closes the editor, returns to Today, and shows a toast (“Updated meal time.”). Status is force-reset to idle to prevent stuck spinners.
- **UI tweaks**:
  - Log input/button stacks on mobile; larger tap targets per Apple HIG (mic, accordions, meal list).
  - “More nutrition details” collapsibles for meal items and day/meals list; unsaturated fat included.
  - Brand text: “Simple Nutrition Tracker”.

## Backend Notes
- Added `chrono-node` dependency. Helper functions: `detectMealSlot`, `defaultTimeForSlot`, `parseMealText`, `formatLocalYMD`.
- `/api/meals` uses parsed `foodText`, inferred `mealType`, and parsed/override `consumedAt`; response includes `clampedFuture`.
- New PATCH `/api/meals/:mealId` updates `consumedAt`/`mealType` and recomputes day totals (uses tzOffsetMinutes).

## Frontend Notes
- New helpers in `time.js` (`formatWhen`, `buildConsumedAtFromInputs`).
- API wrapper `patchMealMeta` added.
- State includes `fixTime` object to drive inline editor status/spinner/success.
- Today view shows “When:” with Fix time editor; uses `formatWhen` for display.

## Open Risks / Things to Verify
- Ensure Fix Time save no longer spins indefinitely in production; if still stuck, check network panel for PATCH completion.
- Confirm time displays correctly in History with local timezone after edits.

## Deployment
- Latest images were rebuilt via `docker-compose build --no-cache` and restarted with `docker-compose up -d --force-recreate`. Hard refresh the PWA to pick up frontend changes.
