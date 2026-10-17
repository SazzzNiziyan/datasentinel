-- DropForeignKey
ALTER TABLE "uploads" DROP CONSTRAINT "uploads_workspace_id_created_by_membership_id_fkey";

-- DropForeignKey
ALTER TABLE "uploads" DROP CONSTRAINT "uploads_workspace_id_source_id_dataset_id_fkey";

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_workspace_id_source_id_dataset_id_fkey" FOREIGN KEY ("workspace_id", "source_id", "dataset_id") REFERENCES "datasets"("workspace_id", "source_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_workspace_id_created_by_membership_id_fkey" FOREIGN KEY ("workspace_id", "created_by_membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
