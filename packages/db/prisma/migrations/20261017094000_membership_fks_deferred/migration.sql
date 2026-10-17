-- Owner and inviter links to memberships are checked at commit, so deleting a
-- workspace can cascade through memberships, sources, and datasets in any
-- order. Removing one member who still owns something is still refused.
ALTER TABLE "data_sources" ALTER CONSTRAINT "data_sources_workspace_id_owner_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "datasets" ALTER CONSTRAINT "datasets_workspace_id_owner_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "invitations" ALTER CONSTRAINT "invitations_workspace_id_invited_by_membership_id_fkey" DEFERRABLE INITIALLY DEFERRED;