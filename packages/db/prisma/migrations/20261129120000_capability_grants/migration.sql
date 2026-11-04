-- Capability grants and the per-bot broker mode. A new table and a nullable column, so the previous
-- release keeps working.
ALTER TABLE "bots" ADD COLUMN "capabilityMode" TEXT;

CREATE TABLE "capability_grants" (
    "id" TEXT NOT NULL,
    "botId" TEXT,
    "employeeId" TEXT,
    "spaceId" TEXT,
    "kind" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resource" JSONB,
    "effect" TEXT NOT NULL DEFAULT 'allow',
    "principalUserId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdVia" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capability_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "capability_grants_target_check" CHECK (
      ("botId" IS NOT NULL AND "employeeId" IS NULL AND "spaceId" IS NOT NULL)
      OR ("botId" IS NULL AND "employeeId" IS NOT NULL AND "spaceId" IS NULL AND "kind" = 'bot')
    ),
    CONSTRAINT "capability_grants_kind_check" CHECK ("kind" IN ('bot', 'delegation')),
    CONSTRAINT "capability_grants_delegation_check" CHECK ("kind" <> 'delegation' OR "principalUserId" IS NOT NULL),
    CONSTRAINT "capability_grants_effect_check" CHECK ("effect" IN ('allow', 'ask', 'deny')),
    CONSTRAINT "capability_grants_created_via_check" CHECK ("createdVia" IN ('owner', 'admin', 'policy'))
);

CREATE INDEX "capability_grants_botId_revokedAt_expiresAt_idx" ON "capability_grants"("botId", "revokedAt", "expiresAt");
CREATE INDEX "capability_grants_employeeId_revokedAt_expiresAt_idx" ON "capability_grants"("employeeId", "revokedAt", "expiresAt");
CREATE INDEX "capability_grants_principalUserId_revokedAt_idx" ON "capability_grants"("principalUserId", "revokedAt");

ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capability_grants" ENABLE ROW LEVEL SECURITY;
-- A bot's grants belong to its Space. An employee's grants are read by the users entitled to it;
-- only a system context (an admin procedure) writes them.
CREATE POLICY capability_grants_tenant ON "capability_grants"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY capability_grants_employee ON "capability_grants" FOR SELECT
  USING ("employeeId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "employee_entitlements" e
    WHERE e."employeeId" = "capability_grants"."employeeId"
      AND e."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));
CREATE POLICY capability_grants_system ON "capability_grants"
  USING ((SELECT app_rls_bypass()));
