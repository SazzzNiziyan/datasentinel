-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('awaiting_upload', 'queued', 'parsing', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "dataset_id" UUID,
    "new_dataset_name" TEXT,
    "object_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'awaiting_upload',
    "error" JSONB,
    "created_by_membership_id" UUID NOT NULL,
    "upload_url_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "retain_until" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uploads_object_key_key" ON "uploads"("object_key");

-- CreateIndex
CREATE INDEX "uploads_workspace_id_source_id_created_at_idx" ON "uploads"("workspace_id", "source_id", "created_at");

-- CreateIndex
CREATE INDEX "uploads_retain_until_idx" ON "uploads"("retain_until");

-- CreateIndex
CREATE UNIQUE INDEX "datasets_workspace_id_source_id_id_key" ON "datasets"("workspace_id", "source_id", "id");

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_workspace_id_source_id_fkey" FOREIGN KEY ("workspace_id", "source_id") REFERENCES "data_sources"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_workspace_id_source_id_dataset_id_fkey" FOREIGN KEY ("workspace_id", "source_id", "dataset_id") REFERENCES "datasets"("workspace_id", "source_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_workspace_id_created_by_membership_id_fkey" FOREIGN KEY ("workspace_id", "created_by_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- D-08: at most 50 MB; checksum is lowercase hex; an upload always names a dataset target.
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_size_bytes_check" CHECK ("size_bytes" BETWEEN 1 AND 52428800);
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_checksum_sha256_check" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_dataset_target_check" CHECK ("dataset_id" IS NOT NULL OR "new_dataset_name" IS NOT NULL);
