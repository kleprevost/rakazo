-- An admin can quarantine one bot, a Space, a chat group or every bot. A new table, so the previous release keeps working.
CREATE TABLE "quarantines" (
    "id" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeId" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMP(3),
    "liftedByUserId" TEXT,
    "summary" JSONB,

    CONSTRAINT "quarantines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "quarantines_scopeKind_scopeId_liftedAt_idx" ON "quarantines"("scopeKind", "scopeId", "liftedAt");
