// The read-only queries every run records (stack.sh psql: default_transaction_read_only=on), scoped to one project by
// its title. Rows carry internal uuids and full SHAs, so they can be checked against `git log` in the bare origins.
import { sessionWordSql } from '../../lib/session-word.mjs';

export const P = (title) => `(select id from project where title = '${title.replace(/'/g, "''")}')`;

export const projectQueries = (title) => ({
  codebase: [`select canonical_repo_url, integration_ref, upstream_ref, integration_started_at, merge_check_command,
  landing_check_command, landing_check_none, landing_check_set_by, landing_check_set_by_session_id, landing_check_set_at
from project_codebase where project_id = ${P(title)}`, true],
  tasks: [`select t.title, t.status, t.delivered_sha, t.delivered_base_sha, (t.delivered_sha = t.delivered_base_sha) as no_commit,
  t.landing_check_exempt, t.landing_check_exempt_reason, t.landing_check_exempt_by_session_id, t.codeless, t.created_at
from task t where t.project_id = ${P(title)} order by t.title`, true],
  sessions: [`select t.title as task, ${sessionWordSql('s')} as status, s.end_reason, s.worktree_branch, s.base_sha, s.branch_sha, s.changed_files,
  s.dispatch_origin, s.run_source, s.created_at, s.finished_at
from session s join task t on t.id = s.task_id where t.project_id = ${P(title)} order by s.created_at`, true],
  jobs: [`select j.kind, j.generation, j.state, t.title as task, j.source_ref, j.source_sha, j.target_ref, j.target_sha_before,
  j.tested_sha, j.landed_sha, j.error_code, j.checks, j.receipt_ids, j.confirmed_automatically, j.skip_merge_check,
  j.claimed_at, j.finished_at
from project_integration_job j left join project_promotion pp on pp.id = j.promotion_id
  left join task t on t.id = coalesce(j.task_id, pp.task_id)
where j.project_id = ${P(title)} order by j.created_at`, true],
  receipts: [`select t.title as task, r.result, r.source_branch, r.source_sha, r.target_branch, r.target_sha_before,
  r.target_sha_after, r.recorded_by, r.created_at
from session_merge_receipt r left join task t on t.id = r.task_id
where r.project_id = ${P(title)} order by r.created_at`, true],
  promotions: [`select p.source_kind, p.state, p.blocked_reason, p.source_ref, p.source_sha, p.upstream_sha_checked,
  p.merged_sha, p.receipt_ids, p.created_at, p.decided_at
from project_promotion p where p.project_id = ${P(title)} order by p.created_at`, true],
  settingChanges: [`select c.field, t.title as task, c.origin, c.old_value, c.new_value, c.reason, c.written_by_session_id,
  c.reverts_change_id, c.created_at
from project_setting_change c left join task t on t.id = c.task_id
where c.project_id = ${P(title)} order by c.created_at`, true],
  openItems: [`select i.kind, i.state, i.assignee, t.title as task, i.title, i.resolution, i.created_at, i.resolved_at
from project_open_item i left join task t on t.id = i.task_id
where i.project_id = ${P(title)} order by i.created_at`, true],
});

/** Append every standard query for one project to the scenario's queries.txt. */
export function dumpProject(ev, title, label) {
  for (const [name, [sql, expanded]] of Object.entries(projectQueries(title))) ev.query(`${label} — ${name}`, sql, expanded);
}
