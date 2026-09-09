-- 0249 —— 账号所有者对一条「削弱标准」提案的答复，落成一行。
--
-- 0195 建的那台两阶段机器只有前半截：`project_ratified_action_intent` 收得下提案，
-- `project_ratified_action_commit` 表达「被 commit 了」，但**没有任何行说一条提案被驳回过**。
-- 提案表本身也答不了：它没有 status 列，而且 `project_ratified_action_intent_immutable`
-- （0195，BEFORE UPDATE OR DELETE）对任何 UPDATE 一律 RAISE，所以
-- `PENDING → APPROVED/REJECTED` 这个状态机在那张表上根本写不出来。
--
-- 后果是具体的，不是理论上的：一条被驳回的削弱提案，它的 `commit_token` 永远有效，
-- 「待决」永远成立，所有者面前的卡片永远不消失。0249 补的就是那个落点。
--
-- 「已 settled」是一次查询，两种结局同一个谓词
-- ==========================================
-- 主键就是 `intent_id`：一条提案至多一个答复，重复决定由数据库挡掉，而不是靠服务端先查后写
-- （那中间有窗口）。APPROVE 和 REJECT 写的是同一张表的同一个主键，所以
-- 「这条提案还待决吗」= 「这张表里有没有它的行」——一条 SELECT，不需要把两种结局分开问。
--
-- 为什么记 seal 而不是 contract_digest
-- ====================================
-- 提案行绑的是 `contract_digest`（0195 的 BEFORE INSERT 触发器要求它是项目当前的那一个），
-- 而那个摘要覆盖的是整份完成契约——改一次 `max_concurrent_tasks` 就会让所有者面前的卡片作废，
-- 且它不说明台面上是哪一版标准。决定要绑的是**标准集**，所以这里记的是 seal：
-- `criteriaSemanticRevision`（`src/apiserver/src/projects/project-acceptance.ts`），每条标准取
-- `definitionId:revision:content_hash`，排序后拼接再 sha256——与 0245 的 `criteria_digest`
-- 同一个拼法，不是第二种。
--
--   * `base_seal`：答复时台面上的那一版。它同时是提案自己 `action.baseline.seal` 里记的那一版
--     ——两者必须相等才允许决定，否则应用一条对着旧尺子写成的提案会把中间那次加严悄悄撤回。
--   * `resulting_seal`：APPROVE 之后重新读回来的那一版；REJECT 时等于 `base_seal`。
--     **读回来，不在 TS 里算**：`content_hash` 是 BEFORE 触发器
--     （`project_acceptance_definition_normalize`）从 (text, verification_method) 推出来的，
--     应用层自己算的那个 hash 只 hash 正文，两者不同口径。
--
-- 只 INSERT，所以不加不可变触发器
-- ================================
-- 与 0245、0238 同一条理由：唯一写入方是 `ProjectsService.decideCriteriaChange` 的一条 INSERT，
-- 没有任何代码路径 UPDATE 或 DELETE 这张表（删项目/删提案时随外键 CASCADE 走）。守卫触发器会是
-- 这张表上的第二个对象，而这张表的全部机制就是「多一行，且至多一行」——那一条已经由主键表达了。
--
-- 不是 0217 那条提案通道回来了
-- ============================
-- 0217 建、0223 删的是 `project_criteria_proposal` 及其六个索引和九个函数。本文件既不建那张表、
-- 也不建任何 `project_criteria_proposal_*` 对象，一个都没被点名；它复用的是 0195 那张一直在的
-- intent 表，补的是它从来没有的答复行。同理，前缀也刻意不是 `project_acceptance_`：那个前缀上挂着
-- 三处逐列 deepEqual 和多处关系/触发器穷举普查。
--
-- 自带 BEGIN/COMMIT（与 0238–0246 同一条理由）：表和它的索引彼此没有意义。可重跑：两条都是
-- IF NOT EXISTS 形态。

BEGIN;

CREATE TABLE IF NOT EXISTS "project_criteria_decision" (
  -- 主键即提案：一条提案至多一个答复。重复 APPROVE 由这里挡掉，而不是靠先查后写。
  "intent_id" uuid PRIMARY KEY
    REFERENCES "project_ratified_action_intent"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "owner_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "decision" text NOT NULL CHECK ("decision" IN ('APPROVE','REJECT')),
  -- 「谁答的」是当时的事实，与旁边的 `project_standard_set_confirmation.confirmed_by_id`、
  -- `task_evidence_decision.decided_by_id` 同形：不带外键，账号被删之后这一行仍然成立。
  "decided_by_id" uuid NOT NULL,
  "base_seal" char(64) NOT NULL CHECK ("base_seal" ~ '^[0-9a-f]{64}$'),
  "resulting_seal" char(64) NOT NULL CHECK ("resulting_seal" ~ '^[0-9a-f]{64}$'),
  -- 所有者写给后来读这一行的人的话。没有话可说是常态，所以可空。
  "note" text,
  "decided_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- REJECT 什么都没应用，所以它的结果就是它的起点。写成约束而不是写在注释里：这是
  -- 「REFUSE 只结算 intent，不碰标准」在数据库这一侧的那半句。
  CONSTRAINT "project_criteria_decision_reject_keeps_the_seal"
    CHECK ("decision" <> 'REJECT' OR "resulting_seal" = "base_seal")
);

-- 唯一的列表读：这个项目答过的决定，最近的在前。
CREATE INDEX IF NOT EXISTS "project_criteria_decision_recent_idx"
  ON "project_criteria_decision"("project_id", "decided_at" DESC);

COMMIT;
