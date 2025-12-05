Local LLM integration
=====================

Role: estimate nutrition for missing items, constrained to a JSON schema.

Components:
- `prompt/` for few-shot examples producing `{name, serving_g, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg}`.
- `runner/` adapters for local models (e.g., llama.cpp). Ensure deterministic settings and guardrails.
- `validators/` to sanity-check outputs (calorie balance, bounds per 100g, negative checks).
- `cache/` to memoize estimations and avoid repeated calls.

API hook: `estimate_nutrition(name, context) -> NutritionEstimate` returning structured data plus a confidence score and `model_estimated=true` flag for DB insert.
