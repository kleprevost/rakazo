-- Shared AI employees, shared knowledge and proposals. Additive: three new tables, nothing existing changes.

CREATE TABLE "employee_knowledge" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "state" TEXT NOT NULL DEFAULT 'approved',
  "approvedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "employee_knowledge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_knowledge_employeeId_fkey" FOREIGN KEY ("employeeId")
    REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "employee_knowledge_state_check" CHECK ("state" IN ('approved', 'retired'))
);
CREATE UNIQUE INDEX "employee_knowledge_employeeId_path_key" ON "employee_knowledge"("employeeId", "path");

CREATE TABLE "employee_knowledge_revisions" (
  "id" TEXT NOT NULL,
  "knowledgeId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "approvedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_knowledge_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_knowledge_revisions_knowledgeId_fkey" FOREIGN KEY ("knowledgeId")
    REFERENCES "employee_knowledge"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "employee_knowledge_revisions_knowledgeId_revision_key"
  ON "employee_knowledge_revisions"("knowledgeId", "revision");

CREATE TABLE "employee_knowledge_proposals" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "proposedByUserId" TEXT,
  "path" TEXT NOT NULL,
  "proposedContent" TEXT NOT NULL,
  "baseRevision" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decidedBy" TEXT,
  "decidedAt" TIMESTAMP(3),
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_knowledge_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_knowledge_proposals_employeeId_fkey" FOREIGN KEY ("employeeId")
    REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "employee_knowledge_proposals_proposedByUserId_fkey" FOREIGN KEY ("proposedByUserId")
    REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "employee_knowledge_proposals_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn'))
);
CREATE INDEX "employee_knowledge_proposals_employeeId_status_idx"
  ON "employee_knowledge_proposals"("employeeId", "status");
CREATE INDEX "employee_knowledge_proposals_proposedByUserId_idx"
  ON "employee_knowledge_proposals"("proposedByUserId");
-- One open proposal per person, employee and path.
CREATE UNIQUE INDEX "employee_knowledge_proposals_pending_key"
  ON "employee_knowledge_proposals"("employeeId", "proposedByUserId", "path") WHERE "status" = 'pending';

-- Row-level security ships with each table. Every write goes through the system context after
-- the application role check. Approved knowledge is readable by anyone entitled to the employee
-- (their instances read it at run time); revisions and proposals only by Owners and Managers,
-- and a proposer also sees their own proposals.
ALTER TABLE "employee_knowledge" ENABLE ROW LEVEL SECURITY;
CREATE POLICY employee_knowledge_tenant ON "employee_knowledge" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "employee_entitlements" e
    WHERE e."employeeId" = "employee_knowledge"."employeeId"
      AND e."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));
CREATE POLICY employee_knowledge_system ON "employee_knowledge"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "employee_knowledge_revisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY employee_knowledge_revisions_tenant ON "employee_knowledge_revisions" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "employee_knowledge" k
    JOIN "employee_entitlements" e ON e."employeeId" = k."employeeId"
    WHERE k."id" = "employee_knowledge_revisions"."knowledgeId"
      AND e."userId" = NULLIF(current_setting('app.user_id', true), '')
      AND e."role" IN ('owner', 'manager')
  ));
CREATE POLICY employee_knowledge_revisions_system ON "employee_knowledge_revisions"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "employee_knowledge_proposals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY employee_knowledge_proposals_tenant ON "employee_knowledge_proposals" FOR SELECT
  USING (
    "proposedByUserId" = NULLIF(current_setting('app.user_id', true), '')
    OR EXISTS (
      SELECT 1 FROM "employee_entitlements" e
      WHERE e."employeeId" = "employee_knowledge_proposals"."employeeId"
        AND e."userId" = NULLIF(current_setting('app.user_id', true), '')
        AND e."role" IN ('owner', 'manager')
    )
  );
CREATE POLICY employee_knowledge_proposals_system ON "employee_knowledge_proposals"
  USING ((SELECT app_rls_bypass()));
