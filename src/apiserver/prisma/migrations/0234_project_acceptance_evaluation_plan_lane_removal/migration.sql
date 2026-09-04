-- T6 —— 把标准侧的 evaluation-plan lane 摘掉：`evaluation_plan_revision` / `evaluation_plan_hash`
-- 两列，以及只为它们存在的那个 hash 函数。
--
-- 这条 lane 为什么该走
-- ====================
-- 0195 把一条标准的身份拆成两条 lane 时，semantic 是「所有者批准的那句话」，evaluation plan 是
-- 「读者据以判断它成不成立的那套办法」——当时那套办法有四个输入：`completion_criterion`、
-- `acceptance_command`、`acceptance_expected_exit_code`、`evidence_task_id`，加上
-- `verification_method`。0233 把前四个删掉之后，这条 lane 只剩 `verification_method` 一个输入，
-- 与 semantic lane 的 `text` 一一对应地并列，却不再区分任何两行标准：任何让 evaluation_plan_hash
-- 移动的编辑都恰好是一次 `verification_method` 的编辑，而那件事 `revision` 与 `content_hash`
-- 已经在说了。0233 当时选择「保留列、只重写输入」，并把这个取舍留给账号所有者；账号所有者的决定是删。
--
-- 只删标准那一条，不碰契约那一条
-- ==============================
-- `evaluation_plan_revision` 这个名字在库里有两处：本表上的 INTEGER，和
-- `project_completion_contract` 上的 BIGINT。后者是**契约级**的 plan lane —— 整个项目的
-- evaluation plan material 的版本计数器，由 `project_refresh_completion_contract` 维护 ——
-- 不在本次决定的范围内，本迁移不碰它。类型不同正是它们从来不是同一件事的标志，
-- 文件末尾的闸门把这一点写成断言。
--
-- 三类依赖，按活库枚举
-- ====================
-- 被 PostgreSQL 追踪的（`DROP COLUMN` 会为它们报 2BP01）。按活库 `pg_depend` 逐列枚举，结果是两个：
--   * `project_acceptance_definition_normalize` 触发器的 `UPDATE OF` 列清单（两列都在里面，
--     0233 重装时写进去的）。下面**点名摘掉**，不用 `CASCADE`：CASCADE 会静默带走它牵到的一切，
--     而事后无从知道少了什么。
--   * `evaluation_plan_revision` 的 `DEFAULT 1`（pg_attrdef，deptype 'a'）。它随列一起走，
--     不需要、也不能单独处理。
-- 没有 CHECK、没有索引、没有视图引用这两列 —— 这不是假设，是 `pg_depend` 的全部输出。
--
-- 不被追踪的：**plpgsql / sql 函数体**。按活库 `pg_get_functiondef` 捞出来重写的有两个：
--   * `project_acceptance_definition_normalize()` —— 赋值这两列。
--   * `project_completion_contract_snapshot(UUID)` —— `evaluationPlanVersions` 键读这两列。
-- 活库里还有第三个函数体命中 `evaluation_plan_revision`：
-- `project_refresh_completion_contract(UUID, TEXT)`。它读的是 `project_completion_contract`
-- 上那个 BIGINT，与本次删的列同名不同物，**原样不动**。
--
-- 以活库为准而不是读迁移文件：同一个函数被 0209 / 0216 / 0218 / 0233 反复 `CREATE OR REPLACE`
-- 过，读迁移文件会读到过期的那一次。
--
-- `evaluationPlanVersions` 这个键
-- ==============================
-- 0233 把它从 `evidenceWiring` 改名而来，内容就是这两列的 per-definition 版本向量，与 semantic 侧的
-- `criteriaVersions` 对称。列没了，这个键也没了 —— 留一个空数组只会让 contract digest 继续为一条
-- 不存在的 lane 腾位置。剩下的 `collectorVersions` / `environment` / `verifiers` 是契约级的
-- evaluation plan material，本迁移不碰。
--
-- 存量行
-- ======
-- 不需要回填：留下来的 `content_hash` / `semantic_hash` 配方一个字都没改，`revision` /
-- `semantic_revision` 的语义也没改（`revision` 仍然由「这句话」或「怎么判它」任一变化推进 ——
-- 走的是那条 lane 的计数器，不是这件事本身）。
--
-- 但 `project_completion_contract` 的 `evaluation_plan_material` 是**存下来的 jsonb**，里面此刻
-- 还有一个 `evaluationPlanVersions`，逐条列着已经不存在的两列。它是可重建的投影，所以下面按现有机制
-- 重建一次：本迁移让物质真的少了，digest 就应该跟着动，`last_change_reason` 与 0233 那次一样是
-- `ACCEPTANCE_DEFINITION_CHANGED`。刻意排在 DROP COLUMN 之后 —— 这是 0233 实测出来的顺序约束：
-- 写这张表会给延迟约束触发器 `zz_project_completion_contract_definition` 排下待处理事件，而
-- `ALTER TABLE` 不允许表上有待处理的触发器事件（55006）。
--
-- 没有显式 BEGIN / COMMIT：迁移文件由 runner 当作一条多语句查询发出，PostgreSQL 已经把它跑在一个
-- 隐式事务里；显式 COMMIT 会在末尾那道闸门之前就结束事务，让 RAISE 失去回滚全文件的能力。

-- ── 1. 摘掉唯一一个被追踪的依赖 ────────────────────────────────────────────────────────────────
-- 它的 `UPDATE OF` 列清单点名了这两列。
DROP TRIGGER "project_acceptance_definition_normalize"
  ON "project_acceptance_criterion_definition";

-- ── 2. 重写归一化函数体，并删掉只为这条 lane 存在的 hash 函数 ──────────────────────────────────
-- `revision` 仍由两半共同推进：一条标准的身份是「这句话」加「怎么判它」，`content_hash` 也仍然
-- hash 这两样。走的是 plan lane 的计数器，不是 `verification_method` 在这条标准里的分量。
CREATE OR REPLACE FUNCTION project_acceptance_definition_normalize() RETURNS TRIGGER AS $$
DECLARE
  semantic_changed BOOLEAN;
  method_changed BOOLEAN;
BEGIN
  NEW."text" := btrim(NEW."text");
  NEW."verification_method" := btrim(NEW."verification_method");
  NEW."completion_criterion_override_reason" := CASE
    WHEN NEW."completion_criterion_override_reason" IS NULL THEN NULL
    ELSE btrim(NEW."completion_criterion_override_reason") END;

  IF TG_OP = 'INSERT' THEN
    NEW."revision" := 1;
    NEW."semantic_revision" := 1;
  ELSE
    semantic_changed := NEW."text" IS DISTINCT FROM OLD."text";
    method_changed := NEW."verification_method" IS DISTINCT FROM OLD."verification_method";
    NEW."revision" := CASE WHEN semantic_changed OR method_changed
      THEN OLD."revision" + 1 ELSE OLD."revision" END;
    NEW."semantic_revision" := CASE WHEN semantic_changed
      THEN OLD."semantic_revision" + 1 ELSE OLD."semantic_revision" END;
    NEW."updated_at" := CURRENT_TIMESTAMP;
  END IF;

  NEW."content_hash" := project_acceptance_definition_content_hash(
    NEW."text", NEW."verification_method"
  );
  NEW."semantic_hash" := project_acceptance_definition_semantic_hash(NEW."text");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 活库里它只有一个调用方，就是上面刚刚重写掉的那个函数体。签名没变，所以这是真的删掉，
-- 而不是留一个旧重载在库里继续指着已删的列。
DROP FUNCTION project_acceptance_definition_evaluation_plan_hash(TEXT);

-- ── 3. snapshot 去掉 `evaluationPlanVersions` ──────────────────────────────────────────────────
-- 0233 之后的 snapshot，本迁移只动 evaluation plan material 里的这一个键；其余每一个键、每一个
-- 名字、每一处排序都原样不动。
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
      -- `evaluationPlanVersions` stood here until T6. It was the per-definition version vector of
      -- the two columns this migration drops; with them gone there is nothing for it to carry, and
      -- an empty array would still be a key claiming a lane exists. What remains is the
      -- contract-level plan material, untouched.
      jsonb_build_object(
        'collectorVersions', '[]'::jsonb,
        'environment', jsonb_build_object('instructions', digested."instructions"),
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
-- 不带 CASCADE：上面已经点名摘掉了唯一一个被追踪的依赖，这里再报 2BP01 就说明有第二个对象是我没看见
-- 的，那种情况应该失败，而不是被 CASCADE 静默带走。
ALTER TABLE "project_acceptance_criterion_definition"
  DROP COLUMN "evaluation_plan_revision",
  DROP COLUMN "evaluation_plan_hash";

-- ── 5. 重建那份存下来的 evaluation plan material ───────────────────────────────────────────────
-- 排在删列之后（55006，见文件头）。只写 `project_completion_contract`，那张表上没有触发器。
SELECT project_refresh_completion_contract(c."project_id", 'ACCEPTANCE_DEFINITION_CHANGED')
  FROM "project_completion_contract" c;

-- ── 6. 把归一化触发器装回去，列清单里不再有这两列 ──────────────────────────────────────────────
CREATE TRIGGER project_acceptance_definition_normalize
  BEFORE INSERT OR UPDATE OF
    "text", "verification_method",
    "completion_criterion_override_reason", "revision", "content_hash",
    "semantic_revision", "semantic_hash"
  ON "project_acceptance_criterion_definition"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_definition_normalize();

-- ── 7. 闸门，刻意放在最后 ──────────────────────────────────────────────────────────────────────
-- 上面全部在同一个事务里，所以这里一旦拒绝，整份文件回滚，而且这条 RAISE 就是迁移 runner 打印的错误
-- 本身，而不是下游那句 "transaction is aborted"。
--
-- 三件事一起验：标准那两列真的走了；账号所有者决定保留的列一个没少；契约级那条 BIGINT lane 还在。
-- 第三件是本迁移最容易做错的地方 —— 两个 lane 同名，删错一个不会有任何东西当场报错。
DO $$
DECLARE
  leftover TEXT;
  missing TEXT;
  contract_lane TEXT;
  stale_body TEXT;
BEGIN
  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO leftover
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'project_acceptance_criterion_definition'
     AND column_name IN ('evaluation_plan_revision', 'evaluation_plan_hash');
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'EVALUATION_PLAN_LANE_REMOVAL_LEFT_COLUMNS: %', leftover
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT string_agg(kept, ', ' ORDER BY kept) INTO missing
    FROM unnest(ARRAY['text', 'verification_method', 'revision', 'content_hash',
                      'semantic_revision', 'semantic_hash',
                      'completion_criterion_override_reason']) AS kept
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_acceptance_criterion_definition'
        AND column_name = kept);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'EVALUATION_PLAN_LANE_REMOVAL_TOOK_TOO_MUCH: %', missing
      USING ERRCODE = 'raise_exception',
            HINT = 'completion_criterion_override_reason and content_hash are kept by an account '
                   'owner decision, not by accident. Removing them is a separate decision.';
  END IF;

  SELECT format('%s %s', data_type, column_name) INTO contract_lane
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'project_completion_contract'
     AND column_name = 'evaluation_plan_revision';
  IF contract_lane IS DISTINCT FROM 'bigint evaluation_plan_revision' THEN
    RAISE EXCEPTION 'EVALUATION_PLAN_LANE_REMOVAL_TOUCHED_CONTRACT: %',
      COALESCE(contract_lane, '<dropped>')
      USING ERRCODE = 'raise_exception',
            HINT = 'project_completion_contract carries the contract-level plan lane, spelled the '
                   'same and typed BIGINT. This removal is of the criterion-level INTEGER one.';
  END IF;

  -- 不被追踪的那一类：函数体。活库里唯一允许命中的是读契约级那一列的那个函数。
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO stale_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ 'evaluation_plan_(revision|hash)'
     AND p.oid::regprocedure::text <> 'project_refresh_completion_contract(uuid,text)';
  IF stale_body IS NOT NULL THEN
    RAISE EXCEPTION 'EVALUATION_PLAN_LANE_REMOVAL_LEFT_FUNCTION_BODY: %', stale_body
      USING ERRCODE = 'raise_exception',
            HINT = 'DROP COLUMN does not parse plpgsql. A body naming a dropped column deploys '
                   'cleanly and fails on the next execution.';
  END IF;

  RAISE NOTICE 'evaluation plan lane removal: two criterion columns dropped, contract lane intact';
END $$;
