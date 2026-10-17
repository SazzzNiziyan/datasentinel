-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('open', 'acknowledged', 'investigating', 'resolved', 'reopened');

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "severity" "RuleSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'open',
    "assigned_membership_id" UUID,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_failure_at" TIMESTAMPTZ(3) NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_membership_id" UUID,
    "type" TEXT NOT NULL,
    "from_status" "IncidentStatus",
    "to_status" "IncidentStatus",
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "reference_id" UUID NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_workspace_id_status_opened_at_idx" ON "incidents"("workspace_id", "status", "opened_at");

-- CreateIndex
CREATE INDEX "incidents_workspace_id_dedupe_key_opened_at_idx" ON "incidents"("workspace_id", "dedupe_key", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_workspace_id_id_key" ON "incidents"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "incident_events_workspace_id_incident_id_created_at_idx" ON "incident_events"("workspace_id", "incident_id", "created_at");

-- CreateIndex
CREATE INDEX "evidence_workspace_id_incident_id_idx" ON "evidence"("workspace_id", "incident_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_incident_id_kind_reference_id_key" ON "evidence"("incident_id", "kind", "reference_id");

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_workspace_id_source_id_dataset_id_fkey" FOREIGN KEY ("workspace_id", "source_id", "dataset_id") REFERENCES "datasets"("workspace_id", "source_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_workspace_id_rule_id_fkey" FOREIGN KEY ("workspace_id", "rule_id") REFERENCES "quality_rules"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_workspace_id_assigned_membership_id_fkey" FOREIGN KEY ("workspace_id", "assigned_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_workspace_id_incident_id_fkey" FOREIGN KEY ("workspace_id", "incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_workspace_id_actor_membership_id_fkey" FOREIGN KEY ("workspace_id", "actor_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_workspace_id_incident_id_fkey" FOREIGN KEY ("workspace_id", "incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one unresolved incident per rule key in a workspace (D-80). Two
-- checks failing at once cannot both open an incident: the second insert
-- fails and retries as an append.
CREATE UNIQUE INDEX "incidents_one_unresolved_per_key"
  ON "incidents"("workspace_id", "dedupe_key")
  WHERE "status" <> 'resolved';

-- Membership references are checked at the end of the statement (D-36), so
-- deleting a workspace can remove incidents and memberships together.
ALTER TABLE "incidents" ALTER CONSTRAINT "incidents_workspace_id_assigned_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "incident_events" ALTER CONSTRAINT "incident_events_workspace_id_actor_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;
