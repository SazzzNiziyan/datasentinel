-- CreateEnum
CREATE TYPE "DestinationType" AS ENUM ('email', 'slack', 'webhook');

-- CreateTable
CREATE TABLE "destinations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DestinationType" NOT NULL,
    "status" "LifecycleStatus" NOT NULL DEFAULT 'active',
    "events" TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "ciphertext" BYTEA,
    "key_version" INTEGER,
    "secret_rotated_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "destinations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "destinations_workspace_id_name_key" ON "destinations"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "destinations_workspace_id_id_key" ON "destinations"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A destination's secret is all-or-nothing, and its events are known kinds (D-88).
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_secret_check"
  CHECK (("ciphertext" IS NULL) = ("key_version" IS NULL));
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_events_check"
  CHECK (cardinality("events") BETWEEN 1 AND 3
    AND "events" <@ ARRAY['incident_opened','incident_reopened','incident_assigned']);
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_secret_required_check"
  CHECK ("type" = 'email' OR "ciphertext" IS NOT NULL);
