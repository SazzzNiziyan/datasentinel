-- CreateEnum
CREATE TYPE "ScheduleTarget" AS ENUM ('dataset', 'rule');

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "rule_id" UUID,
    "target_type" "ScheduleTarget" NOT NULL,
    "definition" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "anchor_at" TIMESTAMPTZ(3) NOT NULL,
    "next_run_at" TIMESTAMPTZ(3),
    "last_run_at" TIMESTAMPTZ(3),
    "created_by_membership_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedules_enabled_next_run_at_idx" ON "schedules"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "schedules_workspace_id_dataset_id_idx" ON "schedules"("workspace_id", "dataset_id");

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workspace_id_source_id_dataset_id_fkey" FOREIGN KEY ("workspace_id", "source_id", "dataset_id") REFERENCES "datasets"("workspace_id", "source_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workspace_id_rule_id_fkey" FOREIGN KEY ("workspace_id", "rule_id") REFERENCES "quality_rules"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workspace_id_created_by_membership_id_fkey" FOREIGN KEY ("workspace_id", "created_by_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- A rule schedule names its rule; a dataset schedule names none (D-69).
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_target_matches_rule"
  CHECK (("target_type" = 'rule') = ("rule_id" IS NOT NULL));

-- Checked at commit, like other membership links (20261017094000).
ALTER TABLE "schedules" ALTER CONSTRAINT "schedules_workspace_id_created_by_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;
