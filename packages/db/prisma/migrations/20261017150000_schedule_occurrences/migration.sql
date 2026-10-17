-- CreateEnum
CREATE TYPE "OccurrenceStatus" AS ENUM ('pending', 'enqueued', 'skipped');

-- AlterTable
ALTER TABLE "check_runs" ADD COLUMN     "occurrence_id" UUID;

-- CreateTable
CREATE TABLE "schedule_occurrences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "status" "OccurrenceStatus" NOT NULL DEFAULT 'pending',
    "missed_before" INTEGER NOT NULL DEFAULT 0,
    "skip_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_occurrences_workspace_id_created_at_idx" ON "schedule_occurrences"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_occurrences_schedule_id_scheduled_for_key" ON "schedule_occurrences"("schedule_id", "scheduled_for");

-- CreateIndex
CREATE INDEX "check_runs_occurrence_id_idx" ON "check_runs"("occurrence_id");

-- AddForeignKey
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "schedule_occurrences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
