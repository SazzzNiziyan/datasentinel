-- Like the other membership references (D-36): checked at the end of the statement, so deleting a workspace can remove tokens and memberships together.
ALTER TABLE "integration_tokens" ALTER CONSTRAINT "integration_tokens_workspace_id_created_by_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "pipeline_runs" ALTER CONSTRAINT "pipeline_runs_workspace_id_source_id_dataset_id_fkey" DEFERRABLE INITIALLY DEFERRED;
