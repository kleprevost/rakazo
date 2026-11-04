-- An API instance holds a person's claim row while it reads their groups from the directory. Nullable, so the previous release keeps working.
ALTER TABLE "user_directory_claims" ADD COLUMN "syncLeaseUntil" TIMESTAMP(3);
