-- Design-partner funnel for one self-hosted Orbit: install, runner online, first task, landing,
-- human interventions and return visits, as one JSON row of counts and first-seen times.
-- Read-only. It returns no names, emails, hostnames, repository paths, prompts or message text.
--
-- Run it from the directory that holds Orbit's docker-compose.yml:
--   docker compose exec -T postgres sh -c 'psql -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < scripts/launch-metrics/partner-funnel.sql
--
-- Definitions are in docs/launch-tracking.md. All times are UTC.

begin transaction read only;
set local statement_timeout = '60s';

with
-- A turn a person sent: clients key turns with a UUID, while initial prompts, wakes, shells and
-- coordinator steers use prefixed keys; child sessions only hear from the agent that spawned them.
human_turn as (
  select t.kind, t.created_at, s.task_id is not null as in_task_run
  from conversation_turn t
  join session s on s.id = t.session_id
  where s.parent_session_id is null
    and t.client_turn_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
-- Days on which a person did something in Orbit: started a session by hand, sent a turn,
-- answered an approval, or signed in.
activity as (
  select created_at as at from human_turn
  union all
  select created_at from session where parent_session_id is null and task_id is null
  union all
  select decided_at from approval where decided_by_id is not null and decided_at is not null
  union all
  select created_at from refresh_token
),
active_day as (
  select distinct at::date as day from activity
),
landed as (
  select created_at as at from session_merge_receipt where result in ('MERGED', 'ALREADY_MERGED')
  union all
  select merged_at from session where merged_at is not null
)
select json_build_object(
  'measured_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'install', json_build_object(
    'installed_at', (select min(created_at) from "user"),
    'accounts', (select count(*) from "user")
  ),
  'runner', json_build_object(
    'first_registered_at', (select min(enrolled_at) from runner),
    'registered', (select count(*) from runner),
    'ever_online', (select count(*) from runner where last_heartbeat_at is not null),
    'online_now', (select count(*) from runner where status::text = 'ONLINE'),
    'versions', (select json_agg(distinct version) from runner where version is not null)
  ),
  'first_task', json_build_object(
    'first_session_at', (select min(created_at) from session),
    'first_task_at', (select min(created_at) from task),
    'first_successful_run_at', (select min(finished_at) from session where status::text = 'SUCCEEDED'),
    'sessions', (select count(*) from session),
    'sessions_succeeded', (select count(*) from session where status::text = 'SUCCEEDED'),
    'tasks', (select count(*) from task),
    'tasks_done', (select count(*) from task where status::text = 'DONE')
  ),
  'landing', json_build_object(
    'first_landed_at', (select min(at) from landed),
    'merge_receipts_landed', (select count(*) from session_merge_receipt where result in ('MERGED', 'ALREADY_MERGED')),
    'merge_receipts_conflict', (select count(*) from session_merge_receipt where result = 'CONFLICT'),
    'sessions_merged', (select count(*) from session where merged_at is not null)
  ),
  'human_intervention', json_build_object(
    'approvals_answered_by_a_person', (select count(*) from approval where decided_by_id is not null),
    'approvals_denied_by_a_person', (select count(*) from approval where decided_by_id is not null and status = 'DENIED'),
    'messages_into_task_runs', (select count(*) from human_turn where in_task_run and kind in ('message', 'steer')),
    'interrupts', (select count(*) from human_turn where kind = 'interrupt')
  ),
  'return_visits', json_build_object(
    'first_active_day', (select min(day) from active_day),
    'last_active_day', (select max(day) from active_day),
    'active_days', (select count(*) from active_day),
    'active_days_after_first_week', (select count(*) from active_day where day >= (select min(day) + 7 from active_day)),
    'active_iso_weeks', (select count(distinct date_trunc('week', day)) from active_day)
  )
);

rollback;
