-- A deprovisioned account keeps its data but cannot hold a session or sign in. Both columns are nullable, so the previous release keeps working.
ALTER TABLE "user" ADD COLUMN "deprovisionedAt" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "deprovisionedVia" TEXT;
