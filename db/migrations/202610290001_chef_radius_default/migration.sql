-- New chef rows follow the 15km product default. Existing rows keep their stored radius.
ALTER TABLE "Chef" ALTER COLUMN "serviceRadiusM" SET DEFAULT 15000;
