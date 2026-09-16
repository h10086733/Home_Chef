-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'CHEF', 'OPERATOR', 'REVIEWER', 'CUSTOMER_SERVICE', 'FINANCE', 'RISK', 'FINANCE_MANAGER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('PENDING_PAYMENT', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'PAYMENT_EXCEPTION', 'FULFILLED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentSummaryStatus" AS ENUM ('UNPAID', 'DEPOSIT_PAID', 'FULLY_PAID', 'PARTIALLY_REFUNDED', 'FULLY_REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('DEPOSIT', 'FULL_PAYMENT', 'BALANCE', 'ADDITIONAL', 'REFUND');

-- CreateEnum
CREATE TYPE "PaymentRequestStatus" AS ENUM ('CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ChefOrderStatus" AS ENUM ('UNASSIGNED', 'INVITED', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "username" TEXT,
    "passwordHash" TEXT,
    "id" TEXT NOT NULL,
    "openId" TEXT,
    "phone" TEXT,
    "displayName" TEXT,
    "roles" "UserRole"[] DEFAULT ARRAY[]::"UserRole"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "regionCode" TEXT NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "maskedText" TEXT,
    "encryptedText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chef" (
    "data" JSONB NOT NULL DEFAULT '{}',
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "healthValidUntil" TIMESTAMP(3),
    "serviceRadiusM" INTEGER NOT NULL DEFAULT 3000,
    "acceptingOrders" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePackage" (
    "id" TEXT NOT NULL,
    "chefId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "serviceFen" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServicePackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleSlot" (
    "id" TEXT NOT NULL,
    "chefId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',

    CONSTRAINT "ScheduleSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "details" JSONB NOT NULL DEFAULT '{}',
    "id" TEXT NOT NULL,
    "chefId" TEXT NOT NULL,
    "packageId" TEXT,
    "customerId" TEXT NOT NULL,
    "totalFen" INTEGER NOT NULL,
    "depositFen" INTEGER NOT NULL,
    "balanceFen" INTEGER NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "fulfillmentStatus" TEXT NOT NULL DEFAULT 'INELIGIBLE',
    "feeStatus" TEXT NOT NULL DEFAULT 'ESTIMATE_CONFIRMED',
    "aftersaleStatus" TEXT NOT NULL DEFAULT 'NONE',
    "settlementStatus" TEXT NOT NULL DEFAULT 'INELIGIBLE',
    "reviewStatus" TEXT NOT NULL DEFAULT 'INELIGIBLE',
    "details" JSONB NOT NULL DEFAULT '{}',
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "addressId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "slotId" TEXT,
    "contractStatus" "ContractStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "paymentStatus" "PaymentSummaryStatus" NOT NULL DEFAULT 'UNPAID',
    "totalFen" INTEGER NOT NULL,
    "depositFen" INTEGER NOT NULL,
    "receivedFen" INTEGER NOT NULL DEFAULT 0,
    "refundedFen" INTEGER NOT NULL DEFAULT 0,
    "balanceFen" INTEGER NOT NULL,
    "ruleSnapshot" JSONB NOT NULL,
    "acceptedChefId" TEXT,
    "serviceEndsAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChefOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "chefId" TEXT NOT NULL,
    "distanceM" INTEGER,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "ruleVersion" TEXT,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ChefOrderStatus" NOT NULL DEFAULT 'INVITED',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChefOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "amountFen" INTEGER NOT NULL,
    "status" "PaymentRequestStatus" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" TEXT NOT NULL,
    "provider" TEXT,
    "providerRef" TEXT,
    "rawEvent" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingLock" (
    "id" TEXT NOT NULL,
    "chefId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "orderId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "BookingLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountFen" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceTicket" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "refundFen" INTEGER,
    "proposedBy" TEXT,
    "approvedBy" TEXT,
    "executedBy" TEXT,
    "decision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsurancePolicy" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'sandbox',
    "status" TEXT NOT NULL DEFAULT 'SANDBOX_ACTIVE',
    "reference" TEXT NOT NULL,
    "claimReason" TEXT,

    CONSTRAINT "InsurancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chefId" TEXT NOT NULL,
    "taste" INTEGER NOT NULL,
    "service" INTEGER NOT NULL,
    "punctuality" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "followup" TEXT,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountFen" INTEGER NOT NULL,
    "minFen" INTEGER NOT NULL,
    "regionCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "orderId" TEXT,
    "ruleVersion" TEXT NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformRule" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT NOT NULL,

    CONSTRAINT "PlatformRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Favorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chefId" TEXT NOT NULL,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_openId_key" ON "User"("openId");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "Address_userId_idx" ON "Address"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Chef_userId_key" ON "Chef"("userId");

-- CreateIndex
CREATE INDEX "ServicePackage_chefId_active_idx" ON "ServicePackage"("chefId", "active");

-- CreateIndex
CREATE INDEX "ScheduleSlot_chefId_startsAt_endsAt_idx" ON "ScheduleSlot"("chefId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "Quote_customerId_status_expiresAt_idx" ON "Quote"("customerId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_quoteId_key" ON "Order"("quoteId");

-- CreateIndex
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_contractStatus_createdAt_idx" ON "Order"("contractStatus", "createdAt");

-- CreateIndex
CREATE INDEX "ChefOrder_chefId_status_expiresAt_idx" ON "ChefOrder"("chefId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChefOrder_orderId_chefId_key" ON "ChefOrder"("orderId", "chefId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRequest_idempotencyKey_key" ON "PaymentRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentRequest_orderId_kind_status_idx" ON "PaymentRequest"("orderId", "kind", "status");

-- CreateIndex
CREATE INDEX "AuditEvent_aggregateType_aggregateId_createdAt_idx" ON "AuditEvent"("aggregateType", "aggregateId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_occurredAt_idx" ON "OutboxEvent"("publishedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "AppSession_userId_idx" ON "AppSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingLock_quoteId_key" ON "BookingLock"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingLock_orderId_key" ON "BookingLock"("orderId");

-- CreateIndex
CREATE INDEX "BookingLock_chefId_startsAt_endsAt_idx" ON "BookingLock"("chefId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_reference_key" ON "LedgerEntry"("reference");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_orderId_createdAt_idx" ON "ChatMessage"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InsurancePolicy_orderId_key" ON "InsurancePolicy"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "InsurancePolicy_reference_key" ON "InsurancePolicy"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Review_orderId_key" ON "Review"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_orderId_key" ON "Coupon"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_userId_chefId_key" ON "Favorite"("userId", "chefId");

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chef" ADD CONSTRAINT "Chef_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePackage" ADD CONSTRAINT "ServicePackage_chefId_fkey" FOREIGN KEY ("chefId") REFERENCES "Chef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_chefId_fkey" FOREIGN KEY ("chefId") REFERENCES "Chef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_chefId_fkey" FOREIGN KEY ("chefId") REFERENCES "Chef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ServicePackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "Address"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "ScheduleSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChefOrder" ADD CONSTRAINT "ChefOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChefOrder" ADD CONSTRAINT "ChefOrder_chefId_fkey" FOREIGN KEY ("chefId") REFERENCES "Chef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "BookingLock" ADD CONSTRAINT "chef_schedule_exclusion" EXCLUDE USING gist
("chefId" WITH =, tsrange("startsAt", "endsAt", '[)') WITH &&);
ALTER TABLE "BookingLock" ADD CONSTRAINT "valid_booking_interval" CHECK ("endsAt" > "startsAt");
ALTER TABLE "Order" ADD CONSTRAINT "nonnegative_money" CHECK ("totalFen" >= 0 AND "receivedFen" >= 0 AND "refundedFen" >= 0 AND "refundedFen" <= "receivedFen" AND "balanceFen" >= 0);
CREATE FUNCTION reject_history_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Financial and audit history is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
