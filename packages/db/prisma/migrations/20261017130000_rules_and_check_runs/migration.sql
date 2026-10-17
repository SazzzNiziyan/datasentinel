-- CreateEnum
CREATE TYPE "RuleSeverity" AS ENUM ('critical', 'warning', 'info');

-- CreateEnum
CREATE TYPE "CheckTrigger" AS ENUM ('manual', 'schedule', 'event');

-- CreateEnum
CREATE TYPE "CheckRunStatus" AS ENUM ('queued', 'running', 'passed', 'failed', 'insufficient_data', 'error');

-- CreateTable
CREATE TABLE "quality_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "RuleSeverity" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "current_version" INTEGER NOT NULL,
    "created_by_membership_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quality_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_revisions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "severity" "RuleSeverity" NOT NULL,
    "created_by_membership_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_revision_id" UUID NOT NULL,
    "trigger" "CheckTrigger" NOT NULL,
    "status" "CheckRunStatus" NOT NULL DEFAULT 'queued',
    "expected" JSONB,
    "actual" JSONB,
    "error" JSONB,
    "idempotency_key" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quality_rules_workspace_id_dataset_id_idx" ON "quality_rules"("workspace_id", "dataset_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_rules_workspace_id_id_key" ON "quality_rules"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_revisions_rule_id_version_key" ON "rule_revisions"("rule_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "rule_revisions_workspace_id_id_key" ON "rule_revisions"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "check_runs_workspace_id_rule_id_created_at_idx" ON "check_runs"("workspace_id", "rule_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "check_runs_workspace_id_idempotency_key_key" ON "check_runs"("workspace_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "quality_rules" ADD CONSTRAINT "quality_rules_workspace_id_source_id_dataset_id_fkey" FOREIGN KEY ("workspace_id", "source_id", "dataset_id") REFERENCES "datasets"("workspace_id", "source_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_rules" ADD CONSTRAINT "quality_rules_workspace_id_created_by_membership_id_fkey" FOREIGN KEY ("workspace_id", "created_by_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rule_revisions" ADD CONSTRAINT "rule_revisions_workspace_id_rule_id_fkey" FOREIGN KEY ("workspace_id", "rule_id") REFERENCES "quality_rules"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_revisions" ADD CONSTRAINT "rule_revisions_workspace_id_created_by_membership_id_fkey" FOREIGN KEY ("workspace_id", "created_by_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_workspace_id_rule_id_fkey" FOREIGN KEY ("workspace_id", "rule_id") REFERENCES "quality_rules"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_workspace_id_rule_revision_id_fkey" FOREIGN KEY ("workspace_id", "rule_revision_id") REFERENCES "rule_revisions"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Creator links are checked at commit, like other membership links (see
-- 20261017094000), so deleting a workspace can cascade in any order.
ALTER TABLE "quality_rules" ALTER CONSTRAINT "quality_rules_workspace_id_created_by_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "rule_revisions" ALTER CONSTRAINT "rule_revisions_workspace_id_created_by_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;

-- A revision is the exact definition a past check ran: never changed.
CREATE TRIGGER rule_revisions_no_update
BEFORE UPDATE ON "rule_revisions"
FOR EACH ROW EXECUTE FUNCTION snapshots_refuse_update();

-- A finished check run is a result: never changed (FR-06).
CREATE FUNCTION check_runs_refuse_final_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'finished check runs are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_runs_final
BEFORE UPDATE ON "check_runs"
FOR EACH ROW EXECUTE FUNCTION check_runs_refuse_final_update();
