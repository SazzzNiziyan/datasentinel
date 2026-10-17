-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('postgres', 'csv', 'http_api', 'pipeline_event');

-- CreateEnum
CREATE TYPE "LifecycleStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "Sensitivity" AS ENUM ('public', 'internal', 'confidential', 'restricted');

-- CreateTable
CREATE TABLE "data_sources" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,
    "status" "LifecycleStatus" NOT NULL DEFAULT 'active',
    "owner_membership_id" UUID,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "last_checked_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_credentials" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "datasets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "stable_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner_membership_id" UUID,
    "locator" JSONB NOT NULL DEFAULT '{}',
    "status" "LifecycleStatus" NOT NULL DEFAULT 'active',
    "sensitivity" "Sensitivity" NOT NULL DEFAULT 'internal',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_sources_workspace_id_name_key" ON "data_sources"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "data_sources_workspace_id_id_key" ON "data_sources"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "source_credentials_source_id_idx" ON "source_credentials"("source_id");

-- CreateIndex
CREATE INDEX "datasets_workspace_id_status_idx" ON "datasets"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "datasets_workspace_id_source_id_stable_key_key" ON "datasets"("workspace_id", "source_id", "stable_key");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_workspace_id_id_key" ON "memberships"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_workspace_id_owner_membership_id_fkey" FOREIGN KEY ("workspace_id", "owner_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "source_credentials" ADD CONSTRAINT "source_credentials_workspace_id_source_id_fkey" FOREIGN KEY ("workspace_id", "source_id") REFERENCES "data_sources"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_workspace_id_source_id_fkey" FOREIGN KEY ("workspace_id", "source_id") REFERENCES "data_sources"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_workspace_id_owner_membership_id_fkey" FOREIGN KEY ("workspace_id", "owner_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- At most one active (not revoked) credential per source (D-36).
CREATE UNIQUE INDEX "source_credentials_one_active" ON "source_credentials"("source_id") WHERE "revoked_at" IS NULL;
