-- Shared AI employees, access requests. Additive: one new table, nothing existing changes.

CREATE TABLE "employee_access_requests" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "requesterUserId" TEXT NOT NULL,
  "requestedRole" TEXT NOT NULL DEFAULT 'collaborator',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decidedBy" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_access_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_access_requests_employeeId_fkey" FOREIGN KEY ("employeeId")
    REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "employee_access_requests_requesterUserId_fkey" FOREIGN KEY ("requesterUserId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "employee_access_requests_role_check" CHECK ("requestedRole" IN ('manager', 'collaborator', 'viewer')),
  CONSTRAINT "employee_access_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'denied', 'withdrawn'))
);
CREATE INDEX "employee_access_requests_employeeId_status_idx" ON "employee_access_requests"("employeeId", "status");
CREATE INDEX "employee_access_requests_requesterUserId_idx" ON "employee_access_requests"("requesterUserId");
-- One open request per person and employee.
CREATE UNIQUE INDEX "employee_access_requests_pending_key"
  ON "employee_access_requests"("employeeId", "requesterUserId") WHERE "status" = 'pending';

-- Row-level security ships with the table. A requester sees their own requests; an Owner or
-- Manager sees every request for their employee. Every write goes through the system context
-- after the application role check.
ALTER TABLE "employee_access_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY employee_access_requests_tenant ON "employee_access_requests" FOR SELECT
  USING (
    "requesterUserId" = NULLIF(current_setting('app.user_id', true), '')
    OR EXISTS (
      SELECT 1 FROM "employee_entitlements" e
      WHERE e."employeeId" = "employee_access_requests"."employeeId"
        AND e."userId" = NULLIF(current_setting('app.user_id', true), '')
        AND e."role" IN ('owner', 'manager')
    )
  );
CREATE POLICY employee_access_requests_system ON "employee_access_requests"
  USING ((SELECT app_rls_bypass()));
