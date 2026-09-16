
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
