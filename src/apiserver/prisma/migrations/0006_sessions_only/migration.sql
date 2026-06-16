-- Task is not implemented yet (the UI uses mock data), so the entire Task
-- subsystem is dropped. Interactive sessions become a first-class `Session`,
-- and the event/turn/tool/billing tables are rebuilt to hang off Session.
-- Existing data is discarded (test/scaffold only).

-- 1. Drop the Task subsystem and the old run-scoped child tables.
DROP TABLE IF EXISTS "ConversationTurn" CASCADE;
DROP TABLE IF EXISTS "RunEvent" CASCADE;
DROP TABLE IF EXISTS "ToolCall" CASCADE;
DROP TABLE IF EXISTS "LlmUsage" CASCADE;
DROP TABLE IF EXISTS "TaskSubscription" CASCADE;
DROP TABLE IF EXISTS "TaskRun" CASCADE;
DROP TABLE IF EXISTS "Task" CASCADE;
DROP TYPE IF EXISTS "TaskStatus";
DROP TYPE IF EXISTS "TaskSource";

-- 2. Activity loses its now-meaningless taskId.
DROP INDEX IF EXISTS "Activity_taskId_idx";
ALTER TABLE "Activity" DROP COLUMN IF EXISTS "taskId";

-- 3. Session: first-class interactive chat session.
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "assignedRunnerId" TEXT,
    "agentId" TEXT,
    "claudeSessionId" TEXT,
    "model" TEXT,
    "permissionMode" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "sumInputTokens" INTEGER NOT NULL DEFAULT 0,
    "sumOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "sumCacheRead" INTEGER NOT NULL DEFAULT 0,
    "sumCacheWrite" INTEGER NOT NULL DEFAULT 0,
    "numTurns" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastTurnAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Session_assignedRunnerId_status_idx" ON "Session"("assignedRunnerId", "status");
CREATE INDEX "Session_ownerId_idx" ON "Session"("ownerId");
CREATE INDEX "Session_status_idx" ON "Session"("status");
ALTER TABLE "Session" ADD CONSTRAINT "Session_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_assignedRunnerId_fkey" FOREIGN KEY ("assignedRunnerId") REFERENCES "Runner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Session-scoped event / tool / billing / turn tables.
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RunEvent_sessionId_seq_key" ON "RunEvent"("sessionId", "seq");
CREATE INDEX "RunEvent_sessionId_seq_idx" ON "RunEvent"("sessionId", "seq");
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ToolCall_sessionId_idx" ON "ToolCall"("sessionId");
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LlmUsage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LlmUsage_sessionId_idx" ON "LlmUsage"("sessionId");
ALTER TABLE "LlmUsage" ADD CONSTRAINT "LlmUsage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConversationTurn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "clientTurnId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "content" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "deliveredAt" TIMESTAMP(3),
    "leaseDeadlineAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationTurn_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConversationTurn_sessionId_clientTurnId_key" ON "ConversationTurn"("sessionId", "clientTurnId");
CREATE UNIQUE INDEX "ConversationTurn_sessionId_seq_key" ON "ConversationTurn"("sessionId", "seq");
CREATE INDEX "ConversationTurn_sessionId_status_idx" ON "ConversationTurn"("sessionId", "status");
ALTER TABLE "ConversationTurn" ADD CONSTRAINT "ConversationTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
