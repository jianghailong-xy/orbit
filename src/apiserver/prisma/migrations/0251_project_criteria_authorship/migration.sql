-- 0251 —— 「这一版标准是谁写的」，落成一行。
--
-- 项目验收第 6 条要求「结算时，任何一条由其证据产出会话自己撰写的标准不计入」。勘察发现这句话读的
-- 那个事实**库里根本不存在**：`project_acceptance_criterion_definition` 只记标准是什么、改到第几版，
-- 不记是谁写的。本迁移只补那一行落点。
--
-- 为什么是一张新表，不是那张表上的一列
-- ====================================
-- 那张表的**列清单**被三处逐列 deepEqual 普查钉死：
--   * src/apiserver/src/projects/criteria-confirmation-removal.pg.spec.ts:165
--   * src/apiserver/src/tasks/failure-continuation-removal.pg.spec.ts:500
--   * src/apiserver/src/tasks/verification-subject-guard-removal.pg.spec.ts:240
-- 加一列会一次打红这三处。它们守的是「那面验收墙一列不多一列不少地穿过了每一轮删除」，而作者身份
-- 不是那面墙的一部分——它是关于**写入那一版的动作**的事实，不是关于**那句话**的事实。所以它是自己的
-- 一张表，前缀也不带 `project_acceptance_`：本文件 ALTER 不了、也没有点名任何 `project_acceptance_*`
-- 对象，那三处普查因此看不见它。
--
-- 每一版一行，不是每条标准一行
-- ============================
-- 主键是 `(definition_id, revision)`。标准被改写就是新的一版（`project_acceptance_definition_normalize`
-- 在 0234 里把 `revision` 推进），而改写它的**可能是另一个会话**——第 6 条问的正是「产出证据的那个
-- 会话有没有自己动过尺子」，所以每一版都要单独回答一次。一条标准被重排 ordinal 时 `revision` 不动，
-- 于是那次写入落回同一个主键：写入方是 `INSERT ... ON CONFLICT DO NOTHING`，重排因此**不改写原作者**，
-- 也不新增行。搬动一条标准的位置不是撰写它。
--
-- `authored_by_type` 为什么不能省
-- ===============================
-- 三个取值分别是三件不同的事：
--   * `AGENT` —— 写入时有 acting session，会话 id 记在 `authored_by_session_id` 上（runner 通道）；
--   * `USER`  —— 所有者通过 HTTP 通道自己写的，没有 acting session，会话为 NULL；
--   * `SYSTEM`—— 下面这次回填，「不知道是谁写的」。
-- 后两者的 `authored_by_session_id` 都是 NULL，所以光看会话列分不开它们；而把它们混成一行，职责分离闸
-- 就只有两种结局——把 274 条历史标准全部当成所有者写的放行，或者全部当成来路不明拒掉。两个都是错的。
-- CHECK 把「AGENT 必有会话、非 AGENT 必无会话」写死，免得以后出现一个没有会话的 AGENT 行——那种行对
-- 第 6 条毫无用处。
--
-- 存量回填的口径
-- ==============
-- 迁移当时每一条活着的标准，按它**当前那一版**补一行 `SYSTEM` / NULL。回填只在这些库里发生过的那一
-- 刻的历史行上发生，`ON CONFLICT DO NOTHING` 让它可重跑。
-- `authored_at` 取 `updated_at`（它是那一版被写下的时刻，`updated_at` 由同一个归一化触发器维护），
-- 显式按 UTC 解释：那一列是 `timestamp without time zone`，存的是 UTC，不写 `AT TIME ZONE 'UTC'` 的话
-- 结果会随迁移执行时连接的 TimeZone 漂移。它是这张表上唯一一个**推断**出来的值，`SYSTEM` 已经把
-- 「作者未知」说清楚了，时刻只是就近取的那条行自己的最后写入时间。
--
-- 不加不可变触发器，与 0245 同一条理由
-- ====================================
-- 唯一的写入方是 `ProjectsService.recordCriterionAuthorship` 的一条 INSERT，登记在
-- `common/db-write-inventory.ts`；没有任何代码路径 UPDATE 或 DELETE 这张表（删项目时随外键 CASCADE
-- 走）。守卫触发器会是这张表上的第一个也是唯一一个触发器，而这张表的全部机制就是「多一行」。
--
-- 不给 `definition_id` 加外键：标准被删掉之后，「它当年是谁写的」这句话仍然成立，与旁边
-- `project_standard_set_confirmation.confirmed_by_id` 同形。读的一侧永远是从活着的标准出发按
-- `(definition_id, revision)` 找过来的，所以留下的行谁也读不到。
--
-- 自带 BEGIN/COMMIT（与 0238–0245 同一条理由）：表、索引和回填彼此没有意义。可重跑：建表是
-- IF NOT EXISTS，回填是 ON CONFLICT DO NOTHING。

BEGIN;

CREATE TABLE IF NOT EXISTS "project_criteria_authorship" (
  "definition_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "project_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "authored_by_session_id" uuid,
  "authored_by_type" text NOT NULL,
  "authored_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- 每一版一行。
  CONSTRAINT "project_criteria_authorship_pkey" PRIMARY KEY ("definition_id", "revision"),
  -- 两列一起指过去，与本仓其它租户内子表同形：这一行属于那个项目，也属于那个所有者。
  CONSTRAINT "project_criteria_authorship_project_fkey"
    FOREIGN KEY ("project_id", "owner_id") REFERENCES "project"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_criteria_authorship_type_chk"
    CHECK ("authored_by_type" IN ('USER', 'AGENT', 'SYSTEM')),
  CONSTRAINT "project_criteria_authorship_session_shape"
    CHECK (("authored_by_type" = 'AGENT') = ("authored_by_session_id" IS NOT NULL))
);

-- 唯一的读：这个项目每一条标准的作者。
CREATE INDEX IF NOT EXISTS "project_criteria_authorship_project_idx"
  ON "project_criteria_authorship"("project_id");

-- 存量回填，口径见文件头。
INSERT INTO "project_criteria_authorship" (
  "definition_id", "revision", "project_id", "owner_id",
  "authored_by_session_id", "authored_by_type", "authored_at")
SELECT d."id", d."revision", d."project_id", p."owner_id",
       NULL, 'SYSTEM', d."updated_at" AT TIME ZONE 'UTC'
  FROM "project_acceptance_criterion_definition" d
  JOIN "project" p ON p."id" = d."project_id"
ON CONFLICT DO NOTHING;

COMMIT;
