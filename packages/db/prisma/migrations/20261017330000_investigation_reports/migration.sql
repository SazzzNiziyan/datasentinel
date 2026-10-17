-- CreateEnum
CREATE TYPE "InvestigationStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "investigation_reports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "InvestigationStatus" NOT NULL DEFAULT 'pending',
    "failure_code" TEXT,
    "report" JSONB,
    "evidence_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "schema_version" INTEGER NOT NULL,
    "template_version" INTEGER NOT NULL,
    "provider_name" TEXT,
    "model" TEXT,
    "excerpt_count" INTEGER NOT NULL DEFAULT 0,
    "redactions" JSONB NOT NULL DEFAULT '{}',
    "requested_by_membership_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "investigation_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investigation_feedback" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "rating" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investigation_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "investigation_reports_workspace_id_incident_id_created_at_idx" ON "investigation_reports"("workspace_id", "incident_id", "created_at");

-- CreateIndex
CREATE INDEX "investigation_reports_status_lease_until_idx" ON "investigation_reports"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "investigation_reports_incident_id_version_key" ON "investigation_reports"("incident_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "investigation_reports_workspace_id_id_key" ON "investigation_reports"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "investigation_feedback_report_id_membership_id_key" ON "investigation_feedback"("report_id", "membership_id");

-- AddForeignKey
ALTER TABLE "investigation_reports" ADD CONSTRAINT "investigation_reports_workspace_id_incident_id_fkey" FOREIGN KEY ("workspace_id", "incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investigation_feedback" ADD CONSTRAINT "investigation_feedback_workspace_id_report_id_fkey" FOREIGN KEY ("workspace_id", "report_id") REFERENCES "investigation_reports"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A report row is consistent with its status (D-108).
ALTER TABLE "investigation_reports" ADD CONSTRAINT "investigation_reports_status_check"
  CHECK (
    ("status" = 'pending' AND "report" IS NULL AND "failure_code" IS NULL AND "completed_at" IS NULL)
    OR ("status" = 'ready' AND "report" IS NOT NULL AND "failure_code" IS NULL AND "completed_at" IS NOT NULL)
    OR ("status" = 'failed' AND "report" IS NULL AND "failure_code" IS NOT NULL AND "completed_at" IS NOT NULL)
  );
ALTER TABLE "investigation_reports" ADD CONSTRAINT "investigation_reports_numbers_check"
  CHECK ("version" >= 1 AND "attempts" >= 0 AND "excerpt_count" >= 0);

-- A finished report never changes: it is the record of what was advised.
CREATE FUNCTION investigation_reports_freeze() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'a finished investigation report cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER investigation_reports_freeze
BEFORE UPDATE ON "investigation_reports"
FOR EACH ROW EXECUTE FUNCTION investigation_reports_freeze();

ALTER TABLE "investigation_feedback" ADD CONSTRAINT "investigation_feedback_rating_check"
  CHECK ("rating" IN ('helpful', 'not_helpful') AND ("note" IS NULL OR char_length("note") <= 500));
