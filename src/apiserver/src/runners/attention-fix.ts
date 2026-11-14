import { Prisma } from '@prisma/client';
import {
  ENGINE_CLI_NAMES,
  isEngine,
  type ReportedEngine,
  type RunnerAgentFix,
  type RunnerAgentFixBlockedCode,
  type RunnerAgentFixing,
  type RunnerAttentionFixKind,
  type RunnerEngineHealth,
  type RunnerSelfUpdate,
} from '@orbit/shared';
import { isReportedEngine, sanitizeRunnerEngines } from '../common/runner-engines';
import { runnerOs } from '../common/runner-platform';
import { signedOutEngineRefusal, type EnginePreflightRunner } from '../sessions/engine-signin-preflight';
import { lastProviderByWorkspace, DEFAULT_AGENT_PROVIDER } from '../workspaces/workspace-provider';
import { runnerIsOnline } from './runner-presence';

/**
 * Fix with an agent (docs/mocks/install-failed-fix-with-agent, and the board on task 34x9udvOf5AQdLYqYE9N4):
 * one press on a machine-side warning starts an ordinary session on that machine, in its most recently
 * used workspace, with that workspace's own defaults and a first message built from the warning's facts.
 *
 * This file answers the questions both doors ask — GET /runners (`agentFix`, which every client draws the
 * button from) and POST /runners/:id/attention/:kind/fix (which acts) — so they cannot disagree.
 */

export const ATTENTION_FIX_KINDS: readonly RunnerAttentionFixKind[] = ['engineNotUpdating', 'cannotSelfUpdate', 'installFailed'];

export function isAttentionFixKind(value: unknown): value is RunnerAttentionFixKind {
  return typeof value === 'string' && (ATTENTION_FIX_KINDS as readonly string[]).includes(value);
}

/** Whether this kind names an engine. */
export function attentionFixNeedsEngine(kind: RunnerAttentionFixKind): boolean {
  return kind !== 'cannotSelfUpdate';
}

/** The key one warning's agent is stored under in `runner.attention_fixes`. */
export function attentionFixKey(kind: RunnerAttentionFixKind, engine: ReportedEngine | null): string {
  return engine && attentionFixNeedsEngine(kind) ? `${kind}:${engine}` : kind;
}

function parseKey(key: string): { kind: RunnerAttentionFixKind; engine: ReportedEngine | null } | null {
  const [kind, engine] = key.split(':');
  if (!isAttentionFixKind(kind)) return null;
  if (!attentionFixNeedsEngine(kind)) return engine === undefined ? { kind, engine: null } : null;
  return isReportedEngine(engine) ? { kind, engine } : null;
}

/** One stored entry: the session a press started, and when. */
export interface AttentionFixEntry {
  sessionId: string;
  at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `runner.attention_fixes` as stored, with anything malformed dropped. */
export function attentionFixEntries(value: unknown): Map<string, AttentionFixEntry> {
  const out = new Map<string, AttentionFixEntry>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!parseKey(key) || !entry || typeof entry !== 'object') continue;
    const { sessionId, at } = entry as Record<string, unknown>;
    if (typeof sessionId !== 'string' || !UUID.test(sessionId) || typeof at !== 'string') continue;
    out.set(key, { sessionId, at });
  }
  return out;
}

/** The statuses a session has once it is over: its agent is no longer at work on anything. */
const OVER_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/** A session that is open: not over, completed or deleted. Ended sessions free the warning for a new press. */
export const OPEN_FIX_SESSION = {
  deletedAt: null,
  completedAt: null,
  archivedAt: null,
  status: { notIn: [...OVER_STATUSES] },
} satisfies Prisma.SessionWhereInput;

/** How long a stored entry whose session was never written still holds the warning: a press whose
 *  create is still in flight. After that it is a create that failed without clearing it. */
export const PENDING_FIX_HOLD_MS = 2 * 60_000;

/** The engine's name as every client shows it. */
export function engineDisplayName(engine: string): string {
  return isEngine(engine) ? ENGINE_CLI_NAMES[engine] : engine;
}

/** The machine as the prompt and the title name it: what Orbit calls it. */
export function machineName(runner: { displayName?: string | null; name?: string | null; hostname?: string | null }): string {
  return runner.displayName?.trim() || runner.name?.trim() || runner.hostname?.trim() || 'this machine';
}

/** The fields of the runner row these rules read. */
export const AGENT_FIX_RUNNER_SELECT = {
  id: true,
  name: true,
  displayName: true,
  hostname: true,
  status: true,
  lastHeartbeatAt: true,
  presence: { select: { lastBeatAt: true } },
  engines: true,
  accountNames: true,
  accountPauses: true,
  defaultRemoved: true,
  planUsage: true,
  capabilities: true,
  version: true,
  runsAsRoot: true,
  selfUpdate: true,
  installStatus: true,
  installEngine: true,
  installCommand: true,
  installMessage: true,
  attentionFixes: true,
} as const satisfies Prisma.RunnerSelect;

export type AgentFixRunner = Prisma.RunnerGetPayload<{ select: typeof AGENT_FIX_RUNNER_SELECT }>;

const WORKSPACE_SELECT = {
  id: true,
  name: true,
  env: true,
  codexAccount: true,
  claudeAccount: true,
  antigravityAccount: true,
  kimiAccount: true,
  cursorAccount: true,
} as const satisfies Prisma.WorkspaceSelect;

type FixWorkspace = Prisma.WorkspaceGetPayload<{ select: typeof WORKSPACE_SELECT }>;

/**
 * Each runner's most recently used workspace: of the live, enabled workspaces that live on it, the one
 * whose newest session is newest; one that never ran a session counts by when it was made, after every
 * one that did.
 */
export async function mostRecentWorkspaces(
  prisma: Prisma.TransactionClient,
  ownerId: string,
  runnerIds: string[],
): Promise<Map<string, FixWorkspace>> {
  const out = new Map<string, FixWorkspace>();
  if (runnerIds.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ runner_id: string; id: string }>>(Prisma.sql`
    SELECT DISTINCT ON (w.runner_id) w.runner_id::text AS runner_id, w.id::text AS id
      FROM "workspace" w
      LEFT JOIN LATERAL (
        SELECT s.created_at FROM "session" s
         WHERE s.workspace_id = w.id
         ORDER BY s.created_at DESC
         LIMIT 1
      ) last ON true
     WHERE w.runner_id = ANY(${runnerIds}::uuid[])
       AND w.owner_id = ${ownerId}::uuid
       AND w.deleted_at IS NULL
       AND w.enabled
     ORDER BY w.runner_id, last.created_at DESC NULLS LAST, w.created_at DESC, w.id`);
  if (rows.length === 0) return out;
  const workspaces = await prisma.workspace.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: WORKSPACE_SELECT });
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  for (const row of rows) {
    const workspace = byId.get(row.id);
    if (workspace) out.set(row.runner_id, workspace);
  }
  return out;
}

export const AGENT_FIX_OFFLINE = 'This machine is offline.';
export const AGENT_FIX_NO_WORKSPACE = 'No workspace runs on this machine yet.';
export function agentFixSignedOut(workspace: string, engineName: string): string {
  return `An agent can't run here: ${workspace} uses ${engineName}, which is signed out on this machine.`;
}

function blocked(code: RunnerAgentFixBlockedCode, message: string): RunnerAgentFix['blocked'] {
  return { code, message };
}

/**
 * Where a press on each runner would start its session, or why it can't, and the agents already at
 * work there. `nowMs` is the moment both online and the pending hold are judged at.
 */
export async function agentFixesOf(
  prisma: Prisma.TransactionClient,
  ownerId: string,
  runners: AgentFixRunner[],
  nowMs: number = Date.now(),
): Promise<Map<string, RunnerAgentFix>> {
  const out = new Map<string, RunnerAgentFix>();
  if (runners.length === 0) return out;
  const workspaces = await mostRecentWorkspaces(prisma, ownerId, runners.map((r) => r.id));
  const seeds = await lastProviderByWorkspace(prisma, [...workspaces.values()].map((w) => w.id));
  const fixing = await openFixesOf(prisma, ownerId, runners);
  for (const runner of runners) {
    const workspace = workspaces.get(runner.id) ?? null;
    const seed = workspace ? seeds.get(workspace.id) ?? DEFAULT_AGENT_PROVIDER : null;
    const engine = seed?.engine ?? null;
    const engineName = engine ? engineDisplayName(engine) : null;
    let verdict: RunnerAgentFix['blocked'] = null;
    if (!runnerIsOnline(runner, nowMs)) verdict = blocked('offline', AGENT_FIX_OFFLINE);
    else if (!workspace) verdict = blocked('noWorkspace', AGENT_FIX_NO_WORKSPACE);
    else if (engine && seed) {
      const refusal = signedOutEngineRefusal({
        runtime: engine,
        bringsOwnCredentials: !seed.providerBuiltin,
        workspaceEnv: workspace.env,
        accounts: workspace,
        runner: runner as unknown as EnginePreflightRunner,
        nowMs,
      });
      if (refusal) verdict = blocked('engineSignedOut', agentFixSignedOut(workspace.name, engineName ?? engine));
    }
    out.set(runner.id, {
      workspaceId: workspace?.id ?? null,
      workspaceName: workspace?.name ?? null,
      engine,
      engineName,
      blocked: verdict,
      fixing: fixing.get(runner.id) ?? [],
    });
  }
  return out;
}

/** The warnings with an open session at work on them, per runner. */
async function openFixesOf(
  prisma: Prisma.TransactionClient,
  ownerId: string,
  runners: Array<Pick<AgentFixRunner, 'id' | 'attentionFixes'>>,
): Promise<Map<string, RunnerAgentFixing[]>> {
  const out = new Map<string, RunnerAgentFixing[]>();
  const wanted = runners.flatMap((runner) =>
    [...attentionFixEntries(runner.attentionFixes)].map(([key, entry]) => ({ runnerId: runner.id, key, entry })),
  );
  if (wanted.length === 0) return out;
  const sessions = await prisma.session.findMany({
    where: { id: { in: wanted.map((w) => w.entry.sessionId) }, ownerId, ...OPEN_FIX_SESSION },
    select: { id: true, workspaceId: true, workspace: { select: { name: true } } },
  });
  const open = new Map(sessions.map((s) => [s.id, s]));
  for (const { runnerId, key, entry } of wanted) {
    const session = open.get(entry.sessionId);
    if (!session?.workspaceId) continue;
    const parsed = parseKey(key)!;
    const list = out.get(runnerId) ?? [];
    list.push({ ...parsed, sessionId: session.id, workspaceId: session.workspaceId, workspaceName: session.workspace?.name ?? '' });
    out.set(runnerId, list);
  }
  return out;
}

/** Whether a stored entry still holds its warning: its session is open, or its create is still in flight. */
export async function entryHolds(
  prisma: Prisma.TransactionClient,
  ownerId: string,
  entry: AttentionFixEntry | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!entry) return false;
  const session = await prisma.session.findFirst({ where: { id: entry.sessionId, ownerId }, select: { id: true } });
  if (!session) return nowMs - Date.parse(entry.at) < PENDING_FIX_HOLD_MS;
  const open = await prisma.session.count({ where: { id: entry.sessionId, ownerId, ...OPEN_FIX_SESSION } });
  return open > 0;
}

// MARK: the first message

/** Each engine's own update command, as the runner runs it (src/runner-go/doctor.go updateCmd). */
const ENGINE_UPDATE_COMMANDS: Partial<Record<ReportedEngine, string>> = {
  claude: 'claude update',
  codex: 'codex update',
  opencode: 'opencode upgrade',
};

/** Each engine's own binary, for "tell me what `<cli> --version` reports". */
const ENGINE_BINARIES: Partial<Record<ReportedEngine, string>> = {
  claude: 'claude',
  codex: 'codex',
  kimi: 'kimi',
  antigravity: 'agy',
  opencode: 'opencode',
  cursor: 'cursor-agent',
};

const OS_NAMES: Record<string, string> = { linux: 'Linux', darwin: 'macOS', windows: 'Windows' };

/** A version as the runner reports it ("codex-cli 0.159.2", "2.1.290 (Claude Code)") cut to the number. */
export function bareVersion(reported: string | null | undefined): string | null {
  const match = reported?.match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : reported?.trim() || null;
}

/** The runner's words, quoted on one line: whitespace folded, at most 600 characters. */
function quoted(words: string | null | undefined): string | null {
  const folded = words?.replace(/\s+/g, ' ').trim();
  if (!folded) return null;
  return folded.length > 600 ? `${folded.slice(0, 599)}…` : folded;
}

/** What the warning was, for the title and the first message; null when the runner no longer reports it. */
export interface AttentionFixPrompt {
  title: string;
  prompt: string;
}

const CARE = 'Ask me before installing packages or changing system files.';

export function engineNotUpdatingPrompt(
  runner: Pick<AgentFixRunner, 'name' | 'displayName' | 'hostname'>,
  engine: ReportedEngine,
  health: RunnerEngineHealth | undefined,
  nowMs: number,
): AttentionFixPrompt | null {
  const update = health?.update;
  if (!health?.installed || !update) return null;
  const machine = machineName(runner);
  const name = engineDisplayName(engine);
  const current = bareVersion(health.version);
  const latest = update.latest ?? null;
  const since = update.behindSince ?? update.okAt;
  const days = since ? Math.floor((nowMs - Date.parse(since)) / 86_400_000) : NaN;
  const sentences: string[] = [];
  sentences.push(
    Number.isFinite(days) && days >= 1
      ? `${name} on this machine (${machine}) has not updated for ${days} ${days === 1 ? 'day' : 'days'}.`
      : `${name} on this machine (${machine}) is not updating.`,
  );
  const command = ENGINE_UPDATE_COMMANDS[engine];
  const runs = command ? `Orbit runs \`${command}\` every 30 min` : `Orbit tries to update ${name} every 30 min`;
  const move = current && latest ? `, ${current} → ${latest},` : latest ? ` to ${latest}` : '';
  const said = quoted(update.message);
  if (update.status === 'failed') {
    sentences.push(`${runs}; the last attempt${move} failed${said ? ` with: "${said}"` : ''}.`);
  } else if (update.status === 'skipped') {
    sentences.push(`${runs}; the last attempt${move} was skipped${said ? `: "${said}"` : ''}.`);
  } else {
    sentences.push(`${runs}; the last attempt${move} reported success, but this machine still runs ${current ?? 'an older version'}.`);
  }
  return {
    title: `Fix: ${name} update failed on ${machine}`,
    prompt:
      `${sentences.join(' ')}\n\n` +
      `Find out why on this machine and fix it. ${CARE} ` +
      `When you are done, run \`orbit engine-update\` and tell me what version ${name} reports.`,
  };
}

export function cannotSelfUpdatePrompt(
  runner: Pick<AgentFixRunner, 'name' | 'displayName' | 'hostname' | 'version' | 'runsAsRoot'>,
  report: RunnerSelfUpdate | null,
  latestFromClient: string | null,
): AttentionFixPrompt | null {
  const machine = machineName(runner);
  const version = runner.version?.trim() || null;
  const latest = report?.targetVersion ?? latestFromClient;
  const behind = latest ? `, behind ${latest}` : '';
  const to = latest ? ` to ${latest}` : '';
  const head = `Orbit's runner on this machine (${machine}) is on ${version ?? 'an older version'}${behind}`;
  let title: string;
  let facts: string;
  switch (report?.state) {
    case 'failed':
      title = `Fix: Orbit runner update failed on ${machine}`;
      facts = `${head}, and its last attempt to update itself${to} failed${quoted(report.reason) ? ` with: "${quoted(report.reason)}"` : ''}.`;
      break;
    case 'disabledByEnv':
      title = `Fix: Orbit runner updates are turned off on ${machine}`;
      facts = `${head}, and its updates are turned off${quoted(report.reason) ? `: "${quoted(report.reason)}"` : ''}.`;
      break;
    case 'dirNotWritable':
      title = `Fix: Orbit runner can't update itself on ${machine}`;
      facts = `${head}, and it can't update itself: the user it runs as can't write its install folder${report.installDir ? ` (${report.installDir})` : ''}.`;
      break;
    default:
      if (report || runner.runsAsRoot !== false) return null;
      title = `Fix: Orbit runner can't update itself on ${machine}`;
      facts = `${head}, and it can't update itself: it runs as a regular user, which can't replace its own binary.`;
  }
  return {
    title,
    prompt:
      `${facts}\n\n` +
      `Find out why on this machine and fix it. ${CARE} This session runs on that runner, so tell me before ` +
      `anything restarts it. When you are done, tell me what \`orbit --version\` reports.`,
  };
}

export function installFailedPrompt(
  runner: Pick<AgentFixRunner, 'name' | 'displayName' | 'hostname' | 'capabilities' | 'installStatus' | 'installEngine' | 'installCommand' | 'installMessage'>,
  engine: ReportedEngine,
): AttentionFixPrompt | null {
  if (runner.installStatus !== 'failed' || runner.installEngine !== engine) return null;
  const machine = machineName(runner);
  const os = runnerOs(runner.capabilities);
  const where = os ? `${machine}, ${OS_NAMES[os] ?? os}` : machine;
  const name = engineDisplayName(engine);
  const command = runner.installCommand?.trim();
  const said = quoted(runner.installMessage);
  const ran = command ? ` by running \`${command}\`` : '';
  const binary = ENGINE_BINARIES[engine];
  return {
    title: `Fix: ${name} install failed on ${machine}`,
    prompt:
      `Orbit tried to install ${name} on this machine (${where})${ran}, and it failed${said ? ` with: "${said}"` : ''}. ` +
      `Find out why and get ${name} installed. Ask me before installing system packages or changing system files. ` +
      `When you're done, re-run Orbit's install for ${name} on this machine (the runner_engine_install tool) so the ` +
      `machine page shows the result, and tell me what ${binary ? `\`${binary} --version\`` : 'its version command'} reports.`,
  };
}

/** The first message for `kind` on this runner, from what it reports now; null when it reports no such warning. */
export function attentionFixPrompt(
  runner: AgentFixRunner,
  kind: RunnerAttentionFixKind,
  engine: ReportedEngine | null,
  latestFromClient: string | null,
  nowMs: number,
  selfUpdate: RunnerSelfUpdate | null,
): AttentionFixPrompt | null {
  switch (kind) {
    case 'engineNotUpdating':
      return engine
        ? engineNotUpdatingPrompt(runner, engine, sanitizeRunnerEngines(runner.engines)?.find((e) => e.engine === engine), nowMs)
        : null;
    case 'installFailed':
      return engine ? installFailedPrompt(runner, engine) : null;
    case 'cannotSelfUpdate':
      return cannotSelfUpdatePrompt(runner, selfUpdate, latestFromClient);
  }
}
