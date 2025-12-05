Preprocessing pipeline
======================

Purpose: build a searchable SQLite/FTS (or DuckDB) index from `data/` and derive aliases.

Suggested layout:
- `ingest.py` (or `.ts`): load raw JSON/CSV from `data/common_foods`, `grocery_brands`, `restaurants`, `fooddatajson`.
- `normalize.py`: unit normalization (g, mL), default serving selection, macro sanity checks.
- `aliases.py`: generate alias table from item names, brand/rest context, and heuristics.
- `indexer.py`: write normalized rows + aliases into the DB; create FTS and trigram helpers.
- `fixtures/`: small sample slices for tests.

Outputs:
- `../db/nutrition.db` (or DuckDB file) with tables: `foods`, `aliases`, `servings`, `nutrients`, `metadata`.
- Optional `cache/` for intermediate artifacts to speed up rebuilds.
