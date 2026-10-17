-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'sent', 'failed', 'suppressed');

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "incident_event_id" UUID NOT NULL,
    "recipient_membership_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_outbox_status_next_attempt_at_idx" ON "notification_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notification_outbox_workspace_id_incident_id_idx" ON "notification_outbox"("workspace_id", "incident_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_incident_event_id_recipient_membership__key" ON "notification_outbox"("incident_event_id", "recipient_membership_id");

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_workspace_id_incident_id_fkey" FOREIGN KEY ("workspace_id", "incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_incident_event_id_fkey" FOREIGN KEY ("incident_event_id") REFERENCES "incident_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_workspace_id_recipient_membership_id_fkey" FOREIGN KEY ("workspace_id", "recipient_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Membership references are checked at the end of the statement (D-36).
ALTER TABLE "notification_outbox" ALTER CONSTRAINT "notification_outbox_workspace_id_recipient_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_kind_check"
  CHECK ("kind" IN ('incident_opened', 'incident_reopened', 'incident_assigned'));
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_attempts_check"
  CHECK ("attempts" >= 0);
