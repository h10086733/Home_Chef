ALTER TABLE "User" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';

CREATE TABLE "ChefPenalty" (
  "id" TEXT NOT NULL,
  "chefId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChefPenalty_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChefPenalty_chefId_createdAt_idx" ON "ChefPenalty"("chefId", "createdAt");

CREATE TABLE "AgreementVersion" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "publishedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgreementVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgreementVersion_kind_version_key" ON "AgreementVersion"("kind", "version");
CREATE INDEX "AgreementVersion_kind_active_createdAt_idx" ON "AgreementVersion"("kind", "active", "createdAt");
