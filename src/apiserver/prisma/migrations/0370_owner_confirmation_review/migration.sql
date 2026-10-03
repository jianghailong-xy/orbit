-- 0370 —— OWNER_CONFIRMED 确认卡的「先审后呈」（docs/owner-confirmation-review-contract.md §3）。
--
-- 执行会话声明完成并停下时，`runnerApi.turnComplete` 记下确认请求；从这一版起，同一个事务里还把请求
-- 交给审查方：项目里是项目的协调会话，项目外是派活的会话（契约 §1）。审查方先审，审查期间卡片照常
-- 显示、按钮照常能按，只是不计入 needs-you；审查方交回一份署名的结构化记录，或者把请求退回执行会话。
-- 能按确认的仍然只有 owner。
--
-- 加了什么
-- ========
--   * `task_owner_confirmation_review`：一份请求至多一行。记审查方是谁（在请求那一刻定下，之后不跟着
--     项目换人）、审查窗口（`window_seconds`、`due_at`）和那一次投递（`delivery` 只从 PENDING 变一次）。
--     `abandoned_at` 是审查方读过、停下、又没有东西会叫醒它的那一刻（§4 T5）；`reviewer_ended_at` 是
--     下面的触发器写的。
--   * `task_owner_confirmation_review_record`：审查方交回的东西，三种：REVIEW、RETURN、PROBLEMS，每种
--     每份请求至多一条。只插入，不更新。
--   * `task_owner_confirmation_request.branch_sha`、`session.branch_sha`：runner 报上来的分支顶端提交。
--     前者是请求那一刻的，审查所绑提交号的参照；后者跟着上报移动，「已过期」读它（§4 T1、T3）。
--   * `task_owner_decision` 的三列：决定所指的那份 REVIEW 记录、决定那一刻的审查状态、owner 的逐条答案
--     （§7 Q4）。
--   * 触发器 `task_owner_confirmation_review_reviewer_ended`：审查方会话结束的那条语句里，给它还没交
--     REVIEW 或 RETURN 的审查行写上 `reviewer_ended_at`。
--
-- 为什么「审查方已结束」是一个写下的事实
-- ====================================
-- 状态在读的时候算（§4），时钟只在读里比一次 `now >= due_at`，不加任何定时任务。但「审查方已结束」
-- 不能在读的时候看会话的当前状态：审查方因失败停下、后来被自动重试或被人叫醒，「未经审查」就会变回
-- 「审查中」，从 needs-you 里消失。所以它写成只增不减的一列。`AFTER UPDATE OF` 的列和 `WHEN` 条件与
-- 0350 的 `session_request_recipient_ended` 逐字相同，包括它对自动重试的处理：已经排上重试的失败不算
-- 结束，重试放弃时才算。另写一个新函数，不改 0350 的函数。
--
-- 锁序
-- ====
-- 两张新表都是子行（rank 60）。审查行在 turnComplete 的事务里写，那时执行会话的 Session 行（rank 30）
-- 已经锁着，它的两条外键对请求行和任务行（rank 50）取 FOR KEY SHARE，不取别的。触发器在结束会话的那条
-- UPDATE 里执行：那时已经持有那个会话的行，它只更新以该会话为审查方的审查行——rank 30，然后 60。
-- `reviewer_session_id` 不带外键，理由与 0267 的 `session_id` 相同：出处快照，会话被清理后仍然成立；
-- 带外键的话，写审查行要对审查方的会话行取 FOR KEY SHARE，而这个事务锁着的是另一个会话。
--
-- 向后兼容
-- ========
-- 只有表、列、枚举和这一个触发器：不改 DONE fence，不写任何 DML。已有的请求和决定一行都不动：它们没有
-- 审查行，读作「没有审查方」。新列全部可空、没有默认值，加列只改目录。触发器的 WHEN 对不让会话结束的
-- UPDATE 都为假，什么也不执行。

BEGIN;

CREATE TYPE "owner_confirmation_reviewer_kind" AS ENUM ('PROJECT_COORDINATOR', 'TASK_CREATOR');
CREATE TYPE "owner_confirmation_review_delivery" AS ENUM ('PENDING', 'DELIVERED', 'REFUSED');
CREATE TYPE "owner_confirmation_review_record_kind" AS ENUM ('REVIEW', 'RETURN', 'PROBLEMS');

ALTER TABLE "task_owner_confirmation_request" ADD COLUMN "branch_sha" CHAR(40);
ALTER TABLE "session" ADD COLUMN "branch_sha" CHAR(40);

CREATE TABLE "task_owner_confirmation_review" (
  "id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "reviewer_kind" "owner_confirmation_reviewer_kind" NOT NULL,
  -- 出处快照，不带外键（见上面「锁序」）。
  "reviewer_session_id" uuid,
  -- 请求那一刻任务所在的项目，快照。
  "project_id" uuid,
  "window_seconds" integer NOT NULL,
  "due_at" TIMESTAMP(3) NOT NULL,
  "delivery" "owner_confirmation_review_delivery" NOT NULL DEFAULT 'PENDING',
  "delivery_refusal" text,
  "delivery_turn_client_id" text,
  "delivered_at" TIMESTAMP(3),
  "abandoned_at" TIMESTAMP(3),
  "reviewer_ended_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_owner_confirmation_review_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_owner_confirmation_review_request_fkey"
    FOREIGN KEY ("request_id", "task_id")
    REFERENCES "task_owner_confirmation_request"("id", "task_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_window" CHECK ("window_seconds" > 0),
  CONSTRAINT "task_owner_confirmation_review_refused_has_code"
    CHECK ("delivery" <> 'REFUSED' OR "delivery_refusal" IS NOT NULL),
  CONSTRAINT "task_owner_confirmation_review_delivered_has_turn"
    CHECK ("delivery" <> 'DELIVERED' OR ("delivery_turn_client_id" IS NOT NULL AND "delivered_at" IS NOT NULL))
);

-- 一份请求至多一行（§2 D4）。
CREATE UNIQUE INDEX "task_owner_confirmation_review_request_key"
  ON "task_owner_confirmation_review"("request_id");
-- 记录行的复合外键指向这一对。
CREATE UNIQUE INDEX "task_owner_confirmation_review_id_request_key"
  ON "task_owner_confirmation_review"("id", "request_id");
-- D5 与 T5 按审查方会话找行。
CREATE INDEX "task_owner_confirmation_review_reviewer_idx"
  ON "task_owner_confirmation_review"("reviewer_session_id", "delivery");

CREATE TABLE "task_owner_confirmation_review_record" (
  "id" uuid NOT NULL,
  "review_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "kind" "owner_confirmation_review_record_kind" NOT NULL,
  "reviewed_sha" CHAR(40),
  -- REVIEW 必填。
  "judgment" text,
  -- RETURN、PROBLEMS 必填。
  "reason" text,
  -- REVIEW：四类条目；RETURN、PROBLEMS：{ problems }。
  "body" jsonb NOT NULL,
  -- 交回记录的会话（即审查方）和那时正在进行的一轮。快照。
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  -- RETURN 专用：退回那一轮的键 confirmation-return:v1:<id>，由记录 id 派生，写记录时就知道。
  "return_client_turn_id" text,
  -- 拿到任务行锁之后读的 clock_timestamp()，与 0267 的 decided_at 同理。
  "recorded_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "task_owner_confirmation_review_record_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_owner_confirmation_review_record_review_fkey"
    FOREIGN KEY ("review_id", "request_id")
    REFERENCES "task_owner_confirmation_review"("id", "request_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_record_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_owner_confirmation_review_record_shape" CHECK (
    ("kind" = 'REVIEW' AND "judgment" IS NOT NULL AND "reason" IS NULL AND "return_client_turn_id" IS NULL)
    OR ("kind" = 'RETURN' AND "reason" IS NOT NULL AND "judgment" IS NULL AND "return_client_turn_id" IS NOT NULL)
    OR ("kind" = 'PROBLEMS' AND "reason" IS NOT NULL AND "judgment" IS NULL AND "return_client_turn_id" IS NULL)
  )
);

-- 每份请求 REVIEW、RETURN、PROBLEMS 各至多一条。
CREATE UNIQUE INDEX "task_owner_confirmation_review_record_kind_key"
  ON "task_owner_confirmation_review_record"("review_id", "kind");

-- 决定所指的那份 REVIEW 记录、决定那一刻的审查状态、owner 的逐条答案（§7 Q4）。CHECK
-- `task_owner_decision_by_owner` 与 `task_owner_decision_send_back_shape` 不改。RESTRICT 与 0267 的
-- `task_owner_decision_request_fkey` 是同一种情形：删任务时决定行和记录行都随任务 CASCADE 一起删掉。
ALTER TABLE "task_owner_decision"
  ADD COLUMN "review_record_id" uuid,
  ADD COLUMN "review_state" text,
  ADD COLUMN "answers" jsonb,
  ADD CONSTRAINT "task_owner_decision_review_record_fkey"
    FOREIGN KEY ("review_record_id") REFERENCES "task_owner_confirmation_review_record"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "task_owner_decision_review_state_chk" CHECK (
    "review_state" IS NULL
    OR "review_state" IN ('NONE', 'UNDER_REVIEW', 'REVIEWED', 'NOT_REVIEWED', 'OUTDATED')
  );

-- 审查方结束的那一刻。`WHEN` 与 0350 的 `session_request_recipient_ended` 逐字相同。
CREATE OR REPLACE FUNCTION "task_owner_confirmation_review_reviewer_ended"() RETURNS trigger AS $$
BEGIN
  UPDATE "task_owner_confirmation_review"
     SET "reviewer_ended_at" = CURRENT_TIMESTAMP
   WHERE "reviewer_session_id" = NEW."id"
     AND "reviewer_ended_at" IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM "task_owner_confirmation_review_record" record
        WHERE record."review_id" = "task_owner_confirmation_review"."id"
          AND record."kind" IN ('REVIEW', 'RETURN')
     );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_owner_confirmation_review_reviewer_ended"
  AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "completed_at", "archived_at", "deleted_at"
  ON "session"
  FOR EACH ROW
  WHEN (
    NEW."deleted_at" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
    OR NEW."archived_at" IS NOT NULL
    OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
    OR (NEW."status" = 'FAILED' AND NEW."retry_at" IS NULL
        AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))
    OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
  )
  EXECUTE FUNCTION "task_owner_confirmation_review_reviewer_ended"();

COMMIT;
