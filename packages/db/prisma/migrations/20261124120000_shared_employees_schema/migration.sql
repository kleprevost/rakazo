-- Shared AI employees, schema foundation. Everything here is additive: new tables and one
-- nullable column, so the previous release running beside this migration is unaffected.
-- Nothing reads these tables yet; bots.employeeId stays NULL for every existing bot.

ALTER TABLE "bots" ADD COLUMN "employeeId" TEXT;

CREATE TABLE "employees" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "listing" TEXT NOT NULL DEFAULT 'unlisted',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "currentVersionId" TEXT,
  "suspendedAt" TIMESTAMP(3),
  "suspendedByUserId" TEXT,
  "serviceUserId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "employee_versions" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'draft',
  "role" TEXT NOT NULL DEFAULT '',
  "instructions" TEXT NOT NULL DEFAULT '',
  "skills" JSONB NOT NULL DEFAULT '[]',
  "capabilityPolicy" JSONB NOT NULL DEFAULT '{}',
  "modelPolicy" JSONB NOT NULL DEFAULT '{}',
  "createdBy" TEXT NOT NULL,
  "publishedBy" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_versions_employeeId_fkey" FOREIGN KEY ("employeeId")
    REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "employee_versions_employeeId_number_key" ON "employee_versions"("employeeId", "number");

CREATE TABLE "employee_grants" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "subjectKind" TEXT NOT NULL,
  "subjectValue" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "grantedBy" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_grants_employeeId_fkey" FOREIGN KEY ("employeeId")
    REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "employee_grants_subjectKind_check" CHECK ("subjectKind" IN ('user', 'claim')),
  CONSTRAINT "employee_grants_role_check" CHECK ("role" IN ('owner', 'manager', 'collaborator', 'viewer')),
  -- A directory claim never confers Owner.
  CONSTRAINT "employee_grants_claim_not_owner_check" CHECK ("subjectKind" = 'user' OR "role" <> 'owner')
);
CREATE UNIQUE INDEX "employee_grants_employeeId_subjectKind_subjectValue_key"
  ON "employee_grants"("employeeId", "subjectKind", "subjectValue");
CREATE INDEX "employee_grants_subjectKind_subjectValue_idx" ON "employee_grants"("subjectKind", "subjectValue");

CREATE TABLE "user_directory_claims" (
  "userId" TEXT NOT NULL,
  "values" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_directory_claims_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "user_directory_claims_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "employee_entitlements" (
  "employeeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_entitlements_pkey" PRIMARY KEY ("employeeId", "userId", "source"),
  CONSTRAINT "employee_entitlements_employeeId_fkey" FOREIGN KEY ("employeeId")
    REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "employee_entitlements_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "employee_entitlements_role_check" CHECK ("role" IN ('owner', 'manager', 'collaborator', 'viewer')),
  CONSTRAINT "employee_entitlements_source_check" CHECK ("source" IN ('grant', 'claim')),
  CONSTRAINT "employee_entitlements_claim_not_owner_check" CHECK ("source" = 'grant' OR "role" <> 'owner')
);
CREATE INDEX "employee_entitlements_userId_idx" ON "employee_entitlements"("userId");

ALTER TABLE "bots" ADD CONSTRAINT "bots_employeeId_fkey" FOREIGN KEY ("employeeId")
  REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "bots_employeeId_idx" ON "bots"("employeeId");
-- One instance of an employee per user.
CREATE UNIQUE INDEX "bots_employee_user_key" ON "bots"("employeeId", "userId") WHERE "employeeId" IS NOT NULL;

-- Row-level security. The runtime role gets default privileges on new tables, so each table
-- ships with its policies. Tenants only read, and only through entitlements; every write goes
-- through the system context after the application role check. No policy here, now or later,
-- reaches bots, threads, messages, memory, computers or credentials for a manager.

ALTER TABLE "employee_entitlements" ENABLE ROW LEVEL SECURITY;
-- Own rows only. Deliberately does not look at itself, which would recurse.
CREATE POLICY employee_entitlements_tenant ON "employee_entitlements" FOR SELECT
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY employee_entitlements_system ON "employee_entitlements"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "user_directory_claims" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_directory_claims_tenant ON "user_directory_claims" FOR SELECT
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_directory_claims_system ON "user_directory_claims"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "employees" ENABLE ROW LEVEL SECURITY;
CREATE POLICY employees_tenant ON "employees" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "employee_entitlements" e
    WHERE e."employeeId" = "employees"."id"
      AND e."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));
CREATE POLICY employees_system ON "employees"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "employee_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY employee_versions_tenant ON "employee_versions" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "employee_entitlements" e
    WHERE e."employeeId" = "employee_versions"."employeeId"
      AND e."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));
CREATE POLICY employee_versions_system ON "employee_versions"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "employee_grants" ENABLE ROW LEVEL SECURITY;
-- A user sees grants naming them; an Owner or Manager sees every grant of their employee.
CREATE POLICY employee_grants_tenant ON "employee_grants" FOR SELECT
  USING (
    ("subjectKind" = 'user' AND "subjectValue" = NULLIF(current_setting('app.user_id', true), ''))
    OR EXISTS (
      SELECT 1 FROM "employee_entitlements" e
      WHERE e."employeeId" = "employee_grants"."employeeId"
        AND e."userId" = NULLIF(current_setting('app.user_id', true), '')
        AND e."role" IN ('owner', 'manager')
    )
  );
CREATE POLICY employee_grants_system ON "employee_grants"
  USING ((SELECT app_rls_bypass()));
