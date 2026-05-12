-- Add finalize token for safe end-of-day reset
ALTER TABLE "ShiftReport" ADD COLUMN "finalizeToken" TEXT;
ALTER TABLE "ShiftReport" ADD COLUMN "finalizedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "ShiftReport_finalizeToken_key" ON "ShiftReport"("finalizeToken");
