-- 0371 —— agent 声明 OWNER_CONFIRMED 时写明的 owner 专属理由（docs/task-completion-criteria.md
-- 「agent 声明 OWNER_CONFIRMED 要写明理由」）。
--
-- 量化报告（任务 34Z35uEB5SDTmJPgU1Hw5）：近 30 天被要求确认的 77 个任务全部由 agent 建，项目外抽样
-- 30 个里只有 2 个真正需要 owner。owner 定下的规则：带会话头的写入，结果是一个不在 Automatic 项目里的
-- OWNER_CONFIRMED 任务时，要从四个理由里选一个，可以再附一句说明；没带理由的整笔写入 409，指向
-- EVIDENCE_JUDGMENT。Automatic 项目照旧用 09-29 的规则（owner-confirmed-automatic-delegation.ts）。
--
-- 加了什么
-- ========
--   * 枚举 `owner_confirmation_reason`：DEPLOY（上线、部署、发版、改线上库）、IRREVERSIBLE（不可逆
--     操作，如 DROP、删数据）、OWNER_DEVICE_OR_ACCOUNT（owner 本人的设备、账号或密钥）、
--     OWNER_TRADE_OFF（只有 owner 能做的取舍）。
--   * `task.owner_confirmation_reason` 与 `task.owner_confirmation_reason_note`：理由和那一句说明。
--     task_get 原样读回。说明不能离开理由单独存在（CHECK）。
--
-- 不加的约束：「只有 OWNER_CONFIRMED 任务才带理由」不写成 CHECK。服务端在判据离开 OWNER_CONFIRMED
-- 的那次写入里把两列一起清掉；写成 CHECK 的话，任何一条改判据却没经过 TasksService.update 的路径都会
-- 变成 500，而这两列只是审计材料，不参与任何结案。
--
-- 向后兼容
-- ========
-- 两列都可空、没有默认值，加列只改目录；已有的行一行不动，读作「没有记理由」。旧 runner 不发这个字段，
-- 由服务端按规则拒绝并给出同样的提示，这是预期行为。

BEGIN;

CREATE TYPE "owner_confirmation_reason" AS ENUM (
  'DEPLOY',
  'IRREVERSIBLE',
  'OWNER_DEVICE_OR_ACCOUNT',
  'OWNER_TRADE_OFF'
);

ALTER TABLE "task"
  ADD COLUMN "owner_confirmation_reason" "owner_confirmation_reason",
  ADD COLUMN "owner_confirmation_reason_note" text,
  ADD CONSTRAINT "task_owner_confirmation_reason_note_needs_reason"
    CHECK ("owner_confirmation_reason_note" IS NULL OR "owner_confirmation_reason" IS NOT NULL);

COMMIT;
