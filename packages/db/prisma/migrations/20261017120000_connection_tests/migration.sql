-- CreateEnum
CREATE TYPE "ConnectionTestStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "connection_tests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "status" "ConnectionTestStatus" NOT NULL DEFAULT 'queued',
    "server_version" TEXT,
    "latency_ms" INTEGER,
    "error" JSONB,
    "requested_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "connection_tests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_tests_workspace_id_source_id_created_at_idx" ON "connection_tests"("workspace_id", "source_id", "created_at");

-- AddForeignKey
ALTER TABLE "connection_tests" ADD CONSTRAINT "connection_tests_workspace_id_source_id_fkey" FOREIGN KEY ("workspace_id", "source_id") REFERENCES "data_sources"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_tests" ADD CONSTRAINT "connection_tests_workspace_id_requested_by_membership_id_fkey" FOREIGN KEY ("workspace_id", "requested_by_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
