CREATE TABLE "ChefSettlement" (
 "id" TEXT PRIMARY KEY,"orderId" TEXT NOT NULL UNIQUE REFERENCES "Order"("id"),"chefId" TEXT NOT NULL REFERENCES "Chef"("id"),"mode" TEXT NOT NULL,"status" TEXT NOT NULL,"chefFen" INTEGER NOT NULL CHECK("chefFen">=0),"commissionFen" INTEGER NOT NULL CHECK("commissionFen">=0),"subsidyFen" INTEGER NOT NULL CHECK("subsidyFen">=0),"snapshot" JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ChefSettlement_chefId_status_idx" ON "ChefSettlement"("chefId","status");
CREATE TABLE "ChefWalletEntry" (
 "id" TEXT PRIMARY KEY,"chefId" TEXT NOT NULL REFERENCES "Chef"("id"),"reference" TEXT NOT NULL UNIQUE,"kind" TEXT NOT NULL,"amountFen" INTEGER NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ChefWalletEntry_chefId_createdAt_idx" ON "ChefWalletEntry"("chefId","createdAt");
CREATE TABLE "ChefWithdrawal" (
 "id" TEXT PRIMARY KEY,"chefId" TEXT NOT NULL REFERENCES "Chef"("id"),"userId" TEXT NOT NULL REFERENCES "User"("id"),"amountFen" INTEGER NOT NULL CHECK("amountFen">=10),"status" TEXT NOT NULL DEFAULT 'REQUESTED',"idempotencyKey" TEXT NOT NULL UNIQUE,"approvedBy" TEXT REFERENCES "User"("id"),"encryptedName" TEXT NOT NULL,"metadata" JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ChefWithdrawal_chefId_createdAt_idx" ON "ChefWithdrawal"("chefId","createdAt");
CREATE INDEX "ChefWithdrawal_status_updatedAt_idx" ON "ChefWithdrawal"("status","updatedAt");
CREATE TABLE "ProfitShareTask" (
 "id" TEXT PRIMARY KEY,"settlementId" TEXT REFERENCES "ChefSettlement"("id"),"paymentId" TEXT NOT NULL UNIQUE REFERENCES "PaymentRequest"("id"),"orderId" TEXT NOT NULL REFERENCES "Order"("id"),"chefId" TEXT REFERENCES "Chef"("id"),"amountFen" INTEGER NOT NULL CHECK("amountFen">=0),"status" TEXT NOT NULL DEFAULT 'CREATED',"metadata" JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ProfitShareTask_status_updatedAt_idx" ON "ProfitShareTask"("status","updatedAt");
CREATE FUNCTION immutable_chef_wallet() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Chef wallet entries are immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER chef_wallet_immutable BEFORE UPDATE OR DELETE ON "ChefWalletEntry" FOR EACH ROW EXECUTE FUNCTION immutable_chef_wallet();