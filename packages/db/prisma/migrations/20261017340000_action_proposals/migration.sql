-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('proposed', 'approved', 'rejected', 'expired', 'running', 'succeeded', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "require_second_approver" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "action_proposals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'proposed',
    "note" TEXT,
    "proposed_by_membership_id" UUID NOT NULL,
    "decided_by_membership_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "proposal_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "approved_payload_hash" TEXT,
    "approval_expires_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),
    "failure_code" TEXT,
    "output" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "action_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_membership_id" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_proposals_workspace_id_incident_id_created_at_idx" ON "action_proposals"("workspace_id", "incident_id", "created_at");

-- CreateIndex
CREATE INDEX "action_proposals_status_next_attempt_at_idx" ON "action_proposals"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "action_proposals_workspace_id_id_key" ON "action_proposals"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "action_events_workspace_id_action_id_created_at_idx" ON "action_events"("workspace_id", "action_id", "created_at");

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_workspace_id_incident_id_fkey" FOREIGN KEY ("workspace_id", "incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_workspace_id_action_id_fkey" FOREIGN KEY ("workspace_id", "action_id") REFERENCES "action_proposals"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The action types that exist (D-113), a real hash, and sane counters.
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_type_check"
  CHECK ("type" IN ('rerun_validation', 'retry_import', 'send_notification',
                    'create_github_issue', 'trigger_n8n'));
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_hash_check"
  CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'
    AND ("approved_payload_hash" IS NULL OR "approved_payload_hash" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_counters_check"
  CHECK ("attempts" >= 0 AND ("note" IS NULL OR char_length("note") <= 300)
    AND ("decision_note" IS NULL OR char_length("decision_note") <= 300));

-- A status is backed by its fields (D-114): an approved, running, or finished
-- action always carries who approved it, the hash they saw, and its expiry.
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_status_check"
  CHECK (
    ("status" IN ('proposed', 'rejected', 'cancelled') AND "approved_payload_hash" IS NULL)
    OR ("status" = 'expired')
    OR ("status" IN ('approved', 'running', 'succeeded', 'failed')
        AND "approved_payload_hash" IS NOT NULL AND "approval_expires_at" IS NOT NULL
        AND "decided_by_membership_id" IS NOT NULL AND "decided_at" IS NOT NULL)
  );

-- What was proposed never changes (D-114): approving a payload means approving
-- exactly these bytes, so the payload, its hash, its type, and its incident are frozen.
CREATE FUNCTION action_proposals_freeze() RETURNS trigger AS $$
BEGIN
  IF NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."payload_hash" <> OLD."payload_hash"
     OR NEW."type" <> OLD."type"
     OR NEW."incident_id" <> OLD."incident_id"
     OR NEW."proposed_by_membership_id" <> OLD."proposed_by_membership_id" THEN
    RAISE EXCEPTION 'a proposed action cannot be changed';
  END IF;
  -- Finished actions stay finished.
  IF OLD."status" IN ('succeeded', 'failed', 'rejected', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'a finished action cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER action_proposals_freeze
BEFORE UPDATE ON "action_proposals"
FOR EACH ROW EXECUTE FUNCTION action_proposals_freeze();

-- The log is append-only (D-117).
CREATE TRIGGER action_events_no_update
BEFORE UPDATE ON "action_events"
FOR EACH ROW EXECUTE FUNCTION snapshots_refuse_update();

ALTER TABLE "action_events" ADD CONSTRAINT "action_events_actor_check"
  CHECK ("actor_type" IN ('user', 'system'));
