-- 0238 —— 决定门：一个独立会话对某一版证据的判断，就是一行。
--
-- EVIDENCE_JUDGMENT 从 0228 起是「声明了但没有实现」的判据：证据还在提交、还在存，而**没有任何东西
-- 读它**。本迁移只补回那一行落点，不补别的。
--
-- 只加一张表，不加一列
-- ====================
-- 绑定用的三列在 `task_completion_evidence` 上早就有了：`revision`（第几版）、`evidence_digest`
-- （这一版的内容）、`criterion_revision`（当时那份 task 判据快照的摘要）。0181 还为它们建了
-- `task_completion_evidence_bound_fact_key`（`id, task_id, criterion_revision, evidence_digest`
-- 上的 UNIQUE），0228 删 judgment 机器时**没有**动它。所以决定行只要拿这四列做一条复合外键，
-- 「这条决定是对哪一版证据、按哪一份判据快照做的」就是**结构上**成立的，不是一句注释：
-- 换掉任何一个，外键就不成立。`task_completion_evidence` 一列都不用加，也一列都没加。
--
-- 为什么会话 id 不带外键
-- ======================
-- `deciding_session_id` 与旁边的 `task_completion_evidence.source_session_id` 完全同形：不可变的
-- 出处快照，没有外键。会话被删掉之后这条决定仍然成立——「谁答的」是当时的事实，不是一条现在还必须
-- 能解引用的边。真正让这个答案算数的是**独立性**，而独立性是「这个会话有没有参与过这件工作」，一条
-- 指向单行的外键回答不了它；它在门口按整个任务的会话历史查，拒绝码
-- `EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION`。
--
-- 每一版证据至多一条决定
-- ======================
-- `task_evidence_decision_evidence_key` 是 `(task_id, evidence_id)` 上的 UNIQUE。同一版证据被答
-- 第二次：内容相同是重放（返回原行），不同就是 409。**不是**再写一行——一版证据上并存两条互相矛盾
-- 的决定，正是门口那道 CAS（只能答当前最新 revision）要防的那种含混。
--
-- SEND_BACK 不写 task
-- ===================
-- 打回不改 `task` 的任何列。任务本来就是 OPEN，它继续 OPEN 等下一版证据——「继续干」这件事的全部
-- 表达就是**没有**状态写入，所以既没有第三个枚举值，本迁移也不碰 `task`。CONFIRM 同样不写
-- `task.status`：把这条决定变成 DONE 是下一步的事，不是这张表的事。0193/0230 的
-- `task_done_canonical_writer_fence` 一个字都没动，EVIDENCE_JUDGMENT 在它眼里仍然没有实现。
--
-- 明确不重建的东西
-- ================
-- 0228 删掉的投递管线—— request ledger、inbox item、device outbox、push、delivery worker ——一样
-- 都没有回来。这张表没有 status 列、没有生命周期、没有 supersede 边、没有触发器：一条决定就是一行，
-- 谁要谁去读。库里也没有任何新对象叫 `*judgment*`（`task-judgment-removal.pg.spec` 会按
-- `pg_class.relname ~ 'judgment'` 查这件事）。
--
-- 自带 BEGIN/COMMIT（与 0228–0237 同一条理由）：枚举、表、两个索引彼此没有意义。可重跑：
-- 每条都是 IF NOT EXISTS 形态。

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_evidence_decision_value') THEN
    CREATE TYPE "task_evidence_decision_value" AS ENUM ('CONFIRM', 'SEND_BACK');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "task_evidence_decision" (
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "evidence_id" uuid NOT NULL,
  "criterion_revision" char(64) NOT NULL,
  "evidence_digest" char(64) NOT NULL,
  "decision" "task_evidence_decision_value" NOT NULL,
  "note" text,
  "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by_type" "creator_type" NOT NULL,
  "decided_by_id" uuid NOT NULL,
  "deciding_session_id" uuid NOT NULL,

  CONSTRAINT "task_evidence_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_evidence_decision_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- 内容绑定。四列一起指过去，换任何一列都不成立。RESTRICT：证据行是这条决定的主语，不能在它脚下
  -- 消失（task 整个删掉时，上面那条 CASCADE 会先把决定带走，所以这不会挡住删任务）。
  CONSTRAINT "task_evidence_decision_evidence_fact_fkey"
    FOREIGN KEY ("evidence_id", "task_id", "criterion_revision", "evidence_digest")
    REFERENCES "task_completion_evidence"("id", "task_id", "criterion_revision", "evidence_digest")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_evidence_decision_evidence_key" UNIQUE ("task_id", "evidence_id"),
  CONSTRAINT "task_evidence_decision_digest_shape"
    CHECK ("criterion_revision" ~ '^[0-9a-f]{64}$' AND "evidence_digest" ~ '^[0-9a-f]{64}$'),
  -- 打回必须说清楚下一版要拿出什么。CONFIRM 可以有注记，也可以没有；两者都不接受只有空白的注记。
  CONSTRAINT "task_evidence_decision_send_back_note" CHECK (
    "decision" <> 'SEND_BACK' OR ("note" IS NOT NULL AND length(btrim("note")) > 0)
  ),
  CONSTRAINT "task_evidence_decision_note_nonblank" CHECK (
    "note" IS NULL OR length(btrim("note")) > 0
  )
);

CREATE INDEX IF NOT EXISTS "task_evidence_decision_task_decided_idx"
  ON "task_evidence_decision"("task_id", "decided_at");

-- 外键自己的查找索引，以及「这个会话答过哪些」这个读。
CREATE INDEX IF NOT EXISTS "task_evidence_decision_session_idx"
  ON "task_evidence_decision"("deciding_session_id");

COMMIT;
