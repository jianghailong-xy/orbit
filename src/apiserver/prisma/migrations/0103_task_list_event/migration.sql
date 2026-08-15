-- A list's condition board: what the sweep noticed and would otherwise only have logged.
--
-- One row per (list, kind) — see the schema comment. The unique constraint is what makes the
-- recording an upsert, so a four-hour quota outage stays one row rather than 240.
CREATE TABLE "task_list_event" (
    "id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "task_list_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_list_event_list_id_kind_key" ON "task_list_event"("list_id", "kind");

ALTER TABLE "task_list_event" ADD CONSTRAINT "task_list_event_list_id_fkey"
    FOREIGN KEY ("list_id") REFERENCES "task_list"("id") ON DELETE CASCADE ON UPDATE CASCADE;
