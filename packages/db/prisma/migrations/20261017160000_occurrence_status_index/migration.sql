-- CreateIndex
CREATE INDEX "schedule_occurrences_status_created_at_idx" ON "schedule_occurrences"("status", "created_at");
