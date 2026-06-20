-- Task dependencies: "B depends on A" edges + a per-task auto-run toggle. A dependent
-- task may only run once every prerequisite reaches DONE; when the last one does, the
-- task auto-runs unless auto_run_when_ready is off. The graph is kept acyclic in code.

-- Pipeline default: auto-run a task once its prerequisites are all DONE.
ALTER TABLE "task" ADD COLUMN "auto_run_when_ready" BOOLEAN NOT NULL DEFAULT true;

-- Dependency edges. task_id = the dependent (blocked) task; depends_on_task_id = the
-- prerequisite it waits on. Both cascade-delete with their task.
CREATE TABLE "task_dependency" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "depends_on_task_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_dependency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_dependency_task_id_depends_on_task_id_key" ON "task_dependency" ("task_id", "depends_on_task_id");
CREATE INDEX "task_dependency_depends_on_task_id_idx" ON "task_dependency" ("depends_on_task_id");

ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_depends_on_task_id_fkey" FOREIGN KEY ("depends_on_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
