-- CreateTable
CREATE TABLE "ai_usage_daily" (
    "workspace_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_daily_pkey" PRIMARY KEY ("workspace_id","day")
);

-- AddForeignKey
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_nonnegative_check"
  CHECK ("tokens" >= 0 AND "calls" >= 0);
