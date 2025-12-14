-- Create password reset table to support forgot-password flow
CREATE TABLE IF NOT EXISTS "PasswordReset" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  token text UNIQUE NOT NULL,
  "expiresAt" timestamp NOT NULL,
  used boolean DEFAULT false,
  "createdAt" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "PasswordReset_userId_idx" ON "PasswordReset"("userId");
