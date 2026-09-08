-- 0245 —— 账号所有者「这套标准完整表达了我要的目标」这句话，落成一行。
--
-- `CONFIRM_ACCEPTANCE_CRITERIA` 从 T6 起就在授权表里被评为 HUMAN_ONLY，还有一条专属拒绝码
-- （`PROJECT_CRITERIA_CONFIRMATION_HUMAN_ONLY`），但**全仓零写入方**：这个名字只出现在授权表、
-- 拒绝文案和两条 spec 里。也就是说被评为「只有人能做」的那件事，人根本没有地方做。本迁移只补回
-- 那一行落点。
--
-- 这是事实，不是闸门
-- ==================
-- 这张表没有触发器、没有函数、不被任何 DONE 判定读。0189 那张
-- `project_acceptance_criteria_confirmation` 之所以被 0226 删掉，是因为它的唯一读者是 0189 的
-- DONE 闸（`CRITERIA_CONFIRMATION_REQUIRED`），而账号所有者 2026-09-03 在 0229 里明确拒绝了
-- 重建那道闸：「The DONE gate is not replaced. The owner was offered a narrower guard and chose
-- the other option」。本迁移**不**恢复那道闸，也不给它留位置：写下这一行之后，项目的 status 与
-- 之前一模一样，没有任何东西因此被允许或被拒绝。派生 DONE 是另一件事，要另外请所有者重议。
--
-- 也因此这不是 0226 那张表换个名字回来：0226 删掉的表、它的两个索引和那个 BEFORE UPDATE 守卫，
-- 一个都没有被重建，本文件里一个都没被点名。这是一张新的、没有读者也没有守卫的事实表。
--
-- 绑定在哪一版标准上
-- ==================
-- 确认必须是**对某一版标准集**的，否则改尺子的人可以让任何结论成立——这正是这条 HUMAN_ONLY 存在
-- 的理由。`criteria_digest` 用的是仓库里已经有的那一个拼法，`criteriaSemanticRevision`
-- （`src/apiserver/src/projects/project-acceptance.ts`）：每条标准取
-- `definitionId:revision:content_hash`，排序后拼接再 sha256。
--   * 顺序不参与。项目验收是合取，把一条往上挪不改变被陈述的命题——这也是
--     `ordinal` 被明写为「不进语义摘要」的原因。
--   * 改一条标准的正文，或改它的判定方法，都会让
--     `project_acceptance_definition_normalize` 推进 `revision` 并重算 `content_hash`，摘要因此
--     改变，旧确认立刻不再等于当前那一版。
--   * ABA：`revision` 只增不减，所以「改了又改回来」落不回原摘要；`definitionId` 是行自己的 id，
--     所以删掉再建一条同样文字的标准也落不回去。
--
-- `criteria_material` 存的是同一个向量的可读形态（每条一个对象，含 definitionId / revision /
-- contentHash），这样「它确认的是哪一版」可以直接从行上读出来，而不必回头重算一遍摘要——摘要只
-- 回答「是不是这一版」，材料回答「是哪一版」。
--
-- 只 INSERT，所以不加不可变触发器
-- ================================
-- 唯一的写入方是 `ProjectAcceptanceService.confirmStandardSet` 的一条 INSERT，它在
-- `common/db-write-inventory.ts` 里登记为 INSERT/1；没有任何代码路径 UPDATE 或 DELETE 这张表
-- （删项目时随外键 CASCADE 走）。守卫触发器会是这张表上的第二个对象，而这张表的全部机制就是
-- 「多一行」——0238 出于同一条理由也没有给它的决定表加触发器。
--
-- 每个项目可以有多行：确认是一个事件，标准改过之后再确认一次是**另一件事**，不是把前一件改写。
-- 读的时候取 `confirmed_at` 最新的一行与当前摘要比较，所以历史留着不影响判定。
--
-- 自带 BEGIN/COMMIT（与 0238–0244 同一条理由）：表和它的索引彼此没有意义。可重跑：两条都是
-- IF NOT EXISTS 形态。

BEGIN;

CREATE TABLE IF NOT EXISTS "project_standard_set_confirmation" (
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "criteria_digest" char(64) NOT NULL,
  "criteria_material" jsonb NOT NULL,
  "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_by_id" uuid NOT NULL,

  CONSTRAINT "project_standard_set_confirmation_pkey" PRIMARY KEY ("id"),
  -- 两列一起指过去，与本仓其它租户内子表同形：确认属于那个项目，也属于那个所有者。
  CONSTRAINT "project_standard_set_confirmation_project_fkey"
    FOREIGN KEY ("project_id", "owner_id") REFERENCES "project"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- 「谁确认的」是当时的事实，与旁边的 `task_evidence_decision.decided_by_id` 同形：不带外键，
  -- 账号被删之后这一行仍然成立。
  CONSTRAINT "project_standard_set_confirmation_digest_shape"
    CHECK ("criteria_digest" ~ '^[0-9a-f]{64}$'),
  -- 材料是一个数组：一份「每条标准一个对象」的向量，空数组是合法的（项目一条标准都没有）。
  CONSTRAINT "project_standard_set_confirmation_material_shape"
    CHECK (jsonb_typeof("criteria_material") = 'array')
);

-- 唯一的读：这个项目最近一次确认。
CREATE INDEX IF NOT EXISTS "project_standard_set_confirmation_recent_idx"
  ON "project_standard_set_confirmation"("project_id", "confirmed_at" DESC);

COMMIT;
