-- 0232 的回滚，按相反顺序。Prisma 不读这个文件（它只读 `migration.sql`），它在这里是为了让回滚是一份
-- 被审过的脚本。与 `migration.sql` 一样自带事务、一样可重跑。
--
-- 会丢什么：每一条任务的标准声明 —— 指向哪条标准，以及声明时那条标准的 revision。这两个事实无处重建
-- （key 本来就不落库），所以回滚之前先想清楚：退掉的是写这两列的代码，还是连同已经写下的声明。
--
-- 不会丢什么：`project_acceptance_criterion_definition` 一行不动。这条外键的方向是 task → criterion，
-- 撤掉引用不影响被引用的一侧。

BEGIN;

ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_criterion_definition_id_fkey";
DROP INDEX IF EXISTS "task_criterion_definition_id_idx";
ALTER TABLE "task"
  DROP COLUMN IF EXISTS "criterion_revision",
  DROP COLUMN IF EXISTS "criterion_definition_id";

COMMIT;
