-- The image a start asked for by name, for image governance. Additive and nullable: the previous release never reads or writes them.
ALTER TABLE "computers" ADD COLUMN "imageRef" TEXT;
ALTER TABLE "computers" ADD COLUMN "imageDigest" TEXT;
