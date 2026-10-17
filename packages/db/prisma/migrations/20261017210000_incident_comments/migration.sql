-- CreateTable
CREATE TABLE "incident_comments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "author_membership_id" UUID,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incident_comments_workspace_id_incident_id_created_at_idx" ON "incident_comments"("workspace_id", "incident_id", "created_at");

-- AddForeignKey
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_workspace_id_incident_id_fkey" FOREIGN KEY ("workspace_id", "incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_workspace_id_author_membership_id_fkey" FOREIGN KEY ("workspace_id", "author_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Membership references are checked at the end of the statement (D-36).
ALTER TABLE "incident_comments" ALTER CONSTRAINT "incident_comments_workspace_id_author_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;

-- A comment is never edited (D-85): the record of who said what stays true.
CREATE TRIGGER incident_comments_no_update
BEFORE UPDATE ON "incident_comments"
FOR EACH ROW EXECUTE FUNCTION snapshots_refuse_update();

ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_text_check"
  CHECK (char_length("text") BETWEEN 1 AND 2000);
