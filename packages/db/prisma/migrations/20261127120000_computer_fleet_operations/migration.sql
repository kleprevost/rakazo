-- Admin fleet operations and their per-computer items. Additive: the previous release never reads them.
CREATE TABLE "computer_fleet_operations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "actorUserId" TEXT NOT NULL,
  "maxParallel" INTEGER NOT NULL,
  "haltAfterFailures" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3)
);
CREATE INDEX "computer_fleet_operations_createdAt_idx" ON "computer_fleet_operations"("createdAt");

CREATE TABLE "computer_fleet_items" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "operationId" TEXT NOT NULL REFERENCES "computer_fleet_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "computerId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "outcome" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "claimId" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "computer_fleet_items_operationId_computerId_key" ON "computer_fleet_items"("operationId", "computerId");
CREATE INDEX "computer_fleet_items_status_claimExpiresAt_idx" ON "computer_fleet_items"("status", "claimExpiresAt");
CREATE INDEX "computer_fleet_items_computerId_idx" ON "computer_fleet_items"("computerId");
-- Two operations cannot hold an unfinished item for the same computer.
CREATE UNIQUE INDEX "computer_fleet_items_open_idx" ON "computer_fleet_items"("computerId") WHERE "status" IN ('queued', 'running');

ALTER TABLE "computer_fleet_operations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_fleet_operations_system ON "computer_fleet_operations"
  USING ((SELECT app_rls_bypass()));
ALTER TABLE "computer_fleet_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_fleet_items_system ON "computer_fleet_items"
  USING ((SELECT app_rls_bypass()));
