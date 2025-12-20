-- Add trend preferences JSON blob to store per-user trend selections.
ALTER TABLE "User" ADD COLUMN "trendPreferences" JSONB;
