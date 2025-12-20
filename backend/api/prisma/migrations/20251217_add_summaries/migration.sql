-- Create summaries table for cached AI/user summaries
CREATE TABLE IF NOT EXISTS "Summary" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  range text NOT NULL,
  "startDate" timestamp NOT NULL,
  "endDate" timestamp NOT NULL,
  "summaryKey" text NOT NULL,
  text text NOT NULL,
  model text,
  version integer DEFAULT 1,
  "createdAt" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "Summary_userId_range_dates_idx" ON "Summary"("userId", range, "startDate", "endDate");
CREATE UNIQUE INDEX IF NOT EXISTS "Summary_userId_range_summaryKey_idx" ON "Summary"("userId", range, "summaryKey");
