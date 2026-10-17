-- CreateEnum
CREATE TYPE "ProfileStatus" AS ENUM ('succeeded', 'failed');

-- CreateTable
CREATE TABLE "profile_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "upload_id" UUID,
    "status" "ProfileStatus" NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "row_count" BIGINT,
    "row_count_method" TEXT,
    "last_updated_at" TIMESTAMPTZ(3),
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "error" JSONB,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schema_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "profile_snapshot_id" UUID NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "schema_hash" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "row_count" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schema_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_snapshots_workspace_id_dataset_id_observed_at_idx" ON "profile_snapshots"("workspace_id", "dataset_id", "observed_at");

-- CreateIndex
CREATE INDEX "profile_snapshots_upload_id_idx" ON "profile_snapshots"("upload_id");

-- CreateIndex
CREATE UNIQUE INDEX "schema_snapshots_profile_snapshot_id_key" ON "schema_snapshots"("profile_snapshot_id");

-- CreateIndex
CREATE INDEX "schema_snapshots_workspace_id_dataset_id_observed_at_idx" ON "schema_snapshots"("workspace_id", "dataset_id", "observed_at");

-- AddForeignKey
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_workspace_id_source_id_dataset_id_fkey" FOREIGN KEY ("workspace_id", "source_id", "dataset_id") REFERENCES "datasets"("workspace_id", "source_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "schema_snapshots" ADD CONSTRAINT "schema_snapshots_workspace_id_source_id_dataset_id_fkey" FOREIGN KEY ("workspace_id", "source_id", "dataset_id") REFERENCES "datasets"("workspace_id", "source_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schema_snapshots" ADD CONSTRAINT "schema_snapshots_profile_snapshot_id_fkey" FOREIGN KEY ("profile_snapshot_id") REFERENCES "profile_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Checked at commit, so deleting a workspace can cascade in any order (as D-41).
ALTER TABLE "profile_snapshots" ALTER CONSTRAINT "profile_snapshots_upload_id_fkey" DEFERRABLE INITIALLY DEFERRED;

-- A succeeded profile has a row count and no error; a failed one the reverse.
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_outcome_check" CHECK (
  ("status" = 'succeeded' AND "row_count" IS NOT NULL AND "error" IS NULL)
  OR ("status" = 'failed' AND "row_count" IS NULL AND "error" IS NOT NULL)
);
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_row_count_check" CHECK ("row_count" >= 0);
ALTER TABLE "schema_snapshots" ADD CONSTRAINT "schema_snapshots_schema_hash_check" CHECK ("schema_hash" ~ '^[0-9a-f]{64}$');

-- Snapshots are history: rows are never changed. DELETE stays for
-- cascades and retention jobs.
CREATE FUNCTION snapshots_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profile_snapshots_no_update
BEFORE UPDATE ON "profile_snapshots"
FOR EACH ROW EXECUTE FUNCTION snapshots_refuse_update();

CREATE TRIGGER schema_snapshots_no_update
BEFORE UPDATE ON "schema_snapshots"
FOR EACH ROW EXECUTE FUNCTION snapshots_refuse_update();