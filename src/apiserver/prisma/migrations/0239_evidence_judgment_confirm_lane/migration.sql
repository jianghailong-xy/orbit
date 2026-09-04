-- 0239 —— 第三格接上：一条 CONFIRM 决定行成为 DONE 的派生事实。
--
-- 0238 把决定门补了回来，但明确没接到状态上：CONFIRM 只是一行，`task_done_canonical_writer_fence`
-- 眼里 EVIDENCE_JUDGMENT 仍然「声明了但没有实现」，于是任何由它派生的 DONE 会当场
-- TASK_DONE_CANONICAL_FACT_REQUIRED，实现变成死码。0230 恢复 EXECUTABLE 判定时踩的就是这个坑
-- （「只改应用层」是错的），所以本迁移只做那一件事：给这道闸补上第三条 lane。
--
-- 这条 lane 能指着一行真数据
-- ==========================
-- EXECUTABLE 那条 lane 只能查「声明还在」——按所有者的决定，比较完什么都不留，没有行可查。
-- EVIDENCE_JUDGMENT 不一样：判据的全部内容就是**一个没做过这件工作的会话**对**某一版证据**的
-- CONFIRM，而 0238 把它存成了一行。所以这条 lane 回到了 0193 原本的形态——去查一行事实，而不是
-- 查一句声明：`task_evidence_decision` 里存在一条 CONFIRM，且它答的那一版正是这个任务当前最新的
-- 那一版。应用层 `evaluateTaskCompletion` 的 `case 'EVIDENCE_JUDGMENT'` 判的是同一个谓词，这里
-- 是数据库自己重新算一遍，不是复述。
--
-- 「最新那一版」是谓词的一部分，不是细节：证据是追加的，答的是第 N 版而任务已经到了第 N+1 版时，
-- 那条 CONFIRM 回答的是没人还在问的问题。门口那道 CAS 已经拒绝写下这种决定，这里再算一次，是因为
-- 闸门必须能独立回答「凭什么是 DONE」，而不是相信写它的那条路径当时算对了。
--
-- 独立性不在这条 lane 里
-- ======================
-- 「决定者没做过这件工作」是门口的检查（`EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION`），
-- 这里刻意不重做：它要看的是这个任务的全部会话历史与证据作者，`deciding_session_id` 是一份不带
-- 外键的出处快照（会话删了决定仍然成立），闸门里再查一遍只会把「会话已被清理」变成「这行 DONE
-- 不再合法」。闸门要的是**这条决定存在且答的是当前那一版**，独立性由写下它的那道门负责。
--
-- 明确没有做的事
-- ==============
-- 不建表、不加列、不加索引、不加触发器、不加枚举，也没有任何 DML：`git diff --stat` 对 0238 只有
-- 这一个文件，里面只有一条 CREATE OR REPLACE FUNCTION。SEND_BACK 依旧什么都不写——任务继续 OPEN
-- 等下一版证据，「继续干」的全部表达仍然是**没有**状态写入。0228 删掉的投递管线一样都没有回来。
--
-- 这是 CREATE OR REPLACE，所以 0228 与 0230 写下的每一条 lane 都必须在这里逐字重述：漏掉一条就是
-- 静默把它撤销（`task-judgment-data-preserved.spec` 正是按这个逐行对账的）。随 lane 改变的只有
-- HINT：它原本告诉读者 EVIDENCE_JUDGMENT 没有实现，从本迁移起它有了。

BEGIN;

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
            HINT = 'let the declared acceptance command run, record a verification verdict, or have an independent session confirm the current completion evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
