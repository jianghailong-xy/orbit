-- 0295 —— OWNER_CONFIRMED 的卡片改由「这次 run 声明自己做完了」触发，而不是「run 停下来了」。
--
-- 0267 把请求记在「一次成功的回合结束」上（`runnerApi.turnComplete`），本意是「run 说完了它做了什么，
-- 请所有者确认」。实际发生的是：那条 run 往往还会自己继续——队列里排着后续消息、它自己起的后台作业还
-- 没结束、它自己排的唤醒还没到——卡片于是在 run 还在干活的时候就弹了出来，所有者点开看到的是一份中途
-- 汇报；而 agent 只是停下来**问你一个问题**的那一轮，同样会弹成「Confirm this task is done?」。
--
-- 现在只有 agent 的声明才会问。本迁移给「这次 run 说它做完了」一个落点
-- （`task_owner_confirmation_claim`），并让请求行记下它是被哪一声明换来的（`claim_id`）。
-- runner 侧的新工具 `task_request_confirmation`（CLI：`orbit task request-confirmation`）写声明；
-- 记请求的时机仍然是那一轮成功结束、且 run 真的停下来了（队列空、自己没有在飞的作业或子工作区、没有
-- 待到的唤醒），所以「声明完又自己接着干活」的 run，卡片要等它真正停下的那一轮才弹。
--
-- 为什么一声明一请求
-- ==================
-- `claim_id` 上一条唯一索引（`task_owner_confirmation_request_claim_key`）：一条声明至多换一张卡。
-- 于是 /turn-complete 里不需要比较时间戳，也不需要第二张状态表：「这条声明还没被消费」就是「没有请求
-- 指着它」。读完声明、写下请求，声明就用掉了；所有者退回之后 agent 又做完一次，必须重新声明，卡片才会
-- 再来。声明行本身也是审计材料：所有者问「这张卡是哪一声明换来的」，答案是一条能读的行。
--
-- 为什么没有兜底
-- ==============
-- 不声明的 run 不会得到卡片，这是有意的，不是漏做：
--   * OWNER_CONFIRMED 的契约本来就写着「没有 run 在等时，所有者从任务面板确认」，面板上的
--     Confirm done 一直在，任务也仍然停在 OPEN、在 Tasks 列表里可见；
--   * 「run 自己结束了」这件事在这类任务上并不存在：线上 OWNER_CONFIRMED 任务的会话全部以
--     `end_reason = task_done` 结束（或随运行失败 FAILED），也就是说 run 的结束是确认的结果，而不是
--     确认的前置。硬留一张「run 停下但没声明」的卡，就又把「agent 停下来在提问」这一类误报带回来了。
--
-- 声明来自任务自己的 run
-- ======================
-- 写它的门在应用层（`task-owner-confirmation.service.ts#claim`）：只有本任务自己的执行会话、且该会话
-- 此刻有一轮在飞时才收，会话头由 runner 协议带上；协调会话或别的会话声明一律拒绝。`turn_id` 记的是
-- 声明所在的那一轮，与请求行同一条理由没有外键（出处快照，会话被清理后仍然成立）。
--
-- claim_id 可以为 NULL
-- ====================
-- 本迁移之前记下的请求没有声明——它们是在旧规则下记的，那是一件已经发生的事实，不是一个待回填的值。
-- 新记下的请求一律带 claim_id。
--
-- 明确没有做的事
-- ==============
-- 不加触发器、不动 fence、不写任何 DML：新表是空的，已有的行一行都不改。

BEGIN;

CREATE TABLE IF NOT EXISTS "task_owner_confirmation_claim" (
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_owner_confirmation_claim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_owner_confirmation_claim_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 请求行的复合外键指向这一对。
CREATE UNIQUE INDEX IF NOT EXISTS "task_owner_confirmation_claim_id_task_key"
  ON "task_owner_confirmation_claim"("id", "task_id");
-- 一轮至多声明一次：工具被重试也不会写第二行。
CREATE UNIQUE INDEX IF NOT EXISTS "task_owner_confirmation_claim_turn_key"
  ON "task_owner_confirmation_claim"("session_id", "turn_id");
CREATE INDEX IF NOT EXISTS "task_owner_confirmation_claim_task_idx"
  ON "task_owner_confirmation_claim"("task_id", "claimed_at");

ALTER TABLE "task_owner_confirmation_request" ADD COLUMN IF NOT EXISTS "claim_id" uuid;

DO $$ BEGIN
  ALTER TABLE "task_owner_confirmation_request"
    ADD CONSTRAINT "task_owner_confirmation_request_claim_fkey"
      FOREIGN KEY ("claim_id", "task_id")
      REFERENCES "task_owner_confirmation_claim"("id", "task_id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 一声明至多一张卡。多行 NULL（旧规则下记的请求）不受影响：Postgres 的唯一索引不约束 NULL。
CREATE UNIQUE INDEX IF NOT EXISTS "task_owner_confirmation_request_claim_key"
  ON "task_owner_confirmation_request"("claim_id");

COMMENT ON TABLE "task_owner_confirmation_claim" IS
  'One time a run of an OWNER_CONFIRMED task declared its work finished — the agent''s own '
  'statement, written by task_request_confirmation from the task''s own execution session, and the '
  'only thing that asks the owner (0295). A claim that a task_owner_confirmation_request names is '
  'spent: one claim, one card.';

COMMENT ON COLUMN "task_owner_confirmation_request"."claim_id" IS
  'The declaration this question was asked from (0295). NULL means the request predates claims: it '
  'was recorded under 0267''s rule, when ending a turn successfully was enough to ask.';

COMMIT;
