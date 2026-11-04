-- Fleet terminate: a maintenance update that saves the home and destroys the machine but starts no
-- replacement. Additive column with a default: the previous release never reads it and inserts without it.
ALTER TABLE "computer_updates" ADD COLUMN "stopOnly" BOOLEAN NOT NULL DEFAULT false;
