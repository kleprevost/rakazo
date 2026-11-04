-- Fleet recreate: the approved image an operation targets, a per-computer before/after record, and
-- an idempotent maintenance update. Additive nullable columns: the previous release never reads them.
ALTER TABLE "computer_fleet_operations" ADD COLUMN "imageDigest" TEXT;

ALTER TABLE "computer_fleet_items" ADD COLUMN "imageDigestBefore" TEXT;
ALTER TABLE "computer_fleet_items" ADD COLUMN "imageDigestAfter" TEXT;
ALTER TABLE "computer_fleet_items" ADD COLUMN "homeRevisionBefore" TEXT;
ALTER TABLE "computer_fleet_items" ADD COLUMN "homeRevisionAfter" TEXT;
ALTER TABLE "computer_fleet_items" ADD COLUMN "browserProfilesBefore" INTEGER;
ALTER TABLE "computer_fleet_items" ADD COLUMN "computerUpdateId" TEXT;

ALTER TABLE "computer_updates" ADD COLUMN "targetImageDigest" TEXT;
ALTER TABLE "computer_updates" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "computer_updates_idempotencyKey_key" ON "computer_updates"("idempotencyKey");
