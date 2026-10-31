// The read-only queries every scenario records (stack.sh psql: default_transaction_read_only=on), scoped to one
// project by its title. Rows are internal uuids and full SHAs, so they can be checked against `git log` in the
// stack's bare origins.
const P = (title) => `(select id from project where title = '${title.replace(/'/g, "''")}')`;

// `old`: the 0.1.239 schema (stack b before the deploy) has no delivery_mode, no delivered_* and no observations.
export const projectQueries = (title, { old = false } = {}) => ({
  codebase: [`select canonical_repo_url, integration_ref, upstream_ref, remote_name, ${old ? '' : 'delivery_mode, delivery_mode_chosen_at, '}integration_started_at, merge_check_command
from project_codebase where project_id = ${P(title)}`, false],
  tasks: [`select t.title, t.status, t.auto_run_when_ready as auto_run, ${old ? '' : `t.delivered_sha, t.delivered_base_sha,
  t.delivered_branch, t.delivered_at, `}t.dispatch_refusal, t.created_at
from task t where t.project_id = ${P(title)} order by t.created_at`, true],
  sessions: [`select t.title as task, s.kind, s.status, s.end_reason, s.worktree_branch, s.base_sha, s.branch_sha,
  s.created_at, s.finished_at
from session s join task t on t.id = s.task_id where t.project_id = ${P(title)} order by s.created_at`, true],
  jobs: [`select j.kind, j.generation, j.state, j.phase, t.title as task, j.source_ref, j.source_sha, j.upstream_sha,
  j.target_sha_before, j.error_code, j.error_detail, ${old ? '' : 'j.observations, '}j.receipt_ids, j.retry_of_job_id,
  j.claimed_at, j.finished_at, j.idempotency_key
from project_integration_job j left join project_promotion pp on pp.id = j.promotion_id
  left join task t on t.id = coalesce(j.task_id, pp.task_id)
where j.project_id = ${P(title)} order by j.created_at`, true],
  receipts: [`select t.title as task, r.result, r.source_branch, r.source_sha, r.target_branch, r.target_sha_before,
  r.target_sha_after, r.recorded_by, r.detail, r.created_at
from session_merge_receipt r left join task t on t.id = r.task_id
where r.project_id = ${P(title)} order by r.created_at`, true],
  promotions: [`select t.title as task, p.source_kind, p.state, p.blocked_reason, p.source_ref, p.source_sha,
  p.upstream_sha_checked, p.merged_sha, p.receipt_ids, p.created_at, p.decided_at
from project_promotion p left join task t on t.id = p.task_id
where p.project_id = ${P(title)} order by p.created_at`, true],
  observationEvents: [`select j.generation, e.kind, e.data, e.text, e.created_at
from project_integration_job_event e join project_integration_job j on j.id = e.job_id
where j.project_id = ${P(title)} and j.kind = 'OBSERVE_LANDING' order by e.created_at`, false],
  openItems: [`select i.kind, i.state, i.assignee, i.assignee_reason, t.title as task, i.dedupe_key, i.title, i.payload,
  i.resolution, i.resolved_by, i.resolution_note, i.handling_reason, i.handling_job_id, i.created_at, i.resolved_at
from project_open_item i left join task t on t.id = i.task_id
where i.project_id = ${P(title)} order by i.created_at`, true],
});

/** Append every standard query for one project to the scenario's queries.txt. */
export function dumpProject(ev, title, label, opts = {}) {
  const q = projectQueries(title, opts);
  if (opts.old) delete q.observationEvents;
  for (const [name, [sql, expanded]] of Object.entries(q)) ev.query(`${label} — ${name}`, sql, expanded);
}
