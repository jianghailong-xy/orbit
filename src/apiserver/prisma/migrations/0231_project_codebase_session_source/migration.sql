-- S1 — ProjectCodebase 与 Session SOURCE 快照模型（`docs/project-source-contract.md` v1）。
--
-- 契约 §0 的问题：一条 session 的代码起点今天由 `setupWorktree`(src/runner-go/worktree.go:542) 读
-- workDir 的当前 HEAD 决定，于是 WHERE（在哪台机器上跑）隐式决定了 SOURCE（从哪份代码开始），而那条
-- 路径上每一个失败分支都**降级**到共享 checkout 而不是拒绝。本迁移落的是让 SOURCE 变成一次**被记录
-- 下来的解析结论**所需的全部数据结构，一个字节的行为改变都不带（写它们的代码是 S2–S8 的事）。
--
-- 三件事，加一条围栏：
--
--   1. `project_codebase` —— Project 到一条代码线的**可选**显式绑定（SR5：没有绑定的 Project 不产生
--      任何 Git 要求）。仓库身份是一对值 `(canonical_repo_url, root_commit_sha)`，因为路径在两台机器
--      上必然不同而身份必须跨机器可比（SR37）。
--   2. `session` 的十五列 SOURCE 快照 —— 意图（selector，create 冻结）与事实（pin，首次 claim 冻结）
--      分成两个**不相交**的集合，各有一个封条，所以"这一列现在还能不能写"永远只有一个答案（SR11）。
--   3. `task.pinned_revision` / `task.codeless` —— 显式基线（§4 P2）与 SR5 的逃生口。
--   4. `project_blocker_kind_chk` += `SOURCE_UNRESOLVED` —— 八个 SOURCE 拒绝码路由到同一个结论，
--      精确 `code` 与 `fixAction` 放 payload（SR50/SR51）。**一个写不进去的拒绝码，等于一次静默跳过
--      的派发。**
--
-- LEGACY 与既有数据（SR45，用例 S1.01/S1.02）
-- ==========================================
-- `source_state` 的**默认值就是** `'UNBOUND'`，因此历史行不需要回填：PG 11+ 对非 volatile 的
-- ADD COLUMN 默认值只写 `pg_attribute.attmissingval`，不重写堆（`codeless`/`source_required_contains`
-- 同理）。既有 session 在语句提交那一刻起就**全部**读作 `UNBOUND`，一行没被碰过 —— 这既避开了
-- `session` 上那次 3ms/行的全表 UPDATE，也让"分流判据是一列，不是一次推断"在存量数据上立刻为真。
--
-- 分流写成一列而不是"根据 task 有没有 project_id 推断"，是因为后者会在 Project 功能上线的那一刻改变
-- 一批既有 session 的行为。一个存下来的列不会。
--
-- 本迁移**不做**的事
-- ==================
--   * 不改任何既有列的语义。特别是 `session.base_sha`：它是会被 `resolveBaseSha` 治愈以服务 diff 展示
--     的展示值，而 `source_base_sha` 是不可变的事实。一个会自愈的列不能承载一个不可变的事实（SR13）。
--     两者的关系（SR14：worktree 建成的那一刻二者相等）是 runner 侧的时刻性质，不是行内可表达的约束，
--     由 `worktree_source_test.go` 断言。
--   * 不给 `session.source_codebase_id` 建外键。删掉一条绑定**不得**改写已冻结的快照（§3.2），这与
--     0120 对 `task_checkpoint.session_id` 的规则是同一条。
--   * 不写一行业务数据、不装任何会自己产生 SOURCE 结论的东西。
--   * 不约束 `DEPENDENCY_CLOSURE` 的 `source_required_contains` 必须非空。契约在"P4 的前置没有 accepted
--     checkpoint 时拒绝发生在 create 还是首次 claim"上留了口子（SR19 对 §6 T2/T4），在它被 S2/S3 关掉
--     之前，这里加约束就是在给一个合法写入方立一道关不掉的门。
--
-- 可重跑与回滚
-- ============
-- 文件自带 `BEGIN`/`COMMIT`（0130/0131/0134/0137 的同一条理由）：这一批对象彼此没有意义 —— 一张没有
-- 冻结守卫的快照表比没有更糟 —— 所以部分应用不是降级状态而是错误状态。每条语句都可重跑
-- （`IF NOT EXISTS` / `duplicate_object` 守卫 / `CREATE OR REPLACE` / 先按名 DROP TRIGGER），被中断后
-- 重试到达的状态与没被中断的一样。`down.sql` 按相反顺序反转，Prisma 不读它，它在那里是为了让回滚是一份
-- 被审过的脚本而不是凌晨三点临时写的。
--
-- 部署顺序（SR52）：本迁移必须**先于**任何会写 `SOURCE_UNRESOLVED` 的代码上线。理由与 0141/0142 相同 ——
-- kind 是只有新代码会写的值，旧副本不会因约束接受它而受损；旧副本读到它会落到 `UNKNOWN_FAILURE`，那是
-- fail-closed 且仍会把项目摆到人面前。
--
-- 锁序（`docs/postgres-lock-order.md`）：两个新触发器的 `takes` 都是空的 —— 它们只读自己那一行的
-- OLD/NEW，不碰第二个关系，因此一条等待边都不加（`TRIGGER_WRITE_SOURCES` 里如实登记）。`project_codebase`
-- 的两条外键只在**写这张表**时才取父行的 `FOR KEY SHARE`，而本迁移不带任何写它的代码路径，所以今天没有
-- 事务能把它排进一个环里；等 S2/S8 写它的时候，那条路径按既有规矩进锁序清单。唯一的新边是 project 删除
-- 要 CASCADE 掉这张表的子行，它排在整条链的末端，没有反向到达者。

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 0 · 两条租户围栏所需的复合唯一键。
--
-- `task` 已经有 `task_id_owner_id_key`，它的五张子表都靠 `(task_id, owner_id) -> (id, owner_id)` 这条
-- 复合外键使"子行不可能和父行在'这是谁的'上有分歧"成为数据库事实而不是服务层的约定。`project_codebase`
-- 同时指向 project 和 runner，所以两边各需要一把同形状的钥匙。都是极小的表，索引本身可忽略。
-- ---------------------------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "project_id_owner_id_key" ON "project" ("id", "owner_id");
CREATE UNIQUE INDEX IF NOT EXISTS "runner_id_owner_id_key" ON "runner" ("id", "owner_id");

-- ---------------------------------------------------------------------------------------------
-- 1 · `project_codebase` —— Project 到一条代码线的可选绑定。
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "project_codebase" (
  "id"                  UUID NOT NULL,
  "project_id"          UUID NOT NULL,
  -- 租户域，所有读按它过滤。下面那条复合外键让它不可能和 project 的 owner 不一致。
  "owner_id"            UUID NOT NULL,
  -- v1 恒为 'primary'。留列是为了让"一个 Task 一个主 codebase 的 MVP"不阻断多仓库扩展（取舍 1）：
  -- 第二条绑定在数据模型上**已经可表达**，只是 v1 的解析器只读 'primary'。
  "slot"                TEXT NOT NULL DEFAULT 'primary',

  -- 仓库身份的前一半：规范化后的远端 URL（§7.1）。规范化结果**只用于身份比较，从不用于 clone** ——
  -- clone 用的是用户写下的原值。下面的 CHECK 是"这里存的确实是规范化过的东西"的机械残留：一个把用户
  -- 原样 URL 塞进来的写入方会当场失败，而不是在两台机器解析出两个身份的那天才暴露。
  "canonical_repo_url"  TEXT NOT NULL,
  -- 后一半：该仓库第一个根提交的 SHA。NULL = 尚未观测到；首次成功解析可补写一次（那是**观测到的
  -- 事实**，不是猜测），此后不可变 —— 由下面的守卫触发器执行（SR37）。
  "root_commit_sha"     CHAR(40),

  -- 这条代码线从哪里来 / 往哪里去。两者都必须是全名 ref：短名 `main` 在 `refs/heads/main` 与
  -- `refs/tags/main` 同时存在时是二义的，而基线不能是二义的（SR9）。
  "upstream_ref"        TEXT NOT NULL,
  "integration_ref"     TEXT NOT NULL,

  -- 一个 ref 到 SHA 的解析**在哪里做才算数**。不是"哪台机器跑"——权威决定的是两台机器会不会解析出
  -- 同一个答案（SR40）。
  "ref_authority"       TEXT NOT NULL,
  "remote_name"         TEXT NOT NULL DEFAULT 'origin',
  -- SR10 唯一的例外，且它命名的是**权威**而不是执行位置。RESTRICT 而不是 SET NULL：清空它会让这一行
  -- 悄悄变成一个"以某台不确定的机器为准"的权威，而那正是本项目要消灭的东西；删机器之前得先改绑定。
  "authority_runner_id" UUID,

  -- 配置版本号，单调，**不接受来自请求体的值**（SR8）。一个可以由写入方自选的版本号，无法回答"这条
  -- session 冻结的是不是当时那份配置"。整个维护在下面的触发器里。
  "config_revision"     BIGINT NOT NULL DEFAULT 0,

  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_codebase_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "project_codebase_project_fkey"
    FOREIGN KEY ("project_id", "owner_id") REFERENCES "project" ("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_codebase_authority_runner_fkey"
    FOREIGN KEY ("authority_runner_id", "owner_id") REFERENCES "runner" ("id", "owner_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  -- slot 是唯一键的一半，所以空白 slot 会是一条悄悄绕开 SR7 的第二绑定。
  CONSTRAINT "project_codebase_slot_chk"
    CHECK (length("slot") BETWEEN 1 AND 32 AND "slot" = btrim("slot")),

  CONSTRAINT "project_codebase_ref_authority_chk"
    CHECK ("ref_authority" IN ('REMOTE', 'RUNNER_LOCAL')),

  -- SR9。全名 ref，且不含空白 —— git 自己也不接受，而这里接受就意味着一条永远解析不出来的基线可以
  -- 被写进配置，直到某次运行撞上它。
  CONSTRAINT "project_codebase_refs_chk"
    CHECK ("upstream_ref" ~ '^refs/[^[:space:]]+$' AND "integration_ref" ~ '^refs/[^[:space:]]+$'),

  -- SR31，写成**双条件**而不是单向蕴含。`REMOTE` 的行带着一个 runner id 不会有人读，但它会在有人把
  -- 权威改成 `RUNNER_LOCAL` 的那一刻被静默采纳 —— 一台谁也没有选过的机器就此成了权威。
  CONSTRAINT "project_codebase_authority_runner_chk"
    CHECK (("ref_authority" = 'RUNNER_LOCAL') = ("authority_runner_id" IS NOT NULL)),

  CONSTRAINT "project_codebase_remote_name_chk"
    CHECK (length("remote_name") BETWEEN 1 AND 100 AND "remote_name" = btrim("remote_name")),

  -- §7.1 的规范化残留：无首尾空白、无尾部 `/`、无尾部 `.git`、非空。
  CONSTRAINT "project_codebase_canonical_url_chk"
    CHECK ("canonical_repo_url" = btrim("canonical_repo_url")
           AND "canonical_repo_url" <> ''
           AND "canonical_repo_url" NOT LIKE '%/'
           AND "canonical_repo_url" NOT LIKE '%.git'),

  -- 全 40 位小写十六进制。缩写按构造就是二义的（它对着一个后来长出新对象的仓库解析，于是今天验证过
  -- 的值日后可以静默指向另一个 commit），而这一行的全部意义是事后可核对。
  CONSTRAINT "project_codebase_root_commit_sha_chk"
    CHECK ("root_commit_sha" IS NULL OR "root_commit_sha" ~ '^[0-9a-f]{40}$'),

  CONSTRAINT "project_codebase_config_revision_chk" CHECK ("config_revision" >= 0)
);

-- SR7：一个 Project 的一个 slot 只有一份绑定。
CREATE UNIQUE INDEX IF NOT EXISTS "project_codebase_project_slot_key"
  ON "project_codebase" ("project_id", "slot");

CREATE INDEX IF NOT EXISTS "project_codebase_owner_idx" ON "project_codebase" ("owner_id");

-- 两条外键的**引用侧**索引。Postgres 自动索引被引用列、从不索引引用列，所以没有它们，每次 project
-- 删除都要扫这张表找 CASCADE 的对象，每次 runner 删除都要扫它找 RESTRICT 的反例。
CREATE INDEX IF NOT EXISTS "project_codebase_project_idx" ON "project_codebase" ("project_id");
CREATE INDEX IF NOT EXISTS "project_codebase_authority_runner_idx"
  ON "project_codebase" ("authority_runner_id") WHERE "authority_runner_id" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 1.1 · `config_revision` 归数据库，身份写一次。
--
-- 一个触发器而不是两个，因为它们回答的是同一个问题："一次对这一行的写入意味着什么"。两个 BEFORE ROW
-- 触发器就要面对 PostgreSQL 按名字母序触发的顺序问题（0150 的 `..._advance_epoch` / `..._done_gate`
-- 正是被这一点定住了名字），而这里根本不需要有那个问题。
--
-- ELSE 分支把 NEW 钉回 OLD，而不是"不管它"：一个给这一列送值的写入方，无论送的是什么值、出于什么理由,
-- 都不能自己选版本号。这是 0150 给 `acceptance_epoch` 做的同一件事。
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_codebase_config_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."config_revision" := 0;
    RETURN NEW;
  END IF;

  -- 身份不可改写。换 project 或换 owner 的那一行不是"改了配置"，是另一条绑定。
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id" THEN
    RAISE EXCEPTION
      'CODEBASE_AUTHORITY_INVALID: project_codebase % is bound to project %; a binding is created and deleted, never re-pointed',
      OLD."id", OLD."project_id" USING ERRCODE = 'raise_exception';
  END IF;

  -- SR37：`root_commit_sha` 从 NULL 补写一次是**观测**，此后任何改写（包括清空）都是在声称这是另一个
  -- 仓库 —— 而已经按旧身份冻结过快照的 session 无从知道这件事。
  IF OLD."root_commit_sha" IS NOT NULL
     AND NEW."root_commit_sha" IS DISTINCT FROM OLD."root_commit_sha" THEN
    RAISE EXCEPTION
      'CODEBASE_AUTHORITY_INVALID: project_codebase % already observed root commit %; repository identity is written once',
      OLD."id", OLD."root_commit_sha" USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW."slot"                IS DISTINCT FROM OLD."slot"
     OR NEW."canonical_repo_url"  IS DISTINCT FROM OLD."canonical_repo_url"
     OR NEW."root_commit_sha"     IS DISTINCT FROM OLD."root_commit_sha"
     OR NEW."upstream_ref"        IS DISTINCT FROM OLD."upstream_ref"
     OR NEW."integration_ref"     IS DISTINCT FROM OLD."integration_ref"
     OR NEW."ref_authority"       IS DISTINCT FROM OLD."ref_authority"
     OR NEW."remote_name"         IS DISTINCT FROM OLD."remote_name"
     OR NEW."authority_runner_id" IS DISTINCT FROM OLD."authority_runner_id" THEN
    NEW."config_revision" := OLD."config_revision" + 1;
  ELSE
    NEW."config_revision" := OLD."config_revision";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "project_codebase_config_guard" ON "project_codebase";
CREATE TRIGGER "project_codebase_config_guard"
  BEFORE INSERT OR UPDATE ON "project_codebase"
  FOR EACH ROW EXECUTE FUNCTION project_codebase_config_guard();

-- ---------------------------------------------------------------------------------------------
-- 2 · `session` 的 SOURCE 快照：十五列，两个封条。
--
-- 每一列都是可空的，或者带一个**常量**默认值，所以这一段整体走 catalog 路径：既有行读到
-- `UNBOUND` / `'{}'` / `false`，堆一页没动（S1.02 用 `pg_attribute.atthasmissing` 断言这件事）。
-- ---------------------------------------------------------------------------------------------

-- 状态机（§6）。默认 `UNBOUND` 就是 SR45 的全部实现。
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_state" TEXT NOT NULL DEFAULT 'UNBOUND';

-- ── create 冻结的九列（SourceSelector，意图）─────────────────────────────────────────────────
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_kind" TEXT;
-- 解析当时那条 `ProjectCodebase`。**无外键**：删掉绑定不得改写已冻结的快照。
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_codebase_id" UUID;
-- 反规范化的仓库身份，冻结。改 codebase 的 URL 不影响在飞 session。
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_repo_url" TEXT;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_root_commit_sha" CHAR(40);
-- ref 值 selector 的全名 ref / SHA 值 selector 的 SHA。恰好一个非空（下面的 CHECK）。
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_ref" TEXT;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_revision_sha" CHAR(40);
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_config_revision" BIGINT;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_ref_authority" TEXT;
-- 依赖 closure：基线**必须包含**的 SHA 集合（§5 G5）。只有 `kind = 'ACCEPTED'` 的 checkpoint 能进来
-- （SR25），那条规则读的是另一张表，因此由 S6 的解析器执行，不是这里的 CHECK。
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_required_contains" CHAR(40)[] NOT NULL DEFAULT '{}';

-- ── 首次 claim 冻结的三列（SourcePin，事实）────────────────────────────────────────────────
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_base_sha" CHAR(40);
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_resolved_at" TIMESTAMP(3);
-- 溯源，从不作为决策输入。无外键，与 `source_codebase_id` 同一条理由。
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_resolved_by_runner_id" UUID;

-- ── 状态机自身（§6 的转移表管辖，不属于任一冻结集合）─────────────────────────────────────
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_refusal_code" TEXT;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "source_refusal_detail" JSONB;

DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_state_chk"
    CHECK ("source_state" IN ('UNBOUND', 'SELECTED', 'PINNED', 'REFUSED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_kind_chk"
    CHECK ("source_kind" IS NULL OR "source_kind" IN (
      'VERIFICATION_SUBJECT', 'PINNED_REVISION', 'TASK_KNOWN_GOOD',
      'DEPENDENCY_CLOSURE', 'PROJECT_UPSTREAM'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_ref_authority_chk"
    CHECK ("source_ref_authority" IS NULL OR "source_ref_authority" IN ('REMOTE', 'RUNNER_LOCAL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §10.1 的十个码，整张表，冻结。一个落不进这一列的拒绝，只能变成一次静默降级 —— 而静默降级正是本契约
-- 存在的理由（SR33）。
--
-- 这里登记的是**词汇**，不是可达性：哪几个码真能出现在一行上，由下面 `session_source_refusal_chk` 的
-- `IS NOT NULL` ⇔ `state = 'REFUSED'` 决定，而不是由一张更窄的第二份清单决定。两份清单就是两处会漂移的
-- 真相，而这一份必须与 §10.1 逐字相等（SR47 的闭合性靠的就是"只有一张表"）。
--
-- 于是派发路径的 `SOURCE_PROTOCOL_UNSUPPORTED` 在词汇里、却落不到一行上，这是对的：SR35 说它让 session
-- **停在** `SELECTED`（换一台新 runner 就能跑，这不是配置错误）。一条既写着"拒绝原因是 X"又还在排队等
-- 派发的 session，正是状态机要消灭的"两个答案"。它的去处是 blocker（SR50），不是这一列。
DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_refusal_code_chk"
    CHECK ("source_refusal_code" IS NULL OR "source_refusal_code" IN (
      'PROJECT_CODEBASE_UNBOUND', 'BASE_REPO_MISMATCH', 'SOURCE_AUTHORITY_UNREACHABLE',
      'BASE_REF_NOT_FOUND', 'BASE_SHA_UNAVAILABLE', 'DEPENDENCY_BASE_NOT_LANDED',
      'WORKTREE_REQUIRED', 'SOURCE_PROTOCOL_UNSUPPORTED', 'SOURCE_PIN_IMMUTABLE',
      'CODEBASE_AUTHORITY_INVALID'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 四个 SHA 位置同一条规则：全 40 位小写十六进制。数组那一条用 `array_to_string` 而不是子查询，因为
-- CHECK 里不能有子查询；空数组走 `array_length ... IS NULL` 那一支。
DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_sha_chk"
    CHECK (("source_root_commit_sha" IS NULL OR "source_root_commit_sha" ~ '^[0-9a-f]{40}$')
       AND ("source_revision_sha"    IS NULL OR "source_revision_sha"    ~ '^[0-9a-f]{40}$')
       AND ("source_base_sha"        IS NULL OR "source_base_sha"        ~ '^[0-9a-f]{40}$')
       AND (array_length("source_required_contains", 1) IS NULL
            OR array_to_string("source_required_contains", ',') ~ '^[0-9a-f]{40}(,[0-9a-f]{40})*$'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_ref_chk"
    CHECK ("source_ref" IS NULL OR "source_ref" ~ '^refs/[^[:space:]]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 合法组合，逐状态。`UNBOUND` 那一支是 Legacy 的形状：一条历史 session 携带半个 selector 会让读它的
-- 人以为解析发生过。非 `UNBOUND` 那一支是快照的形状：仓库身份、配置版本、权威三者要么齐备要么都没有,
-- 而 ref 值 selector 与 SHA 值 selector **恰好一个**（`<>` 作用在两个布尔上就是异或）。
DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_snapshot_chk"
    CHECK (CASE WHEN "source_state" = 'UNBOUND' THEN
             "source_kind" IS NULL AND "source_codebase_id" IS NULL
             AND "source_repo_url" IS NULL AND "source_root_commit_sha" IS NULL
             AND "source_ref" IS NULL AND "source_revision_sha" IS NULL
             AND "source_config_revision" IS NULL AND "source_ref_authority" IS NULL
             AND "source_required_contains" = '{}'::CHAR(40)[]
             AND "source_base_sha" IS NULL AND "source_resolved_at" IS NULL
             AND "source_resolved_by_runner_id" IS NULL
             AND "source_refusal_code" IS NULL AND "source_refusal_detail" IS NULL
           ELSE
             "source_kind" IS NOT NULL AND "source_codebase_id" IS NOT NULL
             AND "source_repo_url" IS NOT NULL AND "source_config_revision" IS NOT NULL
             AND "source_ref_authority" IS NOT NULL
             AND (("source_ref" IS NULL) <> ("source_revision_sha" IS NULL))
           END);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §4.1 的真值表，作为行内约束：`VERIFICATION_SUBJECT` 与 `TASK_KNOWN_GOOD` 只可能是 SHA 值
-- （候选提交 / 上一代挣到的 known-good 点都是 commit），`DEPENDENCY_CLOSURE` 与 `PROJECT_UPSTREAM`
-- 只可能是 ref 值（integration / upstream 的 tip）。`PINNED_REVISION` 两者皆可（SR15）。
DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_kind_selector_chk"
    CHECK ("source_kind" IS NULL
       OR ("source_kind" IN ('VERIFICATION_SUBJECT', 'TASK_KNOWN_GOOD') AND "source_revision_sha" IS NOT NULL)
       OR ("source_kind" IN ('DEPENDENCY_CLOSURE', 'PROJECT_UPSTREAM') AND "source_ref" IS NOT NULL)
       OR "source_kind" = 'PINNED_REVISION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- `PINNED` 就是"有 pin"，两者互为充要 —— 没有"已 PINNED 但还没有 SHA"的中间状态可以被 claim 读到,
-- 也没有"有 SHA 但状态还没跟上"的行可以让 engine 提前起来（SR33）。
DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_pin_chk"
    CHECK (("source_base_sha" IS NOT NULL) = ("source_state" = 'PINNED')
       AND ("source_resolved_at" IS NOT NULL) = ("source_base_sha" IS NOT NULL)
       AND ("source_base_sha" IS NOT NULL OR "source_resolved_by_runner_id" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "session" ADD CONSTRAINT "session_source_refusal_chk"
    CHECK (("source_refusal_code" IS NOT NULL) = ("source_state" = 'REFUSED')
       AND ("source_refusal_code" IS NOT NULL OR "source_refusal_detail" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- "这条 codebase 冻结出过哪些运行"是 §8 要回答的溯源读，而这一列**故意没有外键**，所以没有别的东西
-- 会替它建索引。PARTIAL：六位数的 Legacy session 一行都不在里面。
CREATE INDEX IF NOT EXISTS "session_source_codebase_idx"
  ON "session" ("source_codebase_id") WHERE "source_codebase_id" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2.1 · 两个封条，一个触发器。
--
-- create-frozen 的九列对**每一次** UPDATE 都拒绝，比 SR11 声明的封条（`source_state != 'UNBOUND'`）
-- 更强一格，而这一格正是 SR28 要的：selector 九列必须与 session 行同一条 INSERT 写入。存在一个
-- "session 已可被 claim 但 selector 还没写"的窗口，就存在一次会读到空 selector 并按 Legacy 起跑的
-- claim —— 那个窗口只能由"这九列永远不接受第二条语句"来关掉。`UNBOUND` 的行本来就必须让它们全空
-- （上面的快照 CHECK），所以这一格没有夺走任何合法写入。
--
-- claim-frozen 的三列的封条是 `source_base_sha IS NOT NULL`，且**没有** PAC §6 S4 给 `model` 留的那种
-- "下架了就改写一次"的例外：一个不可达的 SHA 不是"换一个"的理由，是拒绝的理由（SR12）。
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION session_source_freeze_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."source_kind"              IS DISTINCT FROM OLD."source_kind"
     OR NEW."source_codebase_id"       IS DISTINCT FROM OLD."source_codebase_id"
     OR NEW."source_repo_url"          IS DISTINCT FROM OLD."source_repo_url"
     OR NEW."source_root_commit_sha"   IS DISTINCT FROM OLD."source_root_commit_sha"
     OR NEW."source_ref"               IS DISTINCT FROM OLD."source_ref"
     OR NEW."source_revision_sha"      IS DISTINCT FROM OLD."source_revision_sha"
     OR NEW."source_config_revision"   IS DISTINCT FROM OLD."source_config_revision"
     OR NEW."source_ref_authority"     IS DISTINCT FROM OLD."source_ref_authority"
     OR NEW."source_required_contains" IS DISTINCT FROM OLD."source_required_contains" THEN
    RAISE EXCEPTION
      'SOURCE_PIN_IMMUTABLE: session % froze its SOURCE selector when it was created; recovery is a new session, not a rewrite',
      OLD."id" USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD."source_base_sha" IS NOT NULL
     AND (NEW."source_base_sha" IS DISTINCT FROM OLD."source_base_sha"
          OR NEW."source_resolved_at" IS DISTINCT FROM OLD."source_resolved_at"
          OR NEW."source_resolved_by_runner_id" IS DISTINCT FROM OLD."source_resolved_by_runner_id") THEN
    RAISE EXCEPTION
      'SOURCE_PIN_IMMUTABLE: session % is pinned to %; a worktree already exists on it',
      OLD."id", OLD."source_base_sha" USING ERRCODE = 'raise_exception';
  END IF;

  -- §6.1 的转移表，负向面。`UNBOUND` 与 `REFUSED` 是终态（T8：`REFUSED` 之后任何事件都不改状态,
  -- 恢复靠新开一条 session —— SR34）；`PINNED` 只能停在 `PINNED`（T6/T7：恢复路径只读，拿不到
  -- SHA 是本次运行失败而不是状态回退）；`SELECTED` 是唯一有出口的状态。
  IF NEW."source_state" IS DISTINCT FROM OLD."source_state"
     AND NOT (OLD."source_state" = 'SELECTED' AND NEW."source_state" IN ('PINNED', 'REFUSED')) THEN
    RAISE EXCEPTION
      'SOURCE_PIN_IMMUTABLE: session % cannot move its SOURCE state from % to %',
      OLD."id", OLD."source_state", NEW."source_state" USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `UPDATE OF` 而不是裸 `UPDATE`：这是一个不可变守卫，而一条不点名这些列的语句按构造改不了它们。
-- 代价是每次 session 心跳都不再多跑一个 plpgsql 调用 —— 这张表是全库写得最频繁的一张。
DROP TRIGGER IF EXISTS "session_source_freeze_guard" ON "session";
CREATE TRIGGER "session_source_freeze_guard"
  BEFORE UPDATE OF "source_state", "source_kind", "source_codebase_id", "source_repo_url",
                   "source_root_commit_sha", "source_ref", "source_revision_sha",
                   "source_config_revision", "source_ref_authority", "source_required_contains",
                   "source_base_sha", "source_resolved_at", "source_resolved_by_runner_id"
  ON "session"
  FOR EACH ROW EXECUTE FUNCTION session_source_freeze_guard();

-- ---------------------------------------------------------------------------------------------
-- 3 · `task`：显式基线与 SR5 的逃生口。
-- ---------------------------------------------------------------------------------------------

-- §4 P2。40 位十六进制 SHA，或一个全名 ref。
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "pinned_revision" TEXT;
-- SR5 的逃生口：一个绑了代码库的 Project 里的调研/文档任务。默认 false，常量默认值，不重写堆。
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "codeless" BOOLEAN NOT NULL DEFAULT false;

-- SR15。**缩写 SHA 一律拒绝** —— 缩写按构造就是二义的，而基线的全部意义是事后可核对。
DO $$ BEGIN
  ALTER TABLE "task" ADD CONSTRAINT "task_pinned_revision_shape_chk"
    CHECK ("pinned_revision" IS NULL
       OR "pinned_revision" ~ '^[0-9a-f]{40}$'
       OR "pinned_revision" ~ '^refs/[^[:space:]]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SR16，写成 CHECK 而不是写入路径上的一次判断，因此**两个方向**都关上了：既不能给 verification 任务
-- 加 pin，也不能把一个已 pin 的任务改成 verification。一个 verification 的全部意义是"检查那个候选",
-- 允许改基线就是允许它对着别的代码宣布 PASS（§4 D1）。
DO $$ BEGIN
  ALTER TABLE "task" ADD CONSTRAINT "task_pinned_revision_verification_chk"
    CHECK ("pinned_revision" IS NULL OR "verifies_task_id" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------------------------
-- 4 · `project_blocker_kind_chk` += `SOURCE_UNRESOLVED`（SR50/SR51）。
--
-- 解析路径的七个码与派发路径的一个码，全部落成这**一个** kind，精确 `code` 与 `fixAction` 放该
-- blocker 的结构化 detail。理由：`kind` 是一套**路由**词汇 —— 它回答"谁来修、UI 给哪个按钮"，而这八个
-- 码路由到同一个结论："必须有人改配置或先把前置合进去，重试不会有帮助"。把不改变路由决策的粒度放进
-- 封闭集合，只会让这条 CHECK 每加一个错误码就要改一次；放进 payload 则粒度不丢。
--
-- 这是一次**整体重写**（PostgreSQL 没有"往 CHECK 里加一个值"的语法），所以它必须写在**当前生效的**
-- 集合之上，而不是写在契约起草时读到的那一份之上。当前生效的是 `0201_completion_ack_canonical_obligation`
-- 留下的 26 个值 —— 注意 `COMPLETION_ACK_STALE`：`0220_completion_ack_removal` 删掉了整套 completion-ACK
-- 机制，却**明确保留**了这个成员，理由写在它自己的注释里（线上有一条 RESOLVED 的 project_blocker 行
-- 带着它）。漏掉它这条 ADD CONSTRAINT 会在真实数据上当场失败，而在一个空 schema 上照样通过 —— 这正是
-- `project-codebase-migration.pg.spec.ts` 要在**装了数据的库**上跑这条迁移的原因。
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "project_blocker" DROP CONSTRAINT IF EXISTS "project_blocker_kind_chk";

ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_kind_chk"
  CHECK ("kind" IN (
    'WHO_UNRESOLVED', 'WHO_NOT_IN_TEAM', 'WHO_DISABLED', 'PROVIDER_UNAVAILABLE',
    'RUNTIME_REQUIREMENT_UNMET', 'NO_PROJECT_WORKSPACE', 'NO_MATCHING_RUNNER',
    'MERGE_CONFLICT', 'TEST_FAILED', 'VERIFICATION_FAILED', 'BUDGET_EXHAUSTED',
    'AWAITING_USER_APPROVAL', 'AWAITING_USER_INPUT', 'POLICY_MANUAL_HOLD',
    'DEPENDENCY_CYCLE', 'COORDINATOR_UNAVAILABLE', 'COORDINATOR_NO_PROGRESS',
    'AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE', 'VERIFICATION_REQUIRED',
    'VERIFICATION_CANNOT_CONCLUDE', 'ENVIRONMENT_BROKEN', 'HUMAN_DECISION_REQUIRED',
    'VERDICT_APPLY_EXHAUSTED', 'COMPLETION_ACK_STALE', 'SOURCE_UNRESOLVED',
    'UNKNOWN_FAILURE'
  ));

COMMIT;
