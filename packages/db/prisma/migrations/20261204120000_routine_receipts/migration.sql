-- What each routine firing came to. A new table, so the previous release keeps working.
CREATE TABLE "routine_receipts" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "runId" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routine_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "routine_receipts_outcome_check" CHECK ("outcome" IN ('no_change', 'action_needed', 'failed', 'missed'))
);

CREATE UNIQUE INDEX "routine_receipts_runId_key" ON "routine_receipts"("runId");
CREATE UNIQUE INDEX "routine_receipts_routineId_scheduledFor_key" ON "routine_receipts"("routineId", "scheduledFor");
CREATE INDEX "routine_receipts_spaceId_userId_createdAt_idx" ON "routine_receipts"("spaceId", "userId", "createdAt");

ALTER TABLE "routine_receipts" ADD CONSTRAINT "routine_receipts_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routine_receipts" ADD CONSTRAINT "routine_receipts_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routine_receipts" ADD CONSTRAINT "routine_receipts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "routine_receipts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY routine_receipts_tenant ON "routine_receipts"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY routine_receipts_system ON "routine_receipts"
  USING ((SELECT app_rls_bypass()));
