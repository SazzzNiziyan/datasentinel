-- CreateEnum
CREATE TYPE "DocumentFormat" AS ENUM ('text', 'markdown');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID,
    "name" TEXT NOT NULL,
    "format" "DocumentFormat" NOT NULL,
    "size_chars" INTEGER NOT NULL,
    "chunk_count" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "status" "LifecycleStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "section_title" TEXT,
    "section_path" TEXT,
    "start_line" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "search" tsvector GENERATED ALWAYS AS (
      to_tsvector('english', coalesce("section_path", '') || ' ' || "text")
    ) STORED,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_workspace_id_status_created_at_idx" ON "documents"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "documents_workspace_id_id_key" ON "documents"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "document_chunks_workspace_id_document_id_idx" ON "document_chunks"("workspace_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_document_id_ordinal_key" ON "document_chunks"("document_id", "ordinal");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_workspace_id_document_id_fkey" FOREIGN KEY ("workspace_id", "document_id") REFERENCES "documents"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text search over chunks (D-105). No extension is needed.
CREATE INDEX "document_chunks_search_idx" ON "document_chunks" USING GIN ("search");

-- The same file is stored once among a workspace's active documents.
CREATE UNIQUE INDEX "documents_active_content_key"
  ON "documents" ("workspace_id", "content_hash") WHERE "status" <> 'archived';

ALTER TABLE "documents" ADD CONSTRAINT "documents_size_check"
  CHECK ("size_chars" BETWEEN 1 AND 200000 AND "chunk_count" BETWEEN 0 AND 400);
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_range_check"
  CHECK ("ordinal" >= 0 AND "start_line" >= 1 AND "end_line" >= "start_line"
    AND char_length("text") BETWEEN 1 AND 1200);
