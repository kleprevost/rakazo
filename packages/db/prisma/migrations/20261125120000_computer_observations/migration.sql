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

-- One row leases the observer's sweep to a single instance until it expires.
CREATE TABLE "computer_observer_leases" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "claimedUntil" TIMESTAMP(3) NOT NULL
);
ALTER TABLE "computer_observer_leases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_observer_leases_system ON "computer_observer_leases"
  USING ((SELECT app_rls_bypass()));
