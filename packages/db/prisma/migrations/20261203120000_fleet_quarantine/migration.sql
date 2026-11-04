-- Fleet quarantine: an admin flag that contains a computer. Additive nullable columns: the previous
-- release never reads them and inserts without them.
ALTER TABLE "computers" ADD COLUMN "adminQuarantinedAt" TIMESTAMP(3);
ALTER TABLE "computers" ADD COLUMN "adminQuarantinedByUserId" TEXT;
ALTER TABLE "computers" ADD COLUMN "adminQuarantineReason" TEXT;
ALTER TABLE "computers" ADD COLUMN "adminQuarantineId" TEXT;
