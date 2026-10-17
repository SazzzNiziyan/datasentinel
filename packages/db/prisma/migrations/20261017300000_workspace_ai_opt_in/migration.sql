-- Workspaces opt in to AI investigation (D-99); off by default.
ALTER TABLE "workspaces" ADD COLUMN "ai_enabled" BOOLEAN NOT NULL DEFAULT false;
