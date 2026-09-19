-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `automation_policy` 从库里删掉：`project.automation_policy`、`task_scope_revision.automation_policy`、
-- 枚举类型 `project_automation_policy`、CHECK 约束 `task_scope_revision_policy_chk`，以及**所有**
-- 还在读这一列的 DB 对象。
--
-- 顺序不是随便排的，下面每一步都有一条实测出来的理由：
--
--   1. 先重写两个函数体 —— 它们引用这一列，列一没，函数体就是坏的（plpgsql 是运行时解析，坏体不
--      会在 ALTER TABLE 那一步报错，而是留到某个用户请求上炸）。签名都不变，所以都是
--      CREATE OR REPLACE，不留旧重载。
--   2. `DROP TRIGGER zz_project_completion_contract_project` 并按去掉该列的清单重建 ——
--      **必须排在 DROP COLUMN 前面**。这个触发器的 `UPDATE OF` 点名了这一列，所以
--      `DROP COLUMN` 会被 2BP01 挡住（实测：`cannot drop column automation_policy of table project
--      because other objects depend on it / DETAIL: trigger zz_project_completion_contract_project
--      … depends on column`）。它不是「从清单里静默摘掉」，是硬拒绝。
--   3. 删约束、删两列、删类型。
--   4. 最后逐行重算完成契约 digest（见下面那一节）。
--
-- 每一处 DDL 都不带 CASCADE。这个仓库出过 `DROP FUNCTION` 连带误杀现役对象的事故，所以宁可让一条
-- 我没看见的依赖把迁移顶红，也不要 CASCADE 静默带走它。删类型之前已经查过 pg_depend：两列删掉后，
-- `project_automation_policy` 剩下的依赖只有它自己的数组类型（internal，随类型一起走），没有别的。
--
-- 五条查询（pg_proc.prosrc / pg_get_constraintdef / pg_indexes.indexdef / pg_views.definition /
-- pg_get_triggerdef）在本迁移之前各指出：两个函数、一条 CHECK、一个触发器。文件末尾的闸门会把同样
-- 五条查询再跑一遍，一条不剩才算过 —— 那是这份文件自己的证词，不是某个清单的。

-- ── 1. snapshot：risk_material 与 risk_boundary 各去掉一个键 ─────────────────────────────────────
-- 0234 之后的函数体，本迁移只从两个 JSON 里各删掉 `automationPolicy` 这一个键。其余每一个键、每一
-- 个名字、每一处排序都逐字不动 —— 因为这份 material 是两个 digest 的输入，
-- contractDigest 与 riskPolicyDigest 就是被这一个键推动的（其余四条 lane 逐位不变）。
CREATE OR REPLACE FUNCTION project_completion_contract_snapshot(p_project UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  WITH base AS (
    SELECT p.* FROM "project" p WHERE p."id" = p_project
  ), material AS (
    SELECT base.*,
      -- The operating materials stay exactly as they were: bound to the live values and to
      -- authorizationRevision, because a bound action must still notice the moment any of them
      -- changes underneath it, in either direction. `automationPolicy` was the third until this
      -- migration; it is gone from the project, so it is gone from here.
      jsonb_build_object(
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
      -- The semantic side of the same values, without authorizationRevision: a revision counter is
      -- how an operating digest notices movement, not part of what the project IS.
      jsonb_build_object(
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

-- ── 2. 范围守卫：删掉「policy = 'AUTO' 时放行 COORDINATOR」那一支 ────────────────────────────────
-- 保留的行为：revision 1（基线，无人签署）放行；authorized_by_actor = 'USER' 放行；其余一切
-- （含 COORDINATOR、WORKER、VERIFIER）抛 23514。ERRCODE 刻意不动 —— 上游有按 23514 写的断言。
-- 报错文案里那个 policy 占位符没有内容了，所以它消失了，而不是留一个恒为 NONE 的槽。
CREATE OR REPLACE FUNCTION "task_scope_revision_authority_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."revision" = 1 THEN RETURN NEW; END IF;
  IF NEW."authorized_by_actor" = 'USER' THEN RETURN NEW; END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format(
      'SCOPE_CHANGE_REQUIRES_USER: %s may not revise task %s to revision %s',
      NEW."authorized_by_actor", NEW."task_id", NEW."revision");
END;
$$;

-- ── 3. 重建 zz 触发器，清单里不再有 automation_policy ───────────────────────────────────────────
-- 原清单见 0195_project_owner_ratification。DROP + CREATE 而不是 ALTER：触发器的事件清单不可改。
-- 函数体本身不引用这一列（它只 PERFORM project_refresh_completion_contract），所以函数不用动。
DROP TRIGGER zz_project_completion_contract_project ON "project";

CREATE TRIGGER zz_project_completion_contract_project
  AFTER INSERT OR UPDATE OF
    "goal", "instructions", "coordinator_enabled", "max_concurrent_tasks",
    "session_budget_per_day", "config_revision", "convergence_thresholds", "attempt_budget",
    "unbounded_authorized_by"
  ON "project" FOR EACH ROW EXECUTE FUNCTION project_completion_contract_project_trigger();

-- ── 4. 删约束、删两列 ───────────────────────────────────────────────────────────────────────────
-- 约束先删：它对列是 deptype 'a'（随列自动走），显式删掉是为了让第 5 步的 DROP COLUMN 在「有一个
-- 我没看见的依赖」时能干脆地报 2BP01，而不是被自动依赖悄悄吞掉一层。
ALTER TABLE "task_scope_revision" DROP CONSTRAINT "task_scope_revision_policy_chk";

ALTER TABLE "task_scope_revision" DROP COLUMN "automation_policy";

-- 列的默认值 `'MANUAL'::project_automation_policy` 是 pg_attrdef，随列一起走。
ALTER TABLE "project" DROP COLUMN "automation_policy";

-- ── 5. 删枚举类型 ───────────────────────────────────────────────────────────────────────────────
-- 到这里它的依赖只剩自己的数组类型（internal）。不带 CASCADE：还有别的调用者就该当场报错。
DROP TYPE "project_automation_policy";

-- ── 6. 逐行重算完成契约 ─────────────────────────────────────────────────────────────────────────
-- 这是**有意识的一次重算**，不是「顺手刷新」。
--
-- 删掉那两个键会改变 contractDigest 与 riskPolicyDigest（其余四条 lane 逐位不变），所以每一个已存
-- 的 project_completion_contract 行都立刻是过期快照。漂移躲不掉：两条 `_v1` 入口
-- （project_submit_ratified_action_v1 / project_commit_ratified_action_v1）内部是**先刷新再比**，
-- 不存在任何时序能让旧 digest 活下来；而 `project_ratified_action_intent` 的 BEFORE UPDATE 触发器
-- RATIFIED_ACTION_INTENT_IMMUTABLE 让「重算 digest + 改写现存绑定」这条路是关闭的。不在这里重算，
-- 那次刷新就由某个不相干的事务触发，并把 last_change_reason 记成 PROJECT_FIELDS_CHANGED —— 而项目
-- 字段一个都没变，那是一条假归因。所以重算排在删列之后、由本迁移自己认领那个原因。
--
-- 为什么安全：
--   * 只写 `project_completion_contract` 一张表，而该表上**没有任何触发器**（实测 pg_trigger 零行），
--     所以 0234 撞过的 55006 在这里不存在 —— 那条是「ALTER TABLE 时表上还有待处理的触发器事件」，
--     而这里动的是另一张表。
--   * 锁序 `project FOR NO KEY UPDATE` → `project_completion_contract FOR UPDATE`，与全库唯一调用方
--     （project_refresh_completion_contract）同序，不会与它死锁。
--   * 幂等：第二遍 digest 不再变化，contract_revision 也就不再推进。
--   * contract_revision 这一列没有任何读者（两条 `_v1` 只比六个 digest，不比 revision），所以那次
--     +1 没有下游比较会被惊动。
SELECT project_refresh_completion_contract(c."project_id", 'AUTOMATION_POLICY_REMOVED')
  FROM "project_completion_contract" c ORDER BY c."project_id";

-- ── 7. 闸门，刻意放在最后 ───────────────────────────────────────────────────────────────────────
-- 上面全部在同一个事务里，所以这里一旦拒绝，整份文件回滚，而且这条 RAISE 就是迁移 runner 打印的错误
-- 本身，而不是下游那句 "transaction is aborted"。
--
-- 三件事一起验：五个对象真的都走了（**就是那五条查询本身**，不是它们的转述）；触发器还在、且清单里
-- 没有这一列；两个函数体里也没有残留的读者。第三条是本迁移最容易做错的地方 —— 一个忘了重写的
-- plpgsql 函数不会在迁移期报错，它会等到某个用户请求上才炸。
DO $$
DECLARE
  stale TEXT;
  trigger_list TEXT;
BEGIN
  -- 五条查询，逐条集合成一份对象名单。
  SELECT string_agg(obj, E'\n  ' ORDER BY obj) INTO stale FROM (
    SELECT 'prosrc: '||p.oid::regprocedure::text AS obj
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosrc LIKE '%automation_policy%'
    UNION ALL
    SELECT 'constraintdef: '||conrelid::regclass::text||'.'||conname
      FROM pg_constraint WHERE pg_get_constraintdef(oid) LIKE '%automation_policy%'
    UNION ALL
    SELECT 'indexdef: '||indexname
      FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '%automation_policy%'
    UNION ALL
    SELECT 'viewdef: '||schemaname||'.'||viewname
      FROM pg_views WHERE definition LIKE '%automation_policy%'
    UNION ALL
    SELECT 'triggerdef: '||c.relname||'.'||t.tgname
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) LIKE '%automation_policy%'
  ) AS left_over;
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION 'AUTOMATION_POLICY_REMOVAL_LEFT_READERS:%', E'\n  '||stale
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 列与类型真的没了 —— 五条查询看不见「一个没人读的列」，所以这一条得单独问。
  SELECT string_agg(what, ', ' ORDER BY what) INTO stale
    FROM unnest(ARRAY['project.automation_policy', 'task_scope_revision.automation_policy']) AS what
   WHERE EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = split_part(what, '.', 1)
        AND column_name = split_part(what, '.', 2));
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION 'AUTOMATION_POLICY_REMOVAL_LEFT_COLUMNS: %', stale
      USING ERRCODE = 'raise_exception';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_automation_policy') THEN
    RAISE EXCEPTION 'AUTOMATION_POLICY_REMOVAL_LEFT_TYPE: project_automation_policy'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 触发器必须在，而且它盯的列里不能有这一列 —— 它是被 DROP + CREATE 重建的，建错清单不会有任何
  -- 别的东西当场报错，只会在下一次改项目字段时少刷新一次契约。
  SELECT pg_get_triggerdef(t.oid) INTO trigger_list
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'project' AND t.tgname = 'zz_project_completion_contract_project';
  IF trigger_list IS NULL THEN
    RAISE EXCEPTION 'AUTOMATION_POLICY_REMOVAL_LOST_TRIGGER: zz_project_completion_contract_project'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF trigger_list NOT LIKE '%coordinator_enabled%'
     OR trigger_list NOT LIKE '%unbounded_authorized_by%' THEN
    RAISE EXCEPTION 'AUTOMATION_POLICY_REMOVAL_TRIGGER_LOST_COLUMNS: %', trigger_list
      USING ERRCODE = 'raise_exception';
  END IF;
END;
$$;
