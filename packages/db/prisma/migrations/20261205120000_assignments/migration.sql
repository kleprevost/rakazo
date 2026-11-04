-- Independent assignments per employee. Additive: one new table with its row-level security, and
-- one relaxed check. Nothing creates rows yet, and the previous release keeps working.

-- An assignment's thread belongs to no bot, group or external conversation: it is owned through
-- its assignment row. The check used to demand exactly one owner; it now only forbids two.
-- Loosening a check cannot break code written for the stricter one.
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId") <= 1
);

CREATE TABLE "assignments" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "employeeId" TEXT,
  "threadId" TEXT NOT NULL,
  "ticketId" TEXT,
  "title" TEXT NOT NULL,
  "clientNonce" TEXT NOT NULL,
  "cancelledAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assignments_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "assignments_botId_fkey" FOREIGN KEY ("botId")
    REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "assignments_threadId_fkey" FOREIGN KEY ("threadId")
    REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "assignments_ticketId_fkey" FOREIGN KEY ("ticketId")
    REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "assignments_threadId_key" ON "assignments"("threadId");
CREATE UNIQUE INDEX "assignments_ticketId_key" ON "assignments"("ticketId");
CREATE UNIQUE INDEX "assignments_spaceId_clientNonce_key" ON "assignments"("spaceId", "clientNonce");
CREATE INDEX "assignments_spaceId_botId_archivedAt_updatedAt_idx"
  ON "assignments"("spaceId", "botId", "archivedAt", "updatedAt");
CREATE INDEX "assignments_spaceId_userId_updatedAt_idx" ON "assignments"("spaceId", "userId", "updatedAt");
CREATE INDEX "assignments_employeeId_idx" ON "assignments"("employeeId");

-- Row-level security ships with the table. The creator reads and writes their space's rows.
-- Owners and Managers of the employee may also read them, from any space, through the copied
-- employeeId (no policy reads bots or threads on a manager's behalf); they never write.
ALTER TABLE "assignments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY assignments_tenant ON "assignments"
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
  );
CREATE POLICY assignments_managers ON "assignments" FOR SELECT
  USING ("employeeId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "employee_entitlements" e
    WHERE e."employeeId" = "assignments"."employeeId"
      AND e."userId" = NULLIF(current_setting('app.user_id', true), '')
      AND e."role" IN ('owner', 'manager')
  ));
CREATE POLICY assignments_system ON "assignments"
  USING ((SELECT app_rls_bypass()));
