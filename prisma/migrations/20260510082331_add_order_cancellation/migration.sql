-- CreateEnum
CREATE TYPE "CancelReason" AS ENUM ('DELAY_OVER_30_MIN', 'WRONG_ORDER', 'PRODUCT_UNAVAILABLE', 'CUSTOMER_CHANGED_MIND', 'BAD_QUALITY', 'EMERGENCY', 'RESTAURANT_CLOSED');

-- CreateEnum
CREATE TYPE "CancelStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'AutoApproved');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cancelAutoApproveAt" TIMESTAMP(3),
ADD COLUMN     "cancelDescription" TEXT,
ADD COLUMN     "cancelProofPath" TEXT,
ADD COLUMN     "cancelReason" "CancelReason",
ADD COLUMN     "cancelRejectionReason" TEXT,
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "cancelReviewedAt" TIMESTAMP(3),
ADD COLUMN     "cancelStatus" "CancelStatus",
ADD COLUMN     "yookassaRefundId" TEXT;

-- CreateIndex
CREATE INDEX "Order_cancelStatus_cancelRequestedAt_idx" ON "Order"("cancelStatus", "cancelRequestedAt");

-- CreateIndex
CREATE INDEX "Order_cancelAutoApproveAt_idx" ON "Order"("cancelAutoApproveAt");
