-- Database objects that depend on the values of session.status (type run_status) or on
-- session.end_reason, read from the catalog of a migrated database. Read-only: SELECTs only.
--
-- Used by plan step 0.4 (docs/session-three-state-plan.md) to check appendix section A of
-- docs/session-three-state-read-sites.md, and re-run by step 4.4. Run it against a throwaway
-- database with every migration applied:
--
--   psql "$DATABASE_URL" -X -At -F ' | ' -v ON_ERROR_STOP=1 -f scripts/session-status-db-objects.sql
--
-- Every result set starts with a section name and is ordered, so two runs compare with diff.
--
-- Sections 1 to 9 are the column and type being retired (docs/session-status-retirement-plan.md): they read the catalog
-- only, through to_regtype, so they still run once deploy 4 has dropped them, and then report nothing of the type.
-- Sections 10 to 13 are the facts that replace them. No section reads a session row.

-- 1. The run_status type: its labels and every column of that type.
SELECT '1 enum' AS section, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
  FROM pg_enum e
 WHERE e.enumtypid = to_regtype('public.run_status');

SELECT '1 column' AS section, c.relname, c.relkind, a.attname,
       pg_get_expr(d.adbin, d.adrelid) AS default_expr
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE a.atttypid = to_regtype('public.run_status') AND NOT a.attisdropped
 ORDER BY c.relkind DESC, c.relname, a.attname;

-- 2. Everything the catalog records as depending on session.status, session.end_reason or the
--    run_status type (indexes, constraints, views, rules, generated columns, trigger column
--    lists). Function bodies are not tracked here; section 3 reads them.
SELECT '2 depends' AS section, pg_describe_object(dep.classid, dep.objid, dep.objsubid) AS object,
       pg_describe_object(dep.refclassid, dep.refobjid, dep.refobjsubid) AS depends_on
  FROM pg_depend dep
 WHERE dep.deptype <> 'i'
   AND ((dep.refclassid = 'pg_class'::regclass AND dep.refobjid = 'public.session'::regclass
         AND dep.refobjsubid IN (SELECT attnum FROM pg_attribute
                                  WHERE attrelid = 'public.session'::regclass
                                    AND attname IN ('status', 'end_reason')))
        OR (dep.refclassid = 'pg_type'::regclass AND dep.refobjid = to_regtype('public.run_status')))
 ORDER BY 2, 3;

-- 3. Functions whose body names a run_status value, run_status or end_reason, and that are
--    about sessions: a trigger on session runs them, or the body reads the session table.
--    Literals cast to task_status are task values and are not counted. Each matching line is
--    printed with its line number in pg_get_functiondef.
WITH fn AS (
  SELECT p.oid, p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
), hit AS (
  SELECT fn.*
    FROM fn
   WHERE (regexp_replace(def, '''[A-Z_]+''::"?task_status"?', '', 'g')
            ~ '''(PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED|AWAITING_INPUT|INTERRUPTED|PARKED)'''
          OR def ~* 'run_status|end_reason')
     AND (EXISTS (SELECT 1 FROM pg_trigger t
                   WHERE t.tgfoid = fn.oid AND t.tgrelid = 'public.session'::regclass
                     AND NOT t.tgisinternal)
          OR def ~ '(FROM|JOIN)\s+"?session"?(\s|$)')
)
SELECT '3 function' AS section, h.proname, l.n AS line, btrim(l.text) AS text
  FROM hit h
 CROSS JOIN LATERAL regexp_split_to_table(h.def, E'\n') WITH ORDINALITY AS l(text, n)
 WHERE btrim(l.text) !~ '^--'
   AND (regexp_replace(l.text, '''[A-Z_]+''::"?task_status"?', '', 'g')
          ~ '''(PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED|AWAITING_INPUT|INTERRUPTED|PARKED)'''
        OR l.text ~* 'run_status|end_reason|"status"::text')
 ORDER BY 2, 3;

-- 4. Triggers on session that name status or end_reason (column list or WHEN clause), and
--    every trigger, on any table, that runs a function from section 3.
WITH fn AS (
  SELECT p.oid, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
), hit AS (
  SELECT fn.oid
    FROM fn
   WHERE (regexp_replace(def, '''[A-Z_]+''::"?task_status"?', '', 'g')
            ~ '''(PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED|AWAITING_INPUT|INTERRUPTED|PARKED)'''
          OR def ~* 'run_status|end_reason')
     AND (EXISTS (SELECT 1 FROM pg_trigger t
                   WHERE t.tgfoid = fn.oid AND t.tgrelid = 'public.session'::regclass
                     AND NOT t.tgisinternal)
          OR def ~ '(FROM|JOIN)\s+"?session"?(\s|$)')
)
SELECT '4 trigger' AS section, t.tgrelid::regclass AS on_table, t.tgname, p.proname,
       pg_get_triggerdef(t.oid) AS def
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal
   AND ((t.tgrelid = 'public.session'::regclass
         AND pg_get_triggerdef(t.oid) ~ '\m(status|end_reason)\M')
        OR t.tgfoid IN (SELECT oid FROM hit))
 ORDER BY t.tgrelid::regclass::text, t.tgname;

-- 5. Indexes on session that name status or end_reason (key or predicate), and any index
--    elsewhere that names run_status.
SELECT '5 index' AS section, i.indrelid::regclass AS on_table, i.indexrelid::regclass AS index,
       i.indpred IS NOT NULL AS partial, pg_get_indexdef(i.indexrelid) AS def
  FROM pg_index i
 WHERE (i.indrelid = 'public.session'::regclass
        AND pg_get_indexdef(i.indexrelid) ~ '\m(status|end_reason)\M')
    OR pg_get_indexdef(i.indexrelid) ~ 'run_status'
 ORDER BY i.indrelid::regclass::text, i.indexrelid::regclass::text;

-- 6. CHECK constraints on session that name status or end_reason, and any that name run_status.
SELECT '6 check' AS section, c.conrelid::regclass AS on_table, c.conname,
       pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
 WHERE c.contype = 'c'
   AND ((c.conrelid = 'public.session'::regclass
         AND pg_get_constraintdef(c.oid) ~ '\m(status|end_reason)\M')
        OR pg_get_constraintdef(c.oid) ~ 'run_status')
 ORDER BY c.conrelid::regclass::text, c.conname;

-- 7. Views and materialized views whose definition reads session status or end_reason.
SELECT '7 view' AS section, c.oid::regclass AS view, c.relkind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
   AND pg_get_viewdef(c.oid) ~* 'run_status|end_reason|session[^\n]*\mstatus\M'
 ORDER BY c.oid::regclass::text;

-- 8. Generated columns whose expression names status, end_reason or run_status.
SELECT '8 generated' AS section, a.attrelid::regclass AS on_table, a.attname,
       pg_get_expr(d.adbin, d.adrelid) AS expr
  FROM pg_attribute a
  JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE a.attgenerated <> ''
   AND pg_get_expr(d.adbin, d.adrelid) ~* 'run_status|end_reason|\mstatus\M'
 ORDER BY a.attrelid::regclass::text, a.attname;

-- 9. Counts, one row, so a re-run reads at a glance and an empty section 6-8 still shows as 0.
SELECT '9 counts' AS section,
  (SELECT count(*) FROM pg_attribute WHERE atttypid = to_regtype('public.run_status')
      AND NOT attisdropped
      AND attrelid IN (SELECT oid FROM pg_class WHERE relkind = 'r')) AS table_columns,
  (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal
      AND t.tgrelid = 'public.session'::regclass
      AND pg_get_triggerdef(t.oid) ~ '\m(status|end_reason)\M') AS session_triggers_naming_status,
  (SELECT count(*) FROM pg_index i WHERE i.indrelid = 'public.session'::regclass
      AND pg_get_indexdef(i.indexrelid) ~ '\m(status|end_reason)\M') AS session_indexes,
  (SELECT count(*) FROM pg_index i WHERE i.indrelid = 'public.session'::regclass
      AND i.indpred IS NOT NULL
      AND pg_get_expr(i.indpred, i.indrelid) ~ '\m(status|end_reason)\M') AS session_partial_indexes,
  (SELECT count(*) FROM pg_constraint c WHERE c.contype = 'c'
      AND ((c.conrelid = 'public.session'::regclass
            AND pg_get_constraintdef(c.oid) ~ '\m(status|end_reason)\M')
           OR pg_get_constraintdef(c.oid) ~ 'run_status')) AS checks,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
      AND pg_get_viewdef(c.oid) ~* 'run_status|end_reason|session[^\n]*\mstatus\M') AS views,
  (SELECT count(*) FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attgenerated <> ''
      AND pg_get_expr(d.adbin, d.adrelid) ~* 'run_status|end_reason|\mstatus\M') AS generated_columns;

-- 10. The columns that replace session.status.
SELECT '10 fact column' AS section, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull
  FROM pg_attribute a
 WHERE a.attrelid = 'public.session'::regclass AND a.attname IN ('turn_state', 'phase') AND NOT a.attisdropped
 ORDER BY a.attname;

-- 11. Triggers on session that name turn_state or phase (column list or WHEN clause), and its CHECK constraints that do.
SELECT '11 fact trigger' AS section, t.tgname, p.proname, pg_get_triggerdef(t.oid) AS def
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal AND t.tgrelid = 'public.session'::regclass
   AND pg_get_triggerdef(t.oid) ~ '\m(turn_state|phase)\M'
 ORDER BY t.tgname;

SELECT '11 fact check' AS section, c.conname, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
 WHERE c.contype = 'c' AND c.conrelid = 'public.session'::regclass
   AND pg_get_constraintdef(c.oid) ~ '\m(turn_state|phase)\M'
 ORDER BY c.conname;

-- 12. Indexes on session that name turn_state or phase (key or predicate).
SELECT '12 fact index' AS section, i.indexrelid::regclass AS index, i.indpred IS NOT NULL AS partial,
       pg_get_indexdef(i.indexrelid) AS def
  FROM pg_index i
 WHERE i.indrelid = 'public.session'::regclass AND pg_get_indexdef(i.indexrelid) ~ '\m(turn_state|phase)\M'
 ORDER BY i.indexrelid::regclass::text;

-- 13. Functions whose body names turn_state or phase of a session, and the ones that derive them or the legacy word.
SELECT '13 fact function' AS section, p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
   AND (pg_get_functiondef(p.oid) ~ '\mturn_state\M' OR p.proname IN ('session_phase_of', 'session_phase_from_facts'))
 ORDER BY p.proname, 3;
