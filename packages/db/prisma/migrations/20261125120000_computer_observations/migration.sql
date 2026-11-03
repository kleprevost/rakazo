-- The latest provider report on each computer, written only by the fleet observer. Additive: the previous release never reads it.
CREATE TABLE "computer_observations" (
  "computerId" TEXT NOT NULL PRIMARY KEY REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "runtime" TEXT NOT NULL,
  "imageRef" TEXT,
  "imageDigest" TEXT,
  "isolation" TEXT NOT NULL,
  "restartCount" INTEGER,
  "startedAt" TIMESTAMP(3),
  "cpuMillis" INTEGER,
  "memoryBytes" BIGINT,
  "memoryLimitBytes" BIGINT,
  "pids" INTEGER,
  "egressMode" TEXT,
  "egressEnforced" BOOLEAN,
  "health" TEXT
);
ALTER TABLE "computer_observations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_observations_system ON "computer_observations"
  USING ((SELECT app_rls_bypass()));
