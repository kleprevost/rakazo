-- An admin can suspend a bot: it takes no new runs until resumed. Both columns are nullable, so the previous release keeps working.
ALTER TABLE "bots" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "bots" ADD COLUMN "suspendedByUserId" TEXT;
