import { ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import {
  AgentProvider,
  type AgentExecConfig,
  PermissionMode,
  RunEventType,
  type RemoteSubagentEvent,
  SUBAGENT_REMOTE_IN_PLACE_V1,
  type SubagentAttempt,
  type SubagentCandidateTarget,
  type SubagentDecision,
  type SubagentRunCreateRequest,
  type SubagentWorkspaceChoice,
} from '@orbit/shared';
import { Prisma } from '@prisma/client';
import {
  ALWAYS_ALLOWED_TOOLS,
  isWiderThanParent,
  runningPermissionMode,
  subagentChildMode,
} from '../common/permission-mode';
import { dispatchAllowedTools } from '../common/permission-rules';
import { normalizeEffortForRuntimeModel } from '../common/runtime-provider';
import { claimPermissionMode } from '../queue/claim-permission-mode';
import { isBuiltinProvider, resolveProviderExec } from '../providers/custom-provider';
import { dispatchKeyRow } from '../providers/engine-provider';
import { runAccessLevel, scheduleRunDisallowedTools } from '../schedules/schedule-access';
import type { PrismaService } from '../prisma/prisma.service';
import { RUNNER_PRESENCE, runnerIsOnline, runnerOfflineSql } from '../runners/runner-presence';
import { routeSubagent, subagentCandidateRefusal, subagentRunnableModels } from '../tasks/model-routing';
import { engineState, taskRouteReads } from '../tasks/task-route-decision';
import { normalizeRepoUrl } from '../wiki/wiki.service';
import { agentProviderSeed } from '../workspaces/workspace-provider';
import { stripNul } from './strip-nul';
import { appliedDecision, fallbackCandidates, noProviderMessage } from './subagent-run';
import { subagentRouteInput, type SubagentPlanUsageReader } from './subagent-route';
import { sessionReleasedSql } from '../common/session-release';
import { assertEngineSession } from '../sessions/engine-session';

/**
 * Cross-workspace SubAgents (docs/subagent-design.md §10): a delegate call that runs on another workspace of the
 * owner's account, on that workspace's own runner, and returns text only.
 *
 *   - Which workspace (§10.1): the one the call names, or, for `needs`, the owner's enabled workspaces of the
 *     parent's repository whose runner is online and reports every needed capability, the one with the most quota
 *     headroom first, then the Agents list's order; otherwise the parent's own machine.
 *   - What it runs on (§10.3, planRemoteSubagent): judged on the target runner's engines, logins and quota — a named
 *     model as named or refused, else the target workspace's default engine while it is usable, else routed there.
 *   - The hand-over (§10.2): the run is written with `target_runner_id`, that runner's heartbeat lists it, and the
 *     runner claims it for the candidate the run was opened on, in the shape a session claim has.
 *   - The events (§10.3): only the target runner may relay them. They are stored rewritten — nested under the
 *     delegate call, child tool ids prefixed with the run id — and the parent's runner emits them into the parent's
 *     stream, which only it numbers.
 */

/** Why a workspace can or cannot take a SubAgent, as the refusals and the decision's reason say it. */
interface WorkspaceCandidate {
  id: string;
  name: string;
  runnerId: string | null;
  workDir: string | null;
  inPlace: boolean;
  /** What it lacks, English; empty when it can run the SubAgent. */
  lacks: string[];
  /** Quota headroom of its default engine's account, in percent left; null when unknown. */
  headroom: number | null;
}

export type SubagentWorkspacePick =
  | { kind: 'local'; reason: string | null }
  | {
    kind: 'remote';
    /** inPlace: its work dir is not a git repository, so the read-only run goes in the work dir itself (§10.2). */
    workspace: { id: string; name: string; runnerId: string; workDir: string | null; inPlace: boolean };
    reason: string;
  };

const CANDIDATE_SELECT = {
  id: true,
  name: true,
  enabled: true,
  repoUrl: true,
  workDir: true,
  workDirIsGit: true,
  subagentsEnabled: true,
  runnerId: true,
  runner: { select: { id: true, status: true, capabilities: true, lastHeartbeatAt: true, presence: { select: RUNNER_PRESENCE } } },
} satisfies Prisma.WorkspaceSelect;
type CandidateRow = Prisma.WorkspaceGetPayload<{ select: typeof CANDIDATE_SELECT }>;

function refusal(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

/** The repository a workspace works on, as one codebase is compared with another; null when it names none. */
function repoOf(url: string | null | undefined): string | null {
  const trimmed = (url ?? '').trim();
  return trimmed ? normalizeRepoUrl(trimmed) : null;
}

/** The needed capabilities, trimmed, without blanks or repeats. */
export function neededCapabilities(needs: readonly string[] | undefined): string[] {
  return [...new Set((needs ?? []).map((need) => need.trim()).filter(Boolean))];
}

/**
 * The refusal for a SubAgent that may change files, handed to a workspace whose work dir is not a git repository
 * (§10.2). It names the ways that leave that directory as it is, and warns off the one that does not: `git init` and a
 * first commit would change it, and commit whatever it holds, its secrets included.
 */
export function notGitRefusal(name: string): HttpException {
  return refusal(
    HttpStatus.CONFLICT,
    'SUBAGENT_WORKSPACE_NOT_GIT',
    `${name}'s work directory is not a git repository. A SubAgent that may change files runs in a worktree of its own, ` +
      `so it cannot run there; a read-only one (type "explore", or a definition with readonly: true) runs in the work ` +
      `directory itself. Delegate the work as read-only, or open a session on ${name}. Do not make that directory a git ` +
      'repository to get round this: git init and a first commit change it, and commit whatever it holds, secrets included.',
  );
}

/** Why a target runner cannot run a read-only SubAgent in a work dir that is not a git repository; null when it can. */
function inPlaceLack(row: Pick<CandidateRow, 'runner'>): string | null {
  return row.runner?.capabilities?.includes(SUBAGENT_REMOTE_IN_PLACE_V1)
    ? null
    : 'its work directory is not a git repository, and its runner is too old to run a read-only SubAgent in it';
}

/** What one workspace lacks for this SubAgent, English, in the order a person would fix them. */
function lacksOf(row: CandidateRow, needs: readonly string[], readonly: boolean, now: number): string[] {
  const lacks: string[] = [];
  if (row.workDirIsGit === false && !readonly) lacks.push('its work directory is not a git repository, and the SubAgent may change files');
  if (!row.subagentsEnabled) lacks.push('SubAgents are turned off for it');
  if (!row.runner || !runnerIsOnline(row.runner, now)) lacks.push('its runner is offline');
  else {
    const reported = new Set(row.runner.capabilities ?? []);
    const missing = needs.filter((need) => !reported.has(need));
    if (missing.length) lacks.push(`its runner does not report ${missing.join(', ')}`);
    const inPlace = row.workDirIsGit === false && readonly ? inPlaceLack(row) : null;
    if (inPlace) lacks.push(inPlace);
  }
  return lacks;
}

/** Percent left on the account the workspace's default engine would run on; null when that is not known. */
async function headroomOf(db: Prisma.TransactionClient, ownerId: string, workspaceId: string, now: Date): Promise<number | null> {
  const reads = taskRouteReads(db as unknown as PrismaService, ownerId, now);
  const [agent, seed] = await Promise.all([reads.workspace(workspaceId), reads.seed(workspaceId)]);
  if (!agent?.runnerId) return null;
  const runner = await reads.runner(agent.runnerId);
  if (!runner) return null;
  const engine = seed.engine;
  if (engine !== AgentProvider.CLAUDE && engine !== AgentProvider.CODEX) return null;
  const quota = engineState(engine, agent, runner, now).quota;
  return quota ? Math.max(0, 100 - quota.utilization) : null;
}

/**
 * Choose where a delegate call runs (docs/subagent-design.md §10.1). Throws the refusal, in English, when the named
 * workspace cannot take it or no workspace matches `needs`; answers `local` for the parent's own machine.
 */
export async function chooseSubagentWorkspace(
  db: Prisma.TransactionClient,
  args: {
    ownerId: string;
    parentWorkspaceId: string | null;
    workspace?: string;
    needs?: readonly string[];
    /** A read-only SubAgent may run in a work dir that is not a git repository, in that directory itself (§10.2). */
    readonly?: boolean;
    now?: Date;
  },
): Promise<SubagentWorkspacePick> {
  const readonly = args.readonly === true;
  const named = args.workspace?.trim() ?? '';
  const needs = neededCapabilities(args.needs);
  if (!named && needs.length === 0) return { kind: 'local', reason: null };
  const now = args.now ?? new Date();
  const needText = needs.join(', ');

  if (named) {
    const row = await db.workspace.findFirst({
      where: { ownerId: args.ownerId, name: named, deletedAt: null },
      orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
      select: CANDIDATE_SELECT,
    });
    if (!row) {
      throw refusal(HttpStatus.NOT_FOUND, 'SUBAGENT_WORKSPACE_NOT_FOUND', `No workspace named "${named}" in this account.`);
    }
    if (row.id === args.parentWorkspaceId) {
      return { kind: 'local', reason: null };
    }
    if (row.workDirIsGit === false && !readonly) throw notGitRefusal(row.name);
    if (!row.subagentsEnabled) {
      throw refusal(
        HttpStatus.FORBIDDEN,
        'SUBAGENTS_DISABLED_ON_TARGET',
        `SubAgents are turned off for ${row.name}. Turn them on in its agent settings, or do the work in this session.`,
      );
    }
    if (!row.enabled) {
      throw refusal(HttpStatus.CONFLICT, 'SUBAGENT_WORKSPACE_DISABLED', `${row.name} is disabled.`);
    }
    if (!row.runner || !row.runnerId || !runnerIsOnline(row.runner, now.getTime())) {
      throw refusal(HttpStatus.CONFLICT, 'SUBAGENT_WORKSPACE_OFFLINE', `${row.name}'s runner is offline.`);
    }
    const lacks = lacksOf(row, needs, readonly, now.getTime());
    if (lacks.length) {
      throw refusal(HttpStatus.CONFLICT, 'SUBAGENT_WORKSPACE_LACKS_NEEDS', `${row.name} cannot run this SubAgent: ${lacks.join('; ')}.`);
    }
    return {
      kind: 'remote',
      workspace: { id: row.id, name: row.name, runnerId: row.runnerId, workDir: row.workDir, inPlace: row.workDirIsGit === false },
      reason: `Named by the delegate call: ${row.name}` + (needs.length ? `, whose runner reports ${needText}` : '') +
        (row.workDirIsGit === false ? ', read-only in its work directory, which is not a git repository' : ''),
    };
  }

  const parent = args.parentWorkspaceId
    ? await db.workspace.findUnique({ where: { id: args.parentWorkspaceId }, select: { repoUrl: true, name: true } })
    : null;
  const parentRepo = repoOf(parent?.repoUrl);

  // By capability: the owner's enabled workspaces in the Agents list's order (position, then creation).
  const rows = await db.workspace.findMany({
    where: { ownerId: args.ownerId, enabled: true, deletedAt: null },
    orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
    select: CANDIDATE_SELECT,
  });
  const candidates: WorkspaceCandidate[] = [];
  for (const row of rows) {
    const lacks = lacksOf(row, needs, readonly, now.getTime());
    const repo = repoOf(row.repoUrl);
    if (!parentRepo || !repo) lacks.unshift(repo ? "this session's workspace has no repository URL" : 'it has no repository URL');
    else if (repo !== parentRepo) lacks.unshift(`it works on another repository (${repo})`);
    candidates.push({
      id: row.id,
      name: row.name,
      runnerId: row.runnerId,
      workDir: row.workDir,
      inPlace: row.workDirIsGit === false,
      lacks,
      headroom: lacks.length ? null : await headroomOf(db, args.ownerId, row.id, now),
    });
  }
  const able = candidates.filter((c) => c.lacks.length === 0);
  if (able.length === 0) {
    const lines = candidates.map((c) => `${c.name}: ${c.lacks.join('; ')}`);
    throw refusal(
      HttpStatus.CONFLICT,
      'SUBAGENT_NO_WORKSPACE_MATCHES',
      `No workspace of this repository can run a SubAgent that needs ${needText}.` +
        (lines.length ? ` What each lacked:\n- ${lines.join('\n- ')}` : ' This account has no enabled workspace.'),
    );
  }
  // The most headroom first; a workspace whose quota is unknown after every known one; ties keep the list's order.
  const ranked = able
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const ha = a.c.headroom ?? -1;
      const hb = b.c.headroom ?? -1;
      return hb - ha || a.index - b.index;
    })
    .map(({ c }) => c);
  const pick = ranked[0];
  const reason = able.length === 1
    ? `Needs ${needText}: ${pick.name} is the only workspace of this repository whose runner reports it`
    : pick.headroom !== null
      ? `Needs ${needText}: ${pick.name} has the most quota headroom (${Math.round(pick.headroom)}% left) of the ` +
        `${able.length} workspaces of this repository whose runners report it`
      : `Needs ${needText}: ${pick.name} comes first in the Agents list of the ${able.length} workspaces of this ` +
        'repository whose runners report it, none of whose quota is known';
  if (pick.id === args.parentWorkspaceId) return { kind: 'local', reason };
  return {
    kind: 'remote',
    workspace: { id: pick.id, name: pick.name, runnerId: pick.runnerId!, workDir: pick.workDir, inPlace: pick.inPlace },
    reason,
  };
}

/** What a remote run keeps of the delegate call that the target runner needs (`subagent_run.remote`). */
export interface SubagentRemoteFacts {
  prompt: string;
  readonly?: boolean;
  permissionMode?: string;
  needs?: string[];
  /** The earlier remote run whose conversation this one continues (§10.2). */
  resumeOf?: string;
  /** Read-only, in the target's work dir itself, which is not a git repository (§10.2). */
  inPlace?: boolean;
}

export function remoteFactsOf(value: unknown): SubagentRemoteFacts {
  const facts = (value ?? {}) as Partial<SubagentRemoteFacts>;
  return {
    prompt: typeof facts.prompt === 'string' ? facts.prompt : '',
    ...(facts.readonly === true ? { readonly: true } : {}),
    ...(typeof facts.permissionMode === 'string' ? { permissionMode: facts.permissionMode } : {}),
    ...(Array.isArray(facts.needs) ? { needs: facts.needs.filter((n): n is string => typeof n === 'string') } : {}),
    ...(typeof facts.resumeOf === 'string' ? { resumeOf: facts.resumeOf } : {}),
    ...(facts.inPlace === true ? { inPlace: true } : {}),
  };
}

/** What remoteSubagentExec answers: the claim-shaped config and what it resolved to, or why it cannot be built. */
export interface RemoteSubagentExec {
  exec?: AgentExecConfig;
  engine?: string;
  provider?: string;
  model?: string;
  effort?: string | null;
  /** The parent session's mode, which a read-only child's requests are answered by on the target runner. */
  parentMode?: PermissionMode;
  /** When `exec.permissionMode` is not the mode the child asked for: what it asked for, and why (claimPermissionMode). */
  permissionModeSubstitution?: NonNullable<SubagentAttempt['permissionModeSubstitution']>;
  refusal?: string;
}

/**
 * How the target runner runs a remote SubAgent (§10.2): by default the target workspace's own default engine and
 * credential — the provider its last session ran on — on the runtime's default model; with `target`, the candidate
 * planRemoteSubagent chose on that runner instead (§10.3). Its effort and tool rules, in the permission mode the
 * parent's allows. The shape a session claim hands the runner. `refusal` when nothing can run it there.
 */
export async function remoteSubagentExec(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    parentSessionId: string;
    facts: Pick<SubagentRemoteFacts, 'readonly' | 'permissionMode'>;
    target?: SubagentCandidateTarget;
  },
): Promise<RemoteSubagentExec> {
  const workspace = await tx.workspace.findUnique({
    where: { id: args.workspaceId },
    select: {
      id: true, name: true, ownerId: true, model: true, env: true, effort: true, permissionRules: true, disallowedTools: true,
      codexAccount: true, claudeAccount: true, antigravityAccount: true, kimiAccount: true, cursorAccount: true,
      runner: {
        select: {
          runtimeDefaultModels: true, modelCatalog: true, engines: true, defaultRemoved: true, accountPauses: true,
          planUsage: true, runsAsRoot: true,
        },
      },
    },
  });
  if (!workspace?.runner) return { refusal: 'the target workspace has no runner' };
  const parent = await tx.session.findUnique({
    where: { id: args.parentSessionId },
    select: {
      engine: true, provider: true, permissionMode: true, actualPermissionMode: true, owner: { select: { preferences: true } },
      scheduleRun: { select: { accessLevel: true, schedule: { select: { accessLevel: true } } } },
    },
  });
  if (!parent) return { refusal: 'the parent session is gone' };
  const target = args.target;
  const seed = target
    ? {
      engine: target.engine as AgentProvider,
      provider: target.provider,
      providerBuiltin: (Object.values(AgentProvider) as string[]).includes(target.provider),
    }
    : await agentProviderSeed(tx, workspace.id);
  const whose = target ? `${workspace.name}'s` : `${workspace.name}'s default`;
  if (!seed.engine) return { refusal: `${whose} provider ${seed.provider} is gone` };
  const builtin = isBuiltinProvider(seed.provider, seed.providerBuiltin);
  const keyRow = await dispatchKeyRow(tx, { ownerId: workspace.ownerId, provider: seed.provider, providerBuiltin: seed.providerBuiltin }, workspace.env);
  if (!builtin && !keyRow) {
    return { refusal: `${whose} provider ${seed.provider} is an account pool, which a remote SubAgent cannot run on yet` };
  }
  let resolved: ReturnType<typeof resolveProviderExec>;
  try {
    resolved = resolveProviderExec({
      engine: seed.engine,
      declaredProvider: seed.provider,
      declaredProviderBuiltin: seed.providerBuiltin,
      customRow: keyRow,
      sessionModel: target?.model ?? null,
      usesRuntimeDefaultModel: !target,
      runtimeDefaultModels: workspace.runner.runtimeDefaultModels,
      workspaceModel: workspace.model,
      modelCatalog: workspace.runner.modelCatalog,
      workspaceEnv: workspace.env as Record<string, string> | null,
      codexAccount: workspace.codexAccount,
      claudeAccount: workspace.claudeAccount,
      antigravityAccount: workspace.antigravityAccount,
      kimiAccount: workspace.kimiAccount,
      cursorAccount: workspace.cursorAccount,
      runner: workspace.runner,
    });
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const said = error.getResponse() as { message?: string } | string;
    return { refusal: typeof said === 'string' ? said : said.message ?? error.message };
  }
  const provider = resolved.provider;
  const runnerModel = resolved.runnerModel ?? resolved.model;
  const catalog = workspace.runner.modelCatalog;
  // R3: the mode the parent is actually running in.
  const parentMode = runningPermissionMode(parent, parent.owner);
  const parentEngine = parent.engine ?? parent.provider ?? provider;
  // Never wider than the parent's mode (§5.3), judged on the engine the child runs on.
  const asked = !args.facts.readonly && args.facts.permissionMode
    && !isWiderThanParent({ mode: parentMode, engine: parentEngine }, args.facts.permissionMode, provider)
    ? args.facts.permissionMode
    : null;
  // The parent's mode on every engine, read-only or not: the runner keeps a read-only child read-only (§5.3).
  const childMode = subagentChildMode(parentMode, { readonly: args.facts.readonly, asked }, provider);
  const effort = normalizeEffortForRuntimeModel(
    provider, (target ? target.effort : null) ?? workspace.effort ?? undefined, runnerModel, catalog, resolved.reasoningLevels,
  );
  // A scheduled run's SubAgent is held to the run's level, as the run is: Auto on Claude Code, the level's denials on
  // every engine (schedule-access.ts). It never waits on a card nobody is there to answer.
  const level = runAccessLevel(parent.scheduleRun);
  // The child's mode as a claim hands a session's (claim-permission-mode.ts): Auto stays Auto on a model whose catalogue
  // row lists none; only a scheduled run, Bypass on a root runner and DeepSeek Harness's and Cursor's refusals remain.
  const handed = claimPermissionMode(provider, childMode, level, workspace.runner.runsAsRoot);
  return {
    exec: {
      provider,
      model: runnerModel,
      allowedTools: dispatchAllowedTools(provider, ALWAYS_ALLOWED_TOOLS, workspace.permissionRules ?? []),
      disallowedTools: scheduleRunDisallowedTools((workspace.disallowedTools as string[] | null) ?? [], level, provider),
      permissionMode: handed.mode,
      effort,
      env: resolved.env,
    },
    engine: seed.engine,
    provider: seed.provider,
    model: resolved.model,
    effort: effort ?? null,
    parentMode,
    ...(handed.substitution ? { permissionModeSubstitution: { ...handed.substitution, mode: handed.mode } } : {}),
  };
}

function describeTarget(c: { provider: string; engine: string | null }): string {
  return `${c.provider}${c.engine && c.engine !== c.provider ? ` (${c.engine})` : ''}`;
}

/**
 * Where a remote SubAgent runs on its target workspace (docs/subagent-design.md §10.3), judged on the TARGET runner's
 * report — its engines, logins and quota — and the owner's SubAgent block list (§4.2):
 *
 *   - A named model (§4.1 row 1) runs as named, on the first provider × engine of the target that offers it and can
 *     start; none is 409 SUBAGENT_TARGET_CANNOT_RUN, naming why each offer is out and what the workspace can run.
 *     Never another model.
 *   - Otherwise the workspace's own default engine and model, while that engine passes the filters and can start.
 *     When it does not, the run goes where routeSubagent would send it on the target runner, the default skipped
 *     with its reason in the decision; nothing usable is 409 NO_SUBAGENT_PROVIDER with each provider's reason. Never
 *     the parent's model.
 *
 * Reads only. Throws the refusal; answers the decision, the candidate and its claim-shaped config.
 */
export async function planRemoteSubagent(
  tx: Prisma.TransactionClient,
  args: {
    ownerId: string;
    sessionId: string;
    dto: SubagentRunCreateRequest;
    facts: SubagentRemoteFacts;
    pick: Extract<SubagentWorkspacePick, { kind: 'remote' }>;
    planUsage?: SubagentPlanUsageReader | null;
  },
): Promise<{ decision: SubagentDecision; target: SubagentCandidateTarget; built: RemoteSubagentExec }> {
  const { pick, facts } = args;
  const ws = pick.workspace;
  const seed = await agentProviderSeed(tx, ws.id);
  const named = args.dto.model?.trim() || null;
  const input = await subagentRouteInput(tx, {
    ownerId: args.ownerId,
    workspaceId: ws.id,
    runnerId: ws.runnerId,
    // The definition's model is read on the parent's machine; the target routes on the caller's word alone.
    dto: { ...args.dto, model: named ?? undefined, definitionModel: undefined },
    // Never run on: a named model is strict, and no other row of §4.1 picks the parent's model.
    parent: { engine: seed.engine ?? seed.provider, provider: seed.provider, model: '', effort: null },
    planUsage: args.planUsage ?? null,
    runnerLabel: `${ws.name}'s runner`,
    strictNamedModel: true,
  });
  const build = (target?: SubagentCandidateTarget) =>
    remoteSubagentExec(tx, { workspaceId: ws.id, parentSessionId: args.sessionId, facts, ...(target ? { target } : {}) });
  const placed = {
    workspace: workspaceChoice(ws, pick.reason),
    ...(args.dto.readonly ? { readonly: true } : {}),
  };
  /** The first candidate that can start on the target, and the ones passed over with why. */
  const firstThatStarts = async (candidates: SubagentCandidateTarget[]) => {
    const passedOver: Array<{ target: SubagentCandidateTarget; reason: string }> = [];
    for (const target of candidates) {
      const built = await build(target);
      if (built.exec) return { chosen: { target, built }, passedOver };
      passedOver.push({ target, reason: built.refusal ?? 'it cannot be started there' });
    }
    return { chosen: null, passedOver };
  };
  const passedLine = (p: { target: SubagentCandidateTarget; reason: string }) =>
    `${describeTarget(p.target)}, ${p.target.model}: ${p.reason}`;

  if (named) {
    const route = routeSubagent(input);
    const { chosen, passedOver } = await firstThatStarts(fallbackCandidates(route));
    if (!chosen) {
      const why = [
        ...route.candidates.map((c) => `${describeTarget(c)}: ${c.reason}`),
        ...passedOver.map(passedLine),
      ];
      const runnable = subagentRunnableModels(input).map((r) => `${describeTarget(r)}: ${r.models.join(', ')}`);
      throw refusal(
        HttpStatus.CONFLICT,
        'SUBAGENT_TARGET_CANNOT_RUN',
        `${ws.name} cannot run ${named}, the model this delegate call named` +
          (why.length ? `: ${why.join('; ')}.` : ': no usable provider there offers it.') +
          (runnable.length
            ? ` What ${ws.name} can run:\n- ${runnable.join('\n- ')}`
            : ` ${ws.name} has no usable provider to run anything on.`),
      );
    }
    const decision = appliedDecision(route, chosen.target, passedOver);
    return {
      decision: { ...decision, reasons: [pick.reason, ...decision.reasons], ...placed },
      target: chosen.target,
      built: chosen.built,
    };
  }

  // The workspace's own default, while its engine passes the filters on its runner and can start there.
  let skipped = seed.engine ? subagentCandidateRefusal(input, seed.provider, seed.engine) : null;
  if (!skipped) {
    const built = await build();
    if (built.exec) {
      const target = { engine: built.engine!, provider: built.provider!, model: built.model!, effort: built.effort ?? null };
      return {
        decision: {
          level: null,
          tierSource: 'not-routed',
          optimizeFor: null,
          ...target,
          reasons: [pick.reason, `Runs on ${ws.name}'s own default engine and model, ${target.model}`],
          candidates: [],
          policyVersion: SUBAGENT_REMOTE_POLICY_VERSION,
          applied: true,
          ...placed,
        },
        target,
        built,
      };
    }
    skipped = built.refusal ?? 'it cannot be started there';
  }
  // Routed on the target runner, past the default it just judged.
  const route = routeSubagent(input);
  const isDefault = (c: { provider: string; engine: string | null }) => c.provider === seed.provider && c.engine === seed.engine;
  const defaultLine = `${ws.name}'s default ${describeTarget({ provider: seed.provider, engine: seed.engine })}: ${skipped}`;
  const { chosen, passedOver } = await firstThatStarts(fallbackCandidates(route).filter((c) => !isDefault(c)));
  if (!chosen) {
    throw refusal(
      HttpStatus.CONFLICT,
      'NO_SUBAGENT_PROVIDER',
      `On ${ws.name}: ` + noProviderMessage(route, [], [defaultLine, ...passedOver.map(passedLine)]),
    );
  }
  const decision = appliedDecision(route, chosen.target, passedOver);
  const recorded = decision.candidates.some((c) => isDefault(c) && c.model === null);
  return {
    decision: {
      ...decision,
      reasons: [pick.reason, `Skipped ${defaultLine}`, ...decision.reasons],
      candidates: recorded
        ? decision.candidates
        : [{ provider: seed.provider, engine: seed.engine ?? null, model: null, effort: null, reason: `${ws.name}'s default: ${skipped}` },
          ...decision.candidates],
      ...placed,
    },
    target: chosen.target,
    built: chosen.built,
  };
}

/** What a remote decision that ran on the target workspace's own default was made under (§10.3). */
export const SUBAGENT_REMOTE_POLICY_VERSION = 'subagent-remote-v2';

/** The child events the parent's stream carries; the rest (deltas, system frames, background lifecycle) are dropped. */
const RELAYED_EVENT_TYPES = new Set<string>([
  RunEventType.ASSISTANT, RunEventType.THINKING, RunEventType.TOOL_USE, RunEventType.TOOL_RESULT, RunEventType.TOOL_OUTPUT,
  RunEventType.ERROR,
]);

/** A child's tool id as the parent's session knows it: prefixed with the run id (runner-go subagent.go subagentToolID). */
export function subagentToolId(runId: string, id: string): string {
  return id ? `${runId}:${id}` : '';
}

/**
 * A child event as the parent's stream carries it, or null for one it must not (runner-go subagent.go
 * rewriteSubagentEvent, done here for a remote run so the target runner cannot place an event elsewhere): nested
 * under the delegate call, every child tool id prefixed with the run id, marked with the run.
 */
export function rewriteRemoteSubagentEvent(
  runId: string,
  delegateToolUseId: string,
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!RELAYED_EVENT_TYPES.has(type)) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const out: Record<string, unknown> = { ...payload };
  const inner = text(payload.parentToolUseId);
  out.parentToolUseId = inner ? subagentToolId(runId, inner) : delegateToolUseId;
  if (type === RunEventType.TOOL_USE) out.id = subagentToolId(runId, text(payload.id));
  const toolUseId = text(payload.toolUseId);
  if (toolUseId) out.toolUseId = subagentToolId(runId, toolUseId);
  out.subagentRunId = runId;
  return out;
}

/** The most events one relay batch may carry, and one read of them returns. */
export const SUBAGENT_RELAY_BATCH_MAX = 500;

/** The batch's events, checked: a whole positive seq, a type, an object payload. Throws 400 on anything else. */
export function readRelayBatch(events: unknown): RemoteSubagentEvent[] {
  if (!Array.isArray(events)) throw refusal(HttpStatus.BAD_REQUEST, 'SUBAGENT_RELAY_BATCH_INVALID', 'events must be an array');
  if (events.length > SUBAGENT_RELAY_BATCH_MAX) {
    throw refusal(HttpStatus.BAD_REQUEST, 'SUBAGENT_RELAY_BATCH_INVALID', `at most ${SUBAGENT_RELAY_BATCH_MAX} events per batch`);
  }
  return events.map((raw, index) => {
    const event = (raw ?? {}) as Partial<RemoteSubagentEvent>;
    if (!Number.isInteger(event.seq) || (event.seq as number) < 1 || (event.seq as number) > 2_147_483_647
      || typeof event.type !== 'string' || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      throw refusal(HttpStatus.BAD_REQUEST, 'SUBAGENT_RELAY_BATCH_INVALID',
        `event ${index} needs a whole seq from 1, a type and an object payload`);
    }
    return stripNul({ seq: event.seq as number, type: event.type, payload: event.payload as Record<string, unknown> });
  });
}

/** The run a target runner names, checked: another account's or a missing one is 404, another runner's 403. */
export async function runOfTarget(
  db: Prisma.TransactionClient,
  runId: string,
  runner: { id: string; ownerId: string },
) {
  const run = await db.subagentRun.findUnique({ where: { id: runId } });
  if (!run || run.ownerId !== runner.ownerId || !run.targetRunnerId) throw new NotFoundException('SubAgent run not found');
  if (run.targetRunnerId !== runner.id) {
    throw new ForbiddenException({
      code: 'SUBAGENT_RUN_NOT_TARGET',
      message: 'This SubAgent run was handed to another runner; only that runner may claim it, relay its events or report its end.',
    });
  }
  return run;
}

/**
 * The parent session a remote SubAgent keeps a file under (§10.2): its `file_upload` acts for the parent's session, which
 * the run's target runner does not host. Only while the run is RUNNING, of this session and account, and handed to this
 * runner; null otherwise, and the caller's own door then decides as for any session.
 */
export async function sessionOfRemoteSubagent(
  db: Prisma.TransactionClient,
  runner: { id: string; ownerId?: string },
  sessionId: string,
  subagentRunId: string | undefined,
) {
  if (!subagentRunId || !runner.ownerId) return null;
  const run = await db.subagentRun.findFirst({
    where: { id: subagentRunId, sessionId, ownerId: runner.ownerId, targetRunnerId: runner.id, status: 'RUNNING' },
    select: { id: true },
  });
  if (!run) return null;
  const session = await db.session.findFirst({ where: { id: sessionId, ownerId: runner.ownerId, deletedAt: null } });
  if (session) assertEngineSession(session);
  return session;
}

/** A run whose parent stopped it or ended: the target is to stop it. */
const PARENT_GONE = Prisma.sql`(r."stop_requested_at" IS NOT NULL OR ${sessionReleasedSql('s')} OR s."cancel_requested_at" IS NOT NULL)`;

/**
 * What a runner's heartbeat says of the remote SubAgent runs it is the target of (§10.2, §10.3): the ones to claim,
 * and the ones to stop because their parent stopped them or ended. Reads only.
 */
export async function remoteSubagentHeartbeat(
  db: Prisma.TransactionClient,
  runnerId: string,
): Promise<{ remoteSubagentRuns: string[]; stopSubagentRunIds: string[] }> {
  const rows = await db.$queryRaw<Array<{ id: string; claimed: boolean; stop: boolean }>>`
    SELECT r."id", r."claimed_at" IS NOT NULL AS "claimed", ${PARENT_GONE} AS "stop"
    FROM "subagent_run" r JOIN "session" s ON s."id" = r."session_id"
    WHERE r."target_runner_id" = ${runnerId}::uuid AND r."status" = 'RUNNING'
    ORDER BY r."created_at" ASC
  `;
  return {
    remoteSubagentRuns: rows.filter((r) => !r.claimed && !r.stop).map((r) => r.id),
    // An unclaimed one too, whose parent ended: nothing runs it, and the runner's STOPPED report is what ends it.
    stopSubagentRunIds: rows.filter((r) => r.stop).map((r) => r.id),
  };
}

/** What a remote run whose target runner went offline says. */
export const TARGET_OFFLINE_SUBAGENT_RESULT =
  "The SubAgent was interrupted: the runner of the workspace it ran on went offline before it reported an end. " +
  'Nothing it changed there comes back.';

/** What a remote run stopped before its target runner claimed it says. */
export const STOPPED_BEFORE_CLAIM_RESULT = 'The SubAgent was stopped before the runner it was handed to took it up.';

/**
 * End every RUNNING remote run whose target runner is offline (or gone) as INTERRUPTED (§10.3). The sweep wakes
 * the parent for standalone runs. Returns the runs, with their parents, so the caller can reap their cards.
 */
export async function interruptRunsOfOfflineTargets(db: Prisma.TransactionClient): Promise<Array<{ id: string; sessionId: string }>> {
  return db.$queryRaw<Array<{ id: string; sessionId: string }>>`
    UPDATE "subagent_run" r
    SET "status" = 'INTERRUPTED',
        "result_summary" = ${TARGET_OFFLINE_SUBAGENT_RESULT},
        "ended_at" = now(),
        "wake_owed" = (r."workflow_run_id" IS NULL)
    WHERE r."status" = 'RUNNING' AND r."target_runner_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "runner" ru WHERE ru."id" = r."target_runner_id" AND NOT ${runnerOfflineSql('ru')}
      )
    RETURNING r."id", r."session_id" AS "sessionId"
  `;
}

/** The refusal for a parent's end report on a run another runner hosts. */
export function remoteRunEndRefusal(): ConflictException {
  return new ConflictException({
    code: 'SUBAGENT_RUN_IS_REMOTE',
    message: 'This SubAgent runs on another workspace; its runner reports its end. Stop it with POST …/stop.',
  });
}

/** The choice as the decision records it. */
export function workspaceChoice(workspace: { id: string; name: string }, reason: string): SubagentWorkspaceChoice {
  return { id: workspace.id, name: workspace.name, reason };
}
