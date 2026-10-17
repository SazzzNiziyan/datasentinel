-- CreateEnum
CREATE TYPE "PipelineRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'unknown');

-- CreateTable
CREATE TABLE "integration_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "secret_hash" BYTEA NOT NULL,
    "created_by_membership_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "integration_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "dataset_id" UUID,
    "external_run_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PipelineRunStatus" NOT NULL,
    "trigger" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "last_event_at" TIMESTAMPTZ(3) NOT NULL,
    "correlation_id" TEXT,
    "summary" TEXT,
    "created_by_token_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_tokens_workspace_id_source_id_idx" ON "integration_tokens"("workspace_id", "source_id");

-- CreateIndex
CREATE INDEX "pipeline_runs_workspace_id_created_at_idx" ON "pipeline_runs"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_runs_source_id_external_run_id_key" ON "pipeline_runs"("source_id", "external_run_id");

-- AddForeignKey
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_workspace_id_source_id_fkey" FOREIGN KEY ("workspace_id", "source_id") REFERENCES "data_sources"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_workspace_id_created_by_membership_id_fkey" FOREIGN KEY ("workspace_id", "created_by_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_workspace_id_source_id_fkey" FOREIGN KEY ("workspace_id", "source_id") REFERENCES "data_sources"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_workspace_id_source_id_dataset_id_fkey" FOREIGN KEY ("workspace_id", "source_id", "dataset_id") REFERENCES "datasets"("workspace_id", "source_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
