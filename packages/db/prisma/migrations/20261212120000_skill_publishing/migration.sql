-- Publishing a taught skill to a pilot group. Additive: three new tables, nothing existing changes.
-- A version is a frozen copy of the playbook text (never the recording, and no pointer to the
-- source skill's transcript); an audience row pins one approved version for a user, a directory
-- claim or everyone. Publishing grants nothing: no table here is read by the capability broker.

CREATE TABLE "published_skills" (
  "id" TEXT NOT NULL,
  "authorUserId" TEXT,
  "sourceSkillId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "published_skills_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "published_skills_authorUserId_fkey" FOREIGN KEY ("authorUserId")
    REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "published_skills_authorUserId_sourceSkillId_key"
  ON "published_skills"("authorUserId", "sourceSkillId");

CREATE TABLE "published_skill_versions" (
  "id" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'submitted',
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "playbook" JSONB NOT NULL,
  "authorUserId" TEXT,
  "sourceSkillId" TEXT NOT NULL,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedBy" TEXT,
  "decidedAt" TIMESTAMP(3),
  "reason" TEXT,
  CONSTRAINT "published_skill_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "published_skill_versions_skillId_fkey" FOREIGN KEY ("skillId")
    REFERENCES "published_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "published_skill_versions_authorUserId_fkey" FOREIGN KEY ("authorUserId")
    REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "published_skill_versions_status_check"
    CHECK ("status" IN ('submitted', 'approved', 'rejected', 'withdrawn'))
);
CREATE UNIQUE INDEX "published_skill_versions_skillId_number_key"
  ON "published_skill_versions"("skillId", "number");
-- One submission waits for review at a time per skill.
CREATE UNIQUE INDEX "published_skill_versions_open_key"
  ON "published_skill_versions"("skillId") WHERE "status" = 'submitted';
CREATE INDEX "published_skill_versions_status_idx" ON "published_skill_versions"("status");
CREATE INDEX "published_skill_versions_authorUserId_idx" ON "published_skill_versions"("authorUserId");

-- The content of a version is frozen at submission; only the review outcome changes.
CREATE FUNCTION published_skill_versions_frozen() RETURNS trigger AS $$
BEGIN
  IF NEW."skillId" IS DISTINCT FROM OLD."skillId"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."description" IS DISTINCT FROM OLD."description"
     OR NEW."playbook" IS DISTINCT FROM OLD."playbook"
     OR NEW."sourceSkillId" IS DISTINCT FROM OLD."sourceSkillId"
     OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION 'published skill versions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER published_skill_versions_frozen BEFORE UPDATE ON "published_skill_versions"
  FOR EACH ROW EXECUTE FUNCTION published_skill_versions_frozen();

CREATE TABLE "published_skill_audiences" (
  "id" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "subjectKind" TEXT NOT NULL,
  "subjectValue" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "pinnedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "published_skill_audiences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "published_skill_audiences_skillId_fkey" FOREIGN KEY ("skillId")
    REFERENCES "published_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "published_skill_audiences_versionId_fkey" FOREIGN KEY ("versionId")
    REFERENCES "published_skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "published_skill_audiences_subjectKind_check" CHECK ("subjectKind" IN ('user', 'claim', 'all')),
  CONSTRAINT "published_skill_audiences_all_check" CHECK ("subjectKind" <> 'all' OR "subjectValue" = '*')
);
CREATE UNIQUE INDEX "published_skill_audiences_skillId_subjectKind_subjectValue_key"
  ON "published_skill_audiences"("skillId", "subjectKind", "subjectValue");
CREATE INDEX "published_skill_audiences_subjectKind_subjectValue_idx"
  ON "published_skill_audiences"("subjectKind", "subjectValue");
CREATE INDEX "published_skill_audiences_versionId_idx" ON "published_skill_audiences"("versionId");

-- Row-level security ships with each table. Every write goes through the system context after the
-- application role check. A person reads only what is pinned for them (an audience row naming
-- them, a claim they carry, or everyone), the version it pins, and their own submissions. The
-- audience policy does not look at the other tables, which would recurse.
ALTER TABLE "published_skill_audiences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY published_skill_audiences_tenant ON "published_skill_audiences" FOR SELECT
  USING (
    "subjectKind" = 'all'
    OR ("subjectKind" = 'user' AND "subjectValue" = NULLIF(current_setting('app.user_id', true), ''))
    OR ("subjectKind" = 'claim' AND "subjectValue" IN (
      SELECT unnest(c."values") FROM "user_directory_claims" c
      WHERE c."userId" = NULLIF(current_setting('app.user_id', true), '')
    ))
  );
CREATE POLICY published_skill_audiences_system ON "published_skill_audiences"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "published_skills" ENABLE ROW LEVEL SECURITY;
CREATE POLICY published_skills_tenant ON "published_skills" FOR SELECT
  USING (
    "authorUserId" = NULLIF(current_setting('app.user_id', true), '')
    OR EXISTS (SELECT 1 FROM "published_skill_audiences" a WHERE a."skillId" = "published_skills"."id")
  );
CREATE POLICY published_skills_system ON "published_skills"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "published_skill_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY published_skill_versions_tenant ON "published_skill_versions" FOR SELECT
  USING (
    "authorUserId" = NULLIF(current_setting('app.user_id', true), '')
    OR EXISTS (SELECT 1 FROM "published_skill_audiences" a WHERE a."versionId" = "published_skill_versions"."id")
  );
CREATE POLICY published_skill_versions_system ON "published_skill_versions"
  USING ((SELECT app_rls_bypass()));
