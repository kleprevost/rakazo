-- The version of its shared employee an instance last ran. Additive and nullable: the previous release never reads it.
ALTER TABLE "bots" ADD COLUMN "employeeVersionSeen" TEXT;
