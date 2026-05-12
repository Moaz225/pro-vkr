-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "cafeName" TEXT NOT NULL DEFAULT 'BRODSKY.',
    "logoUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#ff7700',
    "secondaryColor" TEXT NOT NULL DEFAULT '#e56a00',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);
