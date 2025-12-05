Database layout
===============

Primary store: SQLite with FTS5 (or DuckDB if preferred).

Tables (suggested):
- `foods`: id, name, brand, category, source, model_estimated, created_at.
- `aliases`: food_id, alias, confidence.
- `servings`: food_id, unit, grams, description, is_default.
- `nutrients`: food_id, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, saturated_fat_g, etc.
- `meals`: id, user_id, consumed_at, meal_type, notes.
- `meal_items`: meal_id, food_id, quantity, unit, grams, overrides, source_confidence.
- `daily_totals`: user_id, date, calories, protein_g, carbs_g, fat_g, sugar_g, sodium_mg, fiber_g.

Indexes:
- FTS on `foods.name` + aliases; trigram helper for reranking.
- Time indexes on meals/daily_totals per user.

Migrations: keep SQL migrations in `migrations/` with a minimal migration runner.
