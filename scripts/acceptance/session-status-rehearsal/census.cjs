// The census of docs/session-status-retirement-plan.md §7.2 step 2, read-only: for every session row, the stored word
// against the word the server now sends (legacySessionStatus, sessions/session-legacy-words.ts, the projector itself),
// the wire's runState and sessionState from each (the unchanged derivers of @orbit/shared), the stored phase against
// deriveSessionPhase and the stored turn_state against the word's. One line per (stored word, projected word, end
// reason, last outcome, kind, import marker, filing) with its count. Every line whose words differ must be one of the
// plan's §3.4 kinds (C1-C8), named by its facts below; any other one, or any held row whose word changes, or any
// phase or turn-state disagreement, makes it exit 1: the plan says that stops deploy D2.
//
// Run inside the D2 apiserver image:
//   docker run --rm --network <net> -e DATABASE_URL=... -v <this dir>:/kit:ro <project>-apiserver:d2 node /kit/census.cjs [label]
// Prints one JSON document (and a Markdown table under "markdown").
'use strict';
const path = require('node:path');

const API = '/app/src/apiserver/dist';
const { prismaClientFor } = require(path.join(API, 'prisma/prisma-client.js'));
const { legacySessionStatus } = require(path.join(API, 'sessions/session-legacy-words.js'));
const { deriveSessionPhase } = require(path.join(API, 'sessions/session-phase.js'));
const { deriveSessionRunState, deriveSessionState } = require(require.resolve('@orbit/shared', { paths: [API] }));

const label = process.argv[2] ?? 'census';
const db = prismaClientFor(process.env.DATABASE_URL);

const WORD_TURN_STATE = { PENDING: 'QUEUED', RUNNING: 'IN_FLIGHT', INTERRUPTED: 'ABANDONED' };

/** The §3.4 kind a changed word belongs to, from the facts alone; null when it is none of them. */
function kindOf(row, stored, projected) {
  if (row.finished_at == null) return null; // every held session keeps its word exactly (§3.4)
  const reason = row.end_reason;
  if (stored === 'FAILED' && projected === 'CANCELLED' && reason != null && reason !== 'task_done') return 'C1/C2/C3 (FAILED with an end reason)';
  if (stored === 'FAILED' && projected === 'SUCCEEDED' && reason === 'task_done') return 'C3 (FAILED, task_done)';
  if (stored === 'SUCCEEDED' && projected === 'CANCELLED' && reason == null) return 'C4/C5 (SUCCEEDED, no end)';
  if (stored === 'FAILED' && projected === 'CANCELLED' && reason == null) return 'C6 (cancel with no reason, not honoured)';
  if (stored === 'CANCELLED' && projected === 'SUCCEEDED' && reason === 'task_done' && row.started_at != null) return 'C7 (started, ended queued, task_done)';
  if (stored === 'SUCCEEDED' && projected === 'CANCELLED' && reason === 'completed' && row.last_turn_outcome == null
    && row.kind === 'CONVERSATION' && row.import_source_cwd == null) return 'C8 (SUCCEEDED, completed, no outcome)';
  return null;
}

async function main() {
  const t0 = Date.now();
  const rows = await db.$queryRawUnsafe(`
    SELECT s."id"::text AS id, s."status"::text AS status, s."turn_state", s."phase", s."finished_at", s."end_reason",
           s."last_turn_outcome", s."started_at", s."import_source_cwd", s."kind", s."completed_at", s."archived_at",
           s."deleted_at", s."engine_turn_active", s."running_subagents", s."running_bg_jobs",
           l."settled_at" AS landing_settled_at, l."settled_as" AS landing_settled_as
      FROM "session" s LEFT JOIN "project_landing" l ON l."session_id" = s."id"`);
  const lines = new Map();
  const totals = { rows: rows.length, wordChanged: 0, unlisted: 0, heldChanged: 0, phaseDisagrees: 0, turnStateDisagrees: 0,
    phaseNull: 0, runStateChanged: 0, sessionStateChanged: 0 };
  const byKind = {};
  const samples = [];
  for (const r of rows) {
    const facts = {
      status: r.status, finishedAt: r.finished_at, turnState: r.turn_state, endReason: r.end_reason,
      lastTurnOutcome: r.last_turn_outcome, startedAt: r.started_at, importSourceCwd: r.import_source_cwd,
      sessionKind: r.kind,
    };
    const landing = r.kind === 'LANDING' && r.landing_settled_as != null
      ? { settledAt: r.landing_settled_at, settledAs: r.landing_settled_as } : null;
    const projected = legacySessionStatus(facts, landing);
    const filing = { endReason: r.end_reason, completedAt: r.completed_at, archivedAt: r.archived_at, deletedAt: r.deleted_at };
    const runStored = deriveSessionRunState({ status: r.status, ...filing });
    const runProjected = deriveSessionRunState({ status: projected, ...filing });
    const stateStored = deriveSessionState({ status: r.status, ...filing });
    const stateProjected = deriveSessionState({ status: projected, ...filing });
    const phase = deriveSessionPhase({
      status: r.status, finishedAt: r.finished_at, turnState: r.turn_state, engineTurnActive: r.engine_turn_active,
      runningSubagents: r.running_subagents, runningBgJobs: r.running_bg_jobs,
    });
    const wordTurnState = r.finished_at == null ? WORD_TURN_STATE[r.status] ?? null : null;
    if (r.phase == null) totals.phaseNull++;
    else if (r.phase !== phase) totals.phaseDisagrees++;
    if ((r.turn_state ?? null) !== wordTurnState) totals.turnStateDisagrees++;
    if (runStored !== runProjected) totals.runStateChanged++;
    if (stateStored !== stateProjected) totals.sessionStateChanged++;
    const changed = projected !== r.status || runStored !== runProjected || stateStored !== stateProjected;
    let kind = null;
    if (changed) {
      totals.wordChanged++;
      if (r.finished_at == null) totals.heldChanged++;
      kind = kindOf(r, r.status, projected);
      if (kind == null) {
        totals.unlisted++;
        if (samples.length < 20) samples.push({ id: r.id, ...facts, landing, projected, runStored, runProjected, stateStored, stateProjected });
      } else byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const filed = r.deleted_at ? 'trash' : r.completed_at ?? r.archived_at ? 'completed' : 'open';
    const key = [r.status, projected, runStored, runProjected, stateStored, stateProjected, r.end_reason ?? '', r.last_turn_outcome ?? '',
      r.kind, r.import_source_cwd != null ? 'import' : '', filed, changed ? (kind ?? 'UNLISTED') : ''].join('\t');
    lines.set(key, (lines.get(key) ?? 0) + 1);
  }
  const table = [...lines.entries()].map(([k, rows]) => {
    const [status, projected, runStored, runProjected, stateStored, stateProjected, endReason, outcome, kind, imported, filed, change] = k.split('\t');
    return { status, projected, runStored, runProjected, stateStored, stateProjected, endReason, outcome, kind, imported, filed, change, rows };
  }).sort((a, b) => (a.change === '' ? 1 : 0) - (b.change === '' ? 1 : 0) || b.rows - a.rows);
  const md = ['| stored → sent | runState | sessionState | end reason | outcome | kind | import | filed | §3.4 kind | rows |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...table.map((t) => `| ${t.status}${t.projected !== t.status ? ` → ${t.projected}` : ''} | ${t.runStored}${t.runProjected !== t.runStored ? ` → ${t.runProjected}` : ''} | ${t.stateStored}${t.stateProjected !== t.stateStored ? ` → ${t.stateProjected}` : ''} | ${t.endReason} | ${t.outcome} | ${t.kind} | ${t.imported} | ${t.filed} | ${t.change} | ${t.rows} |`)].join('\n');
  const ok = totals.unlisted === 0 && totals.heldChanged === 0 && totals.phaseDisagrees === 0 && totals.turnStateDisagrees === 0;
  console.log(JSON.stringify({ label, at: new Date().toISOString(), readMs: Date.now() - t0, ok, totals, byKind, unlistedSamples: samples, lines: table, markdown: md }, null, 1));
  return ok;
}

main().then(async (ok) => { await db.$disconnect(); process.exit(ok ? 0 : 1); },
  async (err) => { console.error(err); await db.$disconnect(); process.exit(2); });
