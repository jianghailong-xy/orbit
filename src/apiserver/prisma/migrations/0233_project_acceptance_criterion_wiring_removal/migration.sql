-- T4 —— 把「标准指向工作」的那四个接线字段从验收标准上摘掉。
--
-- `project_acceptance_criterion_definition` 上的 `completion_criterion` / `acceptance_command` /
-- `acceptance_expected_exit_code` / `evidence_task_id` 是一条**从标准指向工作**的边：一条标准自己声明
-- 「用哪条命令、比对哪个退出码、拿哪个 task 当证据」。0232 已经把这条边反过来落了库
-- （`task.criterion_definition_id` + `criterion_revision`：一份工作声明它服务哪条标准），而
-- 「这条标准满足了吗」现在是从工作那一侧派生出来的（T3 的三子句派生读）。两个方向
-- 的边同时存在，就有两份可以互相矛盾的接线；本迁移删掉标准那一侧，只留下账号所有者批准的那件东西：
-- `text` + `verification_method` + `revision`，以及身份/哈希列。
--
-- 留下什么，以及为什么不顺手多删
-- ==============================
--   * `completion_criterion_override_reason` **留着**。它两头不靠（是 `completion_criterion` 的
--     advisory override 审计，而那一列正在走），归属由账号所有者决定，不由本迁移代劳。
--   * `semantic_revision` / `semantic_hash` / `evaluation_plan_revision` / `evaluation_plan_hash`
--     四列**留着**，只重写喂它们的输入。0195 把这两条 lane 分开时，semantic 是「text + 标准种类」、
--     evaluation plan 是「commands、verifier prose、evidence wiring」。四个输入删掉三个之后，
--     evaluation plan lane 只剩 `verification_method` —— 那是它今天真正 hash 的东西，把它写清楚，
--     而不是把 lane 一起删掉。
--
-- 三类依赖，只有两类会自己报错
-- ============================
-- 被 PostgreSQL 追踪的（`DROP COLUMN` 会为它们报 2BP01）：
--   * `project_acceptance_definition_declaration_chk` —— 0189 建的跨四列 CHECK。
--   * `project_acceptance_definition_normalize` 触发器的 `UPDATE OF` 列清单。
-- 两个都在下面**逐个点名摘掉**，不用 `CASCADE`：CASCADE 会静默带走它牵到的一切，而事后无从知道少了
-- 什么。
--
-- 不被追踪的：**plpgsql / sql 函数体**。PostgreSQL 不解析函数体里的列引用，所以删列既不报错、
-- CASCADE 也不修它们，它们会在**下一次执行时**才炸。按活库 `pg_get_functiondef` 逐个捞出来重写的有：
--   * `project_acceptance_definition_content_hash`（6 参 → 2 参）
--   * `project_acceptance_definition_semantic_hash`（2 参 → 1 参）
--   * `project_acceptance_definition_evaluation_plan_hash`（4 参 → 1 参）
--   * `project_acceptance_definition_normalize()`
--   * `project_completion_contract_snapshot(UUID)`
-- 前三个换了签名，所以是 `DROP FUNCTION` 而不是 `CREATE OR REPLACE` —— 后者只会多出一个重载，让旧的
-- 那份留在库里继续引用已删的列。
--
-- 枚举不删
-- ========
-- `task_completion_criterion` 三个标签原样保留：`task.completion_criterion` 还在用它，本迁移只是去掉
-- 它的第二个使用方。所以下面没有任何 `DROP TYPE`，且三个 hash 函数重建时都不再把它写进签名。
--
-- 存量行与 contract digest
-- ========================
-- 三个 hash 列按新配方**就地回填**，`revision` / `semantic_revision` / `evaluation_plan_revision`
-- 一律不动：变的是配方不是这条标准的意思，把它记成一次编辑是假的。回填前先摘掉 BEFORE 触发器，所以
-- `updated_at` 也不动。
--
-- `project_completion_contract` 是可重建的投影，本迁移不主动 refresh；但回填会触发那张表自己的
-- 延迟约束触发器 `zz_project_completion_contract_definition`，于是每个有标准的项目会在本事务提交时
-- 按新的 snapshot 重算一次 —— 这是对的：验收标准的物质**确实**变了（`criteriaTrust` / `commands` /
-- `evidenceWiring` 三块喂料没了），contract digest 随之移动，`last_change_reason` 会写成
-- `ACCEPTANCE_DEFINITION_CHANGED`。0219 当年能断言「digest 一个字节都不动」，是因为它那次改的只是
-- 取数来源；这一次改的是内容本身，所以那条断言在这里不成立，装出成立才是错的。
--
-- 没有显式 BEGIN / COMMIT：迁移文件由 runner 当作一条多语句查询发出，PostgreSQL 已经把它跑在一个隐式
-- 事务里；显式 COMMIT 会在末尾那道闸门之前就结束事务，让 RAISE 失去回滚全文件的能力。

-- ── 1. 摘掉两个被追踪的依赖 ────────────────────────────────────────────────────────────────────
-- 触发器先走：它的 `UPDATE OF` 列清单点名了四列，而且下面的回填不该经过它。
DROP TRIGGER "project_acceptance_definition_normalize"
  ON "project_acceptance_criterion_definition";

-- 0189 的跨四列 CHECK：把 completion_criterion 与另外三列的合法组合写成一个表达式。四列一起走，
-- 这条断言的三个分支就没有主语了。
ALTER TABLE "project_acceptance_criterion_definition"
  DROP CONSTRAINT "project_acceptance_definition_declaration_chk";

-- ── 2. 按新输入重建三个 hash 函数 ──────────────────────────────────────────────────────────────
DROP FUNCTION project_acceptance_definition_content_hash(
  TEXT, TEXT, "task_completion_criterion", TEXT, INTEGER, UUID);
DROP FUNCTION project_acceptance_definition_semantic_hash(TEXT, "task_completion_criterion");
DROP FUNCTION project_acceptance_definition_evaluation_plan_hash(TEXT, TEXT, INTEGER, UUID);

-- 合并身份：一条标准现在就是「这句话」加「怎么判它」。
CREATE FUNCTION project_acceptance_definition_content_hash(
  p_text TEXT,
  p_verification_method TEXT
) RETURNS CHAR(64) AS $$
  SELECT encode(digest(jsonb_build_object(
    'text', p_text,
    'verificationMethod', p_verification_method
  )::text, 'sha256'), 'hex')::CHAR(64)
$$ LANGUAGE SQL IMMUTABLE;

-- semantic lane：所有者批准的那句话本身。0195 时它还带一个 'criteriaTrust'（标准种类），那一列走了。
CREATE FUNCTION project_acceptance_definition_semantic_hash(
  p_text TEXT
) RETURNS CHAR(64) AS $$
  SELECT encode(digest(jsonb_build_object(
    'text', btrim(p_text)
  )::text, 'sha256'), 'hex')::CHAR(64)
$$ LANGUAGE SQL IMMUTABLE;

-- evaluation plan lane：读者据以判断这句话成不成立的那套办法。commands 与 evidence wiring 走了之后
-- 它就只剩这一样，键名保持不变，所以这条 lane 换的是输入不是含义。
CREATE FUNCTION project_acceptance_definition_evaluation_plan_hash(
  p_verification_method TEXT
) RETURNS CHAR(64) AS $$
  SELECT encode(digest(jsonb_build_object(
    'verificationMethod', btrim(p_verification_method)
  )::text, 'sha256'), 'hex')::CHAR(64)
$$ LANGUAGE SQL IMMUTABLE;

-- ── 3. 重写读这四列的两个函数体 ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION project_acceptance_definition_normalize() RETURNS TRIGGER AS $$
DECLARE
  semantic_changed BOOLEAN;
  plan_changed BOOLEAN;
BEGIN
  NEW."text" := btrim(NEW."text");
  NEW."verification_method" := btrim(NEW."verification_method");
  NEW."completion_criterion_override_reason" := CASE
    WHEN NEW."completion_criterion_override_reason" IS NULL THEN NULL
    ELSE btrim(NEW."completion_criterion_override_reason") END;

  IF TG_OP = 'INSERT' THEN
    NEW."revision" := 1;
    NEW."semantic_revision" := 1;
    NEW."evaluation_plan_revision" := 1;
  ELSE
    semantic_changed := NEW."text" IS DISTINCT FROM OLD."text";
    plan_changed := NEW."verification_method" IS DISTINCT FROM OLD."verification_method";
    NEW."revision" := CASE WHEN semantic_changed OR plan_changed
      THEN OLD."revision" + 1 ELSE OLD."revision" END;
    NEW."semantic_revision" := CASE WHEN semantic_changed
      THEN OLD."semantic_revision" + 1 ELSE OLD."semantic_revision" END;
    NEW."evaluation_plan_revision" := CASE WHEN plan_changed
      THEN OLD."evaluation_plan_revision" + 1 ELSE OLD."evaluation_plan_revision" END;
    NEW."updated_at" := CURRENT_TIMESTAMP;
  END IF;

  NEW."content_hash" := project_acceptance_definition_content_hash(
    NEW."text", NEW."verification_method"
  );
  NEW."semantic_hash" := project_acceptance_definition_semantic_hash(NEW."text");
  NEW."evaluation_plan_hash" := project_acceptance_definition_evaluation_plan_hash(
    NEW."verification_method"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 0219 之后的 snapshot，改动只发生在读这四列的四个地方：
--   * semantic：删掉 `criteriaTrust`（它整块就是 completion_criterion）；`outcomes` 的排序键去掉
--     completion_criterion。
--   * evaluation plan：删掉 `commands`（acceptanceCommand + expectedExitCode 去掉之后只剩一个
--     definitionId，不是一份 command 清单）；`evidenceWiring` 去掉 evidenceTaskId 之后剩下的是这条
--     lane 的 per-definition 版本向量，与 semantic 侧的 `criteriaVersions` 正好对称，所以改名叫
--     `evaluationPlanVersions`，不留一个叫 wiring 却不含 wiring 的键；`verifiers` 去掉
--     completionCriterion，剩下 verifier prose 本身。
-- 其余每一个键、每一个名字、每一处排序都原样不动。
CREATE OR REPLACE FUNCTION project_completion_contract_snapshot(p_project UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  WITH base AS (
    SELECT p.* FROM "project" p WHERE p."id" = p_project
  ), material AS (
    SELECT base.*,
      -- The three operating materials stay exactly as they were: bound to the live values and to
      -- authorizationRevision, because a bound action must still notice the moment any of them
      -- changes underneath it, in either direction.
      jsonb_build_object(
        'automationPolicy', base."automation_policy"::text,
        'authorizationRevision', base."config_revision"::text,
        'convergenceThresholds', base."convergence_thresholds",
        'unboundedAuthorizedBy', base."unbounded_authorized_by"
      ) AS risk_material,
      jsonb_build_object(
        'authorizationRevision', base."config_revision"::text,
        'coordinatorEnabled', base."coordinator_enabled",
        'maxConcurrentTasks', base."max_concurrent_tasks"
      ) AS permission_material,
      jsonb_build_object(
        'attemptBudget', base."attempt_budget",
        'authorizationRevision', base."config_revision"::text,
        'sessionBudgetPerDay', base."session_budget_per_day"
      ) AS budget_material,
      jsonb_build_object(
        'coordinatorAgentIds', COALESCE((
          SELECT jsonb_agg(m."agent_id"::text ORDER BY m."agent_id")
            FROM "project_member" m
           WHERE m."project_id" = base."id" AND m."role" = 'COORDINATOR'::"project_role"
        ), '[]'::jsonb),
        'members', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'agentId', m."agent_id"::text,
            'role', m."role"::text
          ) ORDER BY m."agent_id", m."role")
            FROM "project_member" m
           WHERE m."project_id" = base."id"
        ), '[]'::jsonb),
        'ownerId', base."owner_id"::text
      ) AS recipient_material
      FROM base
  ), digested AS (
    SELECT material.*,
      outcome_sha256_json(risk_material) AS risk_digest,
      outcome_sha256_json(permission_material) AS permission_digest,
      outcome_sha256_json(budget_material) AS budget_digest,
      outcome_sha256_json(recipient_material) AS recipient_digest,
      -- The semantic side of the same six values, without authorizationRevision: a revision counter
      -- is how an operating digest notices movement, not part of what the project IS.
      jsonb_build_object(
        'automationPolicy', material."automation_policy"::text,
        'convergenceThresholds', material."convergence_thresholds",
        'unboundedAuthorizedBy', material."unbounded_authorized_by"
      ) AS risk_boundary,
      jsonb_build_object(
        'coordinatorEnabled', material."coordinator_enabled",
        'maxConcurrentTasks', material."max_concurrent_tasks"
      ) AS permission_boundary,
      jsonb_build_object(
        'attemptBudget', material."attempt_budget",
        'sessionBudgetPerDay', material."session_budget_per_day"
      ) AS budget_boundary
      FROM material
  ), assembled AS (
    SELECT digested.*,
      jsonb_build_object(
        'budget', budget_boundary,
        'criteria', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'semanticHash', d."semantic_hash"::text,
            'text', d."text"
          ) ORDER BY d."semantic_hash", d."text", d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        -- Unchanged and deliberately so: this is the ABA lane. definitionId + semanticRevision are
        -- what stop an edit-then-revert, a delete/recreate or an identity replacement from landing
        -- back on a digest that was cut for different rows.
        'criteriaVersions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'definitionId', d."id"::text,
            'semanticHash', d."semantic_hash"::text,
            'semanticRevision', d."semantic_revision"
          ) ORDER BY d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'goal', digested."goal",
        'outcomes', COALESCE((
          SELECT jsonb_agg(d."text" ORDER BY d."text", d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'ownerId', digested."owner_id"::text,
        'permissions', permission_boundary,
        'recipients', recipient_material,
        'recipientDigest', recipient_digest,
        'riskBoundary', risk_boundary
      ) AS semantic_material,
      jsonb_build_object(
        'collectorVersions', '[]'::jsonb,
        'environment', jsonb_build_object('instructions', digested."instructions"),
        'evaluationPlanVersions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'definitionId', d."id"::text,
            'evaluationPlanHash', d."evaluation_plan_hash"::text,
            'evaluationPlanRevision', d."evaluation_plan_revision"
          ) ORDER BY d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'verifiers', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'definitionId', d."id"::text,
            'verificationMethod', d."verification_method"
          ) ORDER BY d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb)
      ) AS evaluation_plan_material
      FROM digested
  )
  SELECT jsonb_build_object(
    'budgetDigest', budget_digest,
    'contractDigest', outcome_sha256_json(semantic_material),
    'evaluationPlanDigest', outcome_sha256_json(evaluation_plan_material),
    'evaluationPlanMaterial', evaluation_plan_material,
    'permissionDigest', permission_digest,
    'recipientDigest', recipient_digest,
    'riskPolicyDigest', risk_digest,
    'semanticMaterial', semantic_material
  ) INTO result FROM assembled;
  IF result IS NULL THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND: project % has no completion contract', p_project
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ── 4. 删列 ────────────────────────────────────────────────────────────────────────────────────
-- 不带 CASCADE：上面已经逐个点名摘掉了两个被追踪的依赖，这里再报 2BP01 就说明有第三个对象是我没看见
-- 的，那种情况应该失败，而不是被 CASCADE 静默带走。
ALTER TABLE "project_acceptance_criterion_definition"
  DROP COLUMN "completion_criterion",
  DROP COLUMN "acceptance_command",
  DROP COLUMN "acceptance_expected_exit_code",
  DROP COLUMN "evidence_task_id";

-- ── 5. 存量行按新配方回填 ──────────────────────────────────────────────────────────────────────
-- 只写三个 hash 列。BEFORE 触发器此刻还没装回去，所以 revision 三兄弟和 updated_at 都不会被顺手改掉。
-- 刻意排在 DROP COLUMN 之后：这条 UPDATE 会给延迟约束触发器 zz_project_completion_contract_definition
-- 排下待处理事件，而 ALTER TABLE 不允许表上有待处理的触发器事件（55006）。放在删列之后，事件在本事务
-- 提交时才展开，那时新的 snapshot 已经装好，读的也已经是删完列的表。
UPDATE "project_acceptance_criterion_definition"
   SET "content_hash" = project_acceptance_definition_content_hash(
         "text", "verification_method"
       ),
       "semantic_hash" = project_acceptance_definition_semantic_hash("text"),
       "evaluation_plan_hash" = project_acceptance_definition_evaluation_plan_hash(
         "verification_method"
       );

-- ── 6. 把归一化触发器装回去，列清单里不再有那四列 ──────────────────────────────────────────────
CREATE TRIGGER project_acceptance_definition_normalize
  BEFORE INSERT OR UPDATE OF
    "text", "verification_method",
    "completion_criterion_override_reason", "revision", "content_hash",
    "semantic_revision", "semantic_hash", "evaluation_plan_revision", "evaluation_plan_hash"
  ON "project_acceptance_criterion_definition"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_definition_normalize();

-- ── 7. 闸门，刻意放在最后 ──────────────────────────────────────────────────────────────────────
-- 上面全部在同一个事务里，所以这里一旦拒绝，整份文件回滚，而且这条 RAISE 就是迁移 runner 打印的错误
-- 本身，而不是下游那句 "transaction is aborted"。
--
-- 两件事一起验：四列真的走了；枚举和它的三个标签真的还在，且 `task.completion_criterion` 仍然在用它。
-- 第二件事是本迁移最容易被工具悄悄做错的地方 —— Prisma 或一句 CASCADE 顺手 DROP TYPE，删的就不再是
-- 「枚举的第二个使用方」，而是枚举本身。
DO $$
DECLARE
  leftover TEXT;
  labels TEXT;
  users TEXT;
BEGIN
  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO leftover
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'project_acceptance_criterion_definition'
     AND column_name IN ('completion_criterion', 'acceptance_command',
                         'acceptance_expected_exit_code', 'evidence_task_id');
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'CRITERION_WIRING_REMOVAL_LEFT_COLUMNS: %', leftover
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT string_agg(e."enumlabel", ', ' ORDER BY e."enumsortorder") INTO labels
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'task_completion_criterion';
  IF labels IS DISTINCT FROM 'EXECUTABLE, VERIFICATION, EVIDENCE_JUDGMENT' THEN
    RAISE EXCEPTION 'CRITERION_WIRING_REMOVAL_TOUCHED_ENUM: task_completion_criterion is now %',
      COALESCE(labels, '<dropped>')
      USING ERRCODE = 'raise_exception',
            HINT = 'task.completion_criterion still declares this enum. Removing the criterion '
                   'definition''s use of it must leave the type and all three labels alone.';
  END IF;

  SELECT string_agg(format('%s.%s', table_name, column_name), ', '
                    ORDER BY table_name, column_name) INTO users
    FROM information_schema.columns
   WHERE table_schema = 'public' AND udt_name = 'task_completion_criterion';
  IF users IS DISTINCT FROM 'task.completion_criterion' THEN
    RAISE EXCEPTION 'CRITERION_WIRING_REMOVAL_LEFT_ENUM_USERS: %', COALESCE(users, '<none>')
      USING ERRCODE = 'raise_exception';
  END IF;

  RAISE NOTICE 'criterion wiring removal: four columns dropped, task_completion_criterion intact';
END $$;
