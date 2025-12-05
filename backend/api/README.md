Backend API scaffold
====================

Structure outline for the nutrition tracking service:

- `routes/` for HTTP handlers (parse → match → log → summary; add missing item).
- `services/` for business logic (matching, aggregation, LLM fallback).
- `db/` for database access layer (SQLite/FTS or DuckDB).
- `schemas/` for request/response and data validation.
- `tests/` for unit/integration tests against a fixture DB.

Suggested entrypoint: `server.ts` (or `server.py`), wiring routes, middleware, and dependency injection.
