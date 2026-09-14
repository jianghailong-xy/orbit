-- 0267 —— 第四种完成判据 OWNER_CONFIRMED：账户所有者本人的一条决定派生 DONE。
--
-- 另外三种判据都要靠一次运行或另一方的裁决：EXECUTABLE 比退出码，VERIFICATION 读独立验证任务的
-- PASS，EVIDENCE_JUDGMENT 读独立会话对当前证据版本的 CONFIRM。只想当记录用、或者只想由所有者本人
-- 拍板的任务没有落点。本迁移给它一个，一共四件事：
--
--   1. `task_completion_criterion` 多一个标签 `OWNER_CONFIRMED`；
--   2. `task_owner_confirmation_request`：任务的一次运行成功结束了一轮，所有者因此被问一次。写它的
--      只有 `runnerApi.turnComplete`，因为整个系统里只有那里知道「这一轮成功了」——runner 的
--      `turn_end` 事件不带成败，API 错误照样报 success——所以「等待确认」只能在那里记下，不能事后
--      从事件流里推；
--   3. `task_owner_decision`：所有者本人对任务的决定，CONFIRM 或 SEND_BACK，写下就不再改；
--   4. `task_done_canonical_writer_fence` 的新 lane：所有者最新的一条决定是 CONFIRM。
--
-- 谁能写决定行
-- ============
-- 只有账户所有者本人：app 的登录凭据，请求上没有 session 头。门在应用层（`task-owner-confirmation.ts`），
-- 表上把能表达的都表达出来：`decided_by_type` 只能是 USER，`decided_by_id` 必须等于 `owner_id`。
-- agent 会话（任务自己的运行、协调会话、任何别的会话）来确认，门口直接拒绝，一行都不写。
--
-- 为什么决定要指着请求
-- ====================
-- 卡片是为某一次运行的汇报画的。所有者读卡的时候同一个会话又跑完一轮，卡上那份汇报就不是现在要问的
-- 那份了。`request_id` 让门做 compare-and-set：答的必须是当前那条还没有决定的请求；从没跑过的任务
-- 没有请求，面板上的确认答的是 NULL。一条请求至多一条决定（`task_owner_decision_request_key`），
-- 复合外键 (`request_id`, `task_id`) 让一条决定不可能指着别的任务的请求。
--
-- SEND_BACK 不写 task
-- ===================
-- 退回的理由作为下一条用户消息投进请求所在的那个会话（`sessionsService.createTurn`，决定行与那一轮
-- 在同一个事务里提交），任务保持 OPEN；下一轮成功结束会记下一条新请求，于是重新进入等待。CHECK 要求
-- 退回带非空理由、并且指着请求——理由投进的正是那条请求所在的会话，所以决定行上不再另记一遍。
--
-- 请求上的会话 id 与 turn id 不带外键
-- ===================================
-- 与 0238 的 `deciding_session_id` 同一条理由：它们是出处快照。会话被清理之后，「当时是哪一轮在问、
-- 理由投进了哪里」仍然是当时的事实，不是一条现在还必须能解引用的边。
--
-- 为什么 ADD VALUE 与后面的语句同在一个事务里也安全
-- ================================================
-- PostgreSQL 不允许在同一事务里「使用」刚加的枚举值。本迁移没有任何语句求值 'OWNER_CONFIRMED'：两张
-- 新表不引用 `task_completion_criterion`，fence 函数体是 plpgsql，字面量要到第一次执行才解析，而那时
-- 本迁移早已提交。
--
-- 明确没有做的事
-- ==============
-- 不加触发器，没有任何 DML：两张新表都是空的，已有的任务一行都不动。fence 是 CREATE OR REPLACE，所以
-- 0228、0230、0239 写下的每一条 lane 都在这里逐字重述；随本迁移改变的只有新增的这一条 lane 和 HINT。

ALTER TYPE "task_completion_criterion" ADD VALUE IF NOT EXISTS 'OWNER_CONFIRMED';

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_owner_decision_value') THEN
    CREATE TYPE "task_owner_decision_value" AS ENUM ('CONFIRM', 'SEND_BACK');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "task_owner_confirmation_request" (
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_owner_confirmation_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_owner_confirmation_request_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 决定行的复合外键指向这一对。
CREATE UNIQUE INDEX IF NOT EXISTS "task_owner_confirmation_request_id_task_key"
  ON "task_owner_confirmation_request"("id", "task_id");
-- 一轮至多问一次：/turn-complete 被重试也不会问第二次。
CREATE UNIQUE INDEX IF NOT EXISTS "task_owner_confirmation_request_turn_key"
  ON "task_owner_confirmation_request"("session_id", "turn_id");
CREATE INDEX IF NOT EXISTS "task_owner_confirmation_request_task_idx"
  ON "task_owner_confirmation_request"("task_id", "requested_at");

CREATE TABLE IF NOT EXISTS "task_owner_decision" (
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "request_id" uuid,
  "decision" "task_owner_decision_value" NOT NULL,
  "note" text,
  "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by_type" "creator_type" NOT NULL,
  "decided_by_id" uuid NOT NULL,

  CONSTRAINT "task_owner_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_owner_decision_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- RESTRICT：请求是这条决定的主语，不能在它脚下消失（整个任务删掉时，上面那条 CASCADE 会把决定一并
  -- 带走，所以这不会挡住删任务）。
  CONSTRAINT "task_owner_decision_request_fkey"
    FOREIGN KEY ("request_id", "task_id")
    REFERENCES "task_owner_confirmation_request"("id", "task_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- 只有账户所有者本人。
  CONSTRAINT "task_owner_decision_by_owner" CHECK (
    "decided_by_type" = 'USER' AND "decided_by_id" = "owner_id"
  ),
  -- 退回必须说清楚缺什么，并且必须答的是某一次运行的汇报：那次运行所在的会话就是理由投进去的地方。
  CONSTRAINT "task_owner_decision_send_back_shape" CHECK (
    "decision" <> 'SEND_BACK' OR (
      "note" IS NOT NULL AND length(btrim("note")) > 0
      AND "request_id" IS NOT NULL
    )
  ),
  CONSTRAINT "task_owner_decision_note_nonblank" CHECK (
    "note" IS NULL OR length(btrim("note")) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "task_owner_decision_request_key"
  ON "task_owner_decision"("request_id");
CREATE INDEX IF NOT EXISTS "task_owner_decision_task_decided_idx"
  ON "task_owner_decision"("task_id", "decided_at");

CREATE OR REPLACE FUNCTION "task_done_canonical_writer_fence"() RETURNS trigger AS $$
DECLARE
  canonical boolean := false;
BEGIN
  IF NEW."completion_fence_revision" < OLD."completion_fence_revision" THEN
    RAISE EXCEPTION 'TASK_COMPLETION_FENCE_REVISION_DOWNGRADE'
      USING ERRCODE = 'P0001',
            DETAIL = 'a fenced task cannot be returned to a legacy writer cohort';
  END IF;
  IF NEW."completion_fence_revision" < 1
     OR NEW."status" <> 'DONE'::"task_status"
     OR OLD."status" = 'DONE'::"task_status" THEN
    RETURN NEW;
  END IF;

  IF NEW."verifies_task_id" IS NOT NULL AND NEW."verdict" IS NOT NULL THEN
    canonical := true;
  END IF;

  -- 0230's lane. The declaration is the only durable fact an EXECUTABLE task has, by the owner's
  -- decision; the comparison against it is made and discarded in `runnerApi.turnComplete`.
  IF NOT canonical
     AND NEW."completion_criterion" = 'EXECUTABLE'::"task_completion_criterion"
     AND NEW."acceptance_command" IS NOT NULL
     AND NEW."acceptance_expected_exit_code" IS NOT NULL THEN
    canonical := true;
  END IF;

  -- This migration's lane: one CONFIRM, on the evidence revision that is currently the latest.
  IF NOT canonical
     AND NEW."completion_criterion" = 'EVIDENCE_JUDGMENT'::"task_completion_criterion"
     AND EXISTS (
       SELECT 1
         FROM "task_evidence_decision" decided
         JOIN "task_completion_evidence" answered
           ON answered."id" = decided."evidence_id"
          AND answered."task_id" = decided."task_id"
        WHERE decided."task_id" = NEW."id"
          AND decided."decision" = 'CONFIRM'::"task_evidence_decision_value"
          AND answered."revision" = (
            SELECT max(current_evidence."revision")
              FROM "task_completion_evidence" current_evidence
             WHERE current_evidence."task_id" = NEW."id")
     ) THEN
    canonical := true;
  END IF;

  -- 0267's lane: the account owner's newest decision about this task is a CONFIRM. Newest, not any:
  -- a SEND_BACK recorded after a CONFIRM is the owner's current word, and it says the task is open.
  IF NOT canonical
     AND NEW."completion_criterion" = 'OWNER_CONFIRMED'::"task_completion_criterion"
     AND (
       SELECT decided."decision"
         FROM "task_owner_decision" decided
        WHERE decided."task_id" = NEW."id"
        ORDER BY decided."decided_at" DESC, decided."id" DESC
        LIMIT 1
     ) = 'CONFIRM'::"task_owner_decision_value" THEN
    canonical := true;
  END IF;

  IF NOT canonical AND NEW."completion_policy" = 'ALL_CHILDREN_DONE'::"task_completion_policy"
     AND EXISTS (
       SELECT 1 FROM "task" child
        WHERE child."parent_task_id" = NEW."id" AND child."status" = 'DONE'::"task_status"
     )
     AND NOT EXISTS (
       SELECT 1 FROM "task" child
        WHERE child."parent_task_id" = NEW."id"
          AND child."status" NOT IN ('DONE'::"task_status", 'CANCELLED'::"task_status")
     ) THEN
    canonical := true;
  END IF;

  IF NOT canonical AND NEW."completion_policy" = 'VERIFICATION_PASSED'::"task_completion_policy"
     AND EXISTS (
       SELECT 1 FROM "task" verifier
        WHERE verifier."verifies_task_id" = NEW."id"
          AND verifier."verdict" = 'PASS'::"task_verdict"
          AND verifier."terminal_reason" IS NULL
          AND verifier."superseded_by_task_id" IS NULL
     ) THEN
    canonical := true;
  END IF;

  IF NOT canonical THEN
    RAISE EXCEPTION 'TASK_DONE_CANONICAL_FACT_REQUIRED'
      USING ERRCODE = 'P0001',
            DETAIL = 'status=DONE is a projection of the declared completion fact, not a writer input',
            HINT = 'let the declared acceptance command run, record a verification verdict, have an independent session confirm the current completion evidence, or have the account owner confirm the task in the app';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
