-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "incident_event_id" UUID NOT NULL,
    "destination_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notification_deliveries_workspace_id_incident_id_idx" ON "notification_deliveries"("workspace_id", "incident_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_incident_event_id_destination_id_key" ON "notification_deliveries"("incident_event_id", "destination_id");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_workspace_id_destination_id_fkey" FOREIGN KEY ("workspace_id", "destination_id") REFERENCES "destinations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Delivery bookkeeping stays sane (D-89).
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_attempts_check"
  CHECK ("attempts" >= 0);
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_sent_check"
  CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));
