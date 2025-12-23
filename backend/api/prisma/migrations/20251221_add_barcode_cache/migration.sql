-- Add barcode cache for packaged food lookups.
CREATE TABLE "BarcodeCache" (
  "barcode" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "brand" TEXT,
  "servingSize" TEXT,
  "nutrients" JSONB NOT NULL,
  "source" TEXT NOT NULL,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "confidence" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BarcodeCache_pkey" PRIMARY KEY ("barcode")
);
