-- CreateTable
CREATE TABLE "ShiftReport" (
    "id" SERIAL NOT NULL,
    "staffName" TEXT NOT NULL,
    "shiftStart" TIMESTAMP(3) NOT NULL,
    "shiftEnd" TIMESTAMP(3) NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "totalRevenue" DECIMAL(65,30) NOT NULL,
    "averageOrder" DECIMAL(65,30) NOT NULL,
    "cancelledCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftReport_createdAt_idx" ON "ShiftReport"("createdAt");
