ALTER TABLE "User" ADD COLUMN "failedLogins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "agreedAt" TIMESTAMP(3);
CREATE INDEX "User_deletionRequestedAt_idx" ON "User"("deletionRequestedAt");

ALTER TABLE "Chef" ADD COLUMN "insuranceValidUntil" TIMESTAMP(3);
