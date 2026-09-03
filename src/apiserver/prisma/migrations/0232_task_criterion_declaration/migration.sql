-- T1 —— 把「这份工作服务哪一条验收标准」从一个名字变成一条关系。
--
-- 今天 `criterionKey` 只是 `CreateTaskDto` 上的一个字段（src/apiserver/src/tasks/dto.ts），它的注释
-- 自己写着 "nothing is written from it"：judgment 会话开任务时必须报出一个 key，服务端拿它对着项目
-- 当前的标准列表比一次，然后**丢掉**。于是"这项工作是为了哪条标准"这句话，在库里一个字都没有。本迁移
-- 给它一个落点，且**只**给落点：不装闸门、不改任何既有列的语义、不动 criterion 上那四个接线字段
-- （`completion_criterion` / `acceptance_command` / `acceptance_expected_exit_code` / `evidence_task_id`）。
--
-- 两列，一起加，各自答一个不同的问题
-- ==================================
--   * `criterion_definition_id` —— **活关系**。指向 `project_acceptance_criterion_definition` 的稳定
--     id，而不是 key 字符串。key 是 `contentHash.slice(0,32)`（src/apiserver/src/projects/project-acceptance.ts），
--     所以改一条标准的措辞就会换掉它的 key：存字符串等于每次编辑都悄悄把这条边指向空气。存 id 则跟着
--     标准一路走。
--   * `criterion_revision` —— **快照**。声明发生的那一刻这条标准的 `revision`。它不跟着标准走，这正是
--     它的用处：后来的读者才能分辨"按今天的措辞报的工"和"按早已改过的措辞报的工"。
--
-- 这不是新发明：`task_completion_evidence` 已经是同一对东西（活的 task 关系 + `criterion_revision`
-- 快照），本迁移只是把同一种记法用在声明这一侧。
--
-- 为什么是 ON DELETE SET NULL
-- ===========================
-- 删掉一条标准之后，两列会读作 `criterion_definition_id IS NULL AND criterion_revision IS NOT NULL`
-- —— 这一个谓词就是「这份工作声明过一条标准，而那条标准已经不在了」的全部，不需要额外的标志位，也就
-- 不存在"标志位和删除没跟上"这种状态。人手清空两列则读作两列都为 NULL，与它天然可分（判据是被指向的行
-- 还在不在，不是一个布尔）。
--
-- 不用 RESTRICT：`task.project_id` 是 RESTRICT，因为项目是这些任务**存在的理由**，不能在它们脚下消失；
-- 一条标准是项目的一句话，账号所有者随时可以改写或删掉它，而不该因此发现某些工作删不掉了。
-- 不用 CASCADE：删一条标准去删掉为它开的工作，是把"这句话不再是我要的"读成"这些活白干了"。
--
-- 索引
-- ====
-- `task_criterion_definition_id_idx` 两头都要：正向是"哪些工作服务这条标准"这个读；反向是外键自己的
-- 查找索引 —— 没有它，每次删一条标准都要全表扫 `task` 去找 SET NULL 该落在哪些行上。这里**不**建成
-- 部分索引（0108/0110/0150 那种 `WHERE ... IS NOT NULL`）：那三处的谓词是为了把六位数条无来源的任务
-- 挡在索引外，而这一列刚落地时全表都是 NULL，收益是负的；等它写满了再谈。
--
-- 存量数据与回填
-- ==============
-- 两列都可空、都没有默认值，所以既有行一行都不被碰（PG 11+ 的 ADD COLUMN 在没有 volatile 默认值时只
-- 改目录）。历史任务读作"没有声明过标准"，那是真的：它们创建时这个声明确实无处可写。**没有回填**，
-- 也不可能有——已经被丢掉的 key 无法从任何地方重建。
--
-- 本迁移不做的事
-- ==============
--   * 不加 DONE 闸。0229 明写 "The DONE gate is not replaced"，0223 明写被删的保护是 "removed, not
--     relocated"；本迁移只写数据。
--   * 不加"写一次不可改"的触发器。没人要求，且上面那条 SET NULL 与人手清空的判据已经不依赖它。
--   * 不加中间表。证据是一对多（一条标准 ← 多份工作），task 上两列就够；多对多是还没有人提出的问题。
--
-- 自带 BEGIN/COMMIT（与 0228–0231 同一条理由）：三条语句彼此没有意义 —— 一个没有索引的外键会让每次
-- 标准删除退化成全表扫，一个没有外键的列只是个 uuid。可重跑：三条都是 IF NOT EXISTS 形态。

BEGIN;

ALTER TABLE "task"
  ADD COLUMN IF NOT EXISTS "criterion_definition_id" UUID,
  ADD COLUMN IF NOT EXISTS "criterion_revision" INTEGER;

CREATE INDEX IF NOT EXISTS "task_criterion_definition_id_idx"
  ON "task"("criterion_definition_id");

ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_criterion_definition_id_fkey";
ALTER TABLE "task" ADD CONSTRAINT "task_criterion_definition_id_fkey"
  FOREIGN KEY ("criterion_definition_id")
  REFERENCES "project_acceptance_criterion_definition"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
