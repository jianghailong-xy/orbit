-- CreateTable
CREATE TABLE "approval" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "tool_use_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "decided_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_session_id_tool_use_id_key" ON "approval"("session_id", "tool_use_id");

-- CreateIndex
CREATE INDEX "approval_session_id_status_idx" ON "approval"("session_id", "status");

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
