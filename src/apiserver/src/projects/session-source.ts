import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  SessionSourceSnapshot,
  SourceKind,
  SourcePinRequest,
  SourcePinResponse,
  SourceRefAuthority,
  SourceRefusalCode,
  SourceState,
  SOURCE_FIX_ACTIONS,
  SOURCE_REFUSAL_CODES,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSource, SourceReason, SourceResolution } from './source-selector';

/**
 * The SOURCE chain at the two moments it touches the database: the selector frozen when a Session
 * is created, and the snapshot handed to the runner when one is claimed.
 *
 * §6.2's two freezing moments are deliberately not one (SR32):
 *
 *  - the SELECTOR cannot wait for the claim, because reading the binding at claim time lets an
 *    administrator who edited `integrationRef` while the session queued silently rewrite what this
 *    run was for;
 *  - the SHA cannot happen at create, because the control plane has no checkout to resolve a ref
 *    with — and because a task that queued for ten minutes SHOULD start from the `main` it starts
 *    at, not the one it was filed at.
 *
 * The selector's nine columns therefore ride in the SAME INSERT as the session row (SR28). A second
 * statement would open a window in which the session is claimable and its selector is not written
 * yet, and a claim landing in that window reads nothing and starts Legacy — which is the one
 * outcome this whole contract exists to make impossible.
 */

/** The nine create-frozen columns plus the state, shaped for `session.create`'s `data`. */
export interface SessionSourceCreateColumns {
  sourceState: SourceState;
  sourceKind: SourceKind | null;
  sourceCodebaseId: string | null;
  sourceRepoUrl: string | null;
  sourceRootCommitSha: string | null;
  sourceRef: string | null;
  sourceRevisionSha: string | null;
  sourceConfigRevision: bigint | null;
  sourceRefAuthority: SourceRefAuthority | null;
  sourceRequiredContains: string[];
}

/** What a Legacy session writes: `UNBOUND`, and every snapshot column empty (§9's shape). */
export const LEGACY_SOURCE_COLUMNS: SessionSourceCreateColumns = {
  sourceState: 'UNBOUND',
  sourceKind: null,
  sourceCodebaseId: null,
  sourceRepoUrl: null,
  sourceRootCommitSha: null,
  sourceRef: null,
  sourceRevisionSha: null,
  sourceConfigRevision: null,
  sourceRefAuthority: null,
  sourceRequiredContains: [],
};

export function sourceCreateColumns(resolution: SourceResolution): SessionSourceCreateColumns {
  if (resolution.state === 'UNBOUND') return LEGACY_SOURCE_COLUMNS;
  const { selector } = resolution;
  return {
    sourceState: 'SELECTED',
    sourceKind: selector.kind,
    sourceCodebaseId: selector.codebaseId,
    sourceRepoUrl: selector.repoUrl,
    sourceRootCommitSha: selector.rootCommitSha,
    sourceRef: selector.ref,
    sourceRevisionSha: selector.revisionSha,
    sourceConfigRevision: selector.configRevision,
    sourceRefAuthority: selector.refAuthority,
    sourceRequiredContains: selector.requiredContains,
  };
}

/** What the resolver concluded, kept beside the columns so a caller can log/attribute it (SR18). */
export interface SessionSourceDecision {
  columns: SessionSourceCreateColumns;
  reason: SourceReason;
}

/**
 * The task columns §4 reads (SR17's input set, minus what has to be looked up).
 *
 * Taken as a row rather than an id so the create path resolves SOURCE from the SAME read that
 * already proved the task belongs to this caller: a second lookup by id would be a second answer to
 * "whose task is this", and the two could differ.
 */
export interface SessionSourceTaskRow {
  id: string;
  projectId: string | null;
  verifiesTaskId: string | null;
  pinnedRevision: string | null;
  codeless: boolean;
  attemptGeneration: bigint;
  knownGoodSha: string | null;
}

const LEGACY_DECISION: SessionSourceDecision = {
  columns: LEGACY_SOURCE_COLUMNS,
  reason: { rank: "P0'", because: 'this session executes no task, so it resolves no SOURCE (Legacy)' },
};

/**
 * Resolve one task's SOURCE, reading the project's code binding if it has one.
 *
 * A null task — an ordinary conversation, an orchestrated spawn, anything not executing a task — is
 * Legacy by construction: SOURCE is a property of a task's place in a project's code line, and a
 * session that executes no task has no such place.
 */
export async function decideSessionSource(
  prisma: PrismaService,
  task: SessionSourceTaskRow | null | undefined,
): Promise<SessionSourceDecision> {
  if (!task) return LEGACY_DECISION;
  // `slot = 'primary'` is v1's one-codebase-per-task MVP (§14 trade-off 1). The column exists so a
  // second binding is expressible in the data model; only this filter keeps v1 to one.
  const codebase = task.projectId
    ? await prisma.projectCodebase.findFirst({
        where: { projectId: task.projectId, slot: 'primary' },
        select: {
          id: true,
          canonicalRepoUrl: true,
          rootCommitSha: true,
          upstreamRef: true,
          integrationRef: true,
          refAuthority: true,
          remoteName: true,
          authorityRunnerId: true,
          configRevision: true,
        },
      })
    : null;
  if (codebase && !task.codeless) {
    await assertCheckpointInputsAvailable(prisma, task);
  }
  const resolution = resolveSource({
    task: {
      id: task.id,
      projectId: task.projectId,
      verifiesTaskId: task.verifiesTaskId,
      pinnedRevision: task.pinnedRevision,
      codeless: task.codeless,
      attemptGeneration: task.attemptGeneration,
      inheritedKnownGoodSha: task.knownGoodSha,
      // Empty because it has been PROVEN empty, not because it was not looked at: the guard above
      // refuses any task that has prerequisites and a code binding, so anything reaching here with
      // a codebase has none. A task with no binding resolves at P0' and never reads this.
      dependsOnTaskIds: [],
    },
    codebase: codebase
      ? {
          id: codebase.id,
          canonicalRepoUrl: codebase.canonicalRepoUrl,
          rootCommitSha: codebase.rootCommitSha,
          upstreamRef: codebase.upstreamRef,
          integrationRef: codebase.integrationRef,
          refAuthority: codebase.refAuthority as SourceRefAuthority,
          remoteName: codebase.remoteName,
          authorityRunnerId: codebase.authorityRunnerId,
          configRevision: codebase.configRevision,
        }
      : null,
    subjectCandidate: null,
    prerequisiteCheckpoints: [],
  });
  return { columns: sourceCreateColumns(resolution), reason: resolution.reason };
}

/**
 * The seam where the dependency-closure task (`34D2AgHxulKr87lKaZgYW`) plugs in — and a refusal,
 * not a default, until it does.
 *
 * §4's P1 and P4 read two inputs nothing gathers yet: the subject's newest accepted checkpoint, and
 * each prerequisite's accepted product. Supplying empty values for them would not be
 * "unimplemented", it would be WRONG in the specific way SR19 forbids — a verification would report
 * "no candidate" without having looked, and a task with prerequisites would quietly fall through to
 * P5 and start from the upstream tip with no containment requirement at all. A baseline that merely
 * looks runnable is the shape of all three degradations in §0.
 *
 * So it refuses, loudly and retryably. Structurally unreachable today: it needs a project with a
 * `ProjectCodebase` row, and nothing can write one until the API task (`34D2AgMRztyeLUaaV9CWM`)
 * lands, which is after the closure task.
 */
async function assertCheckpointInputsAvailable(
  prisma: PrismaService,
  task: SessionSourceTaskRow,
): Promise<void> {
  let needs: string | null = null;
  if (task.verifiesTaskId !== null) {
    needs = 'the accepted checkpoint this verification was filed against';
  } else if (await prisma.taskDependency.count({ where: { taskId: task.id } })) {
    needs = "its prerequisites' accepted checkpoints";
  }
  if (needs === null) return;
  throw new ServiceUnavailableException(
    `this task's SOURCE needs ${needs}, and checkpoint resolution is not wired up yet ` +
      '(project-source-contract §4 P1/P4, task 34D2AgHxulKr87lKaZgYW). Refusing rather than ' +
      'starting from a baseline nobody chose.',
  );
}

/** The session columns the claim/reclaim projection reads. */
export interface SessionSourceRow {
  sourceState: string;
  sourceKind: string | null;
  sourceCodebaseId: string | null;
  sourceRepoUrl: string | null;
  sourceRootCommitSha: string | null;
  sourceRef: string | null;
  sourceRevisionSha: string | null;
  sourceConfigRevision: bigint | null;
  sourceRefAuthority: string | null;
  sourceRequiredContains: string[];
  sourceBaseSha: string | null;
  sourceResolvedAt: Date | null;
  sourceResolvedByRunnerId: string | null;
  sourceRefusalCode: string | null;
}

/**
 * The snapshot a claim/reclaim hands the runner, or `undefined` for a Legacy session.
 *
 * `undefined` and "an object saying UNBOUND" are NOT the same wire fact and the difference is the
 * compatibility story: an absent field is what every Legacy session has always sent, so a runner
 * that never learned about SOURCE keeps behaving byte for byte as before (SR46).
 *
 * `remoteName` / `authorityRunnerId` come from the binding as it is NOW, and are deliberately not
 * among the nine frozen columns (§3.2): they answer "how do I ask the authority", not "what am I
 * asking about". The identity that was frozen — the repository URL, the root commit, the ref, the
 * configuration version — all travels from the session row, so an edited binding cannot move an
 * in-flight run's baseline. A binding that has since been deleted leaves the default `origin`,
 * which is also why this projection never fails on a missing row.
 */
export function sessionSourceSnapshot(
  session: SessionSourceRow,
  binding?: { remoteName: string; authorityRunnerId: string | null } | null,
): SessionSourceSnapshot | undefined {
  // Anything that is not positively one of the three resolved states is Legacy. Absent is not a
  // fourth meaning: `UNBOUND` is the column's default and a reader holding no value for it has not
  // learned that a run resolved a SOURCE — it has learned nothing, and treating nothing as a
  // resolved baseline is the failure this whole contract removes.
  if (!hasResolvedSource(session.sourceState)) return undefined;
  return {
    state: session.sourceState as SourceState,
    kind: session.sourceKind as SourceKind,
    codebaseId: session.sourceCodebaseId!,
    repoUrl: session.sourceRepoUrl!,
    rootCommitSha: session.sourceRootCommitSha ?? undefined,
    ref: session.sourceRef ?? undefined,
    revisionSha: session.sourceRevisionSha ?? undefined,
    configRevision: String(session.sourceConfigRevision ?? 0n),
    refAuthority: session.sourceRefAuthority as SourceRefAuthority,
    remoteName: binding?.remoteName ?? 'origin',
    authorityRunnerId: binding?.authorityRunnerId ?? undefined,
    requiredContains: session.sourceRequiredContains,
    baseSha: session.sourceBaseSha ?? undefined,
    resolvedAt: session.sourceResolvedAt?.toISOString(),
    resolvedByRunnerId: session.sourceResolvedByRunnerId ?? undefined,
    refusalCode: (session.sourceRefusalCode as SourceRefusalCode | null) ?? undefined,
  };
}

/** Legacy or not — the one-column split (SR45), guarded against a row read without the column. */
export function hasResolvedSource(sourceState: string | null | undefined): boolean {
  return sourceState === 'SELECTED' || sourceState === 'PINNED' || sourceState === 'REFUSED';
}

/** The columns `sessionSourceSnapshot` needs, as a Prisma `select`. */
export const SESSION_SOURCE_SELECT = {
  sourceState: true,
  sourceKind: true,
  sourceCodebaseId: true,
  sourceRepoUrl: true,
  sourceRootCommitSha: true,
  sourceRef: true,
  sourceRevisionSha: true,
  sourceConfigRevision: true,
  sourceRefAuthority: true,
  sourceRequiredContains: true,
  sourceBaseSha: true,
  sourceResolvedAt: true,
  sourceResolvedByRunnerId: true,
  sourceRefusalCode: true,
} as const;

/**
 * §6.3 step 3: freeze the commit this run starts from, by compare-and-set.
 *
 * The control plane has no checkout, so it cannot turn a ref into a SHA; the runner has one, so it
 * must not be the only place the answer lives. Hence the split — the machine that owns the
 * repository RESOLVES and the row every machine shares FREEZES (§14 trade-off 2). The cost is one
 * round trip; what it buys is that the API server never runs git.
 *
 * The compare-and-set is the whole mechanism (SR30). A repeated dispatch, two runners racing
 * through a takeover, and a retry of a request whose response was lost all arrive here, and at most
 * one of them can move `SELECTED` to `PINNED`. Everybody else reads what the winner wrote and is
 * told `wonRace: false` — including a loser whose own resolution produced a DIFFERENT commit,
 * because by then a worktree stands on the winner's and one session may have only one baseline.
 *
 * There is deliberately no way to re-pin, and migration 0231's freeze guard refuses it at the
 * database as well: "that SHA turned out to be unreachable" may not become "use a different SHA"
 * through any door (SR12). Substituting would make the run's result be about code it never ran.
 *
 * Separate from the controller so a test can reach it with a Prisma client and nothing else: what
 * is worth proving here is what the STATEMENTS do under concurrency, and a Nest application around
 * them proves nothing extra.
 */
export async function freezeSessionSourcePin(
  prisma: PrismaService,
  actor: { sessionId: string; runnerId: string; ownerId: string },
  request: SourcePinRequest,
): Promise<SourcePinResponse> {
  const baseSha = request?.baseSha?.trim().toLowerCase();
  const refusal = request?.refusal;
  if ((baseSha ? 1 : 0) + (refusal ? 1 : 0) !== 1) {
    throw new BadRequestException('send exactly one of baseSha or refusal');
  }
  // Abbreviations are refused here as everywhere else (SR15): recording a baseline is only worth
  // anything if somebody can check it afterwards against exactly one commit, and a prefix names a
  // set of them.
  if (baseSha !== undefined && !/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new BadRequestException('baseSha must be a full 40-character lowercase commit SHA');
  }
  if (refusal && !(SOURCE_REFUSAL_CODES as readonly string[]).includes(refusal.code)) {
    throw new BadRequestException(`unknown SOURCE refusal code "${refusal.code}"`);
  }
  // §10.1's one dispatch-path code, and the one code that may never land on a row: a session that
  // both records "refused because no runner supports the protocol" and is still queued for one that
  // does would be the state machine holding two answers at once. Its home is the claim gate, and
  // migration 0231's `session_source_refusal_chk` would reject it here anyway — this is the answer
  // that says WHY rather than a constraint violation.
  if (refusal?.code === 'SOURCE_PROTOCOL_UNSUPPORTED') {
    throw new BadRequestException(
      'SOURCE_PROTOCOL_UNSUPPORTED is decided at dispatch, not reported by a runner',
    );
  }
  const before = await prisma.session.findFirst({
    where: { id: actor.sessionId, assignedRunnerId: actor.runnerId, ownerId: actor.ownerId },
    select: SESSION_SOURCE_SELECT,
  });
  if (!before) throw new ForbiddenException('session does not belong to this runner');
  if (before.sourceState === 'UNBOUND') {
    // A Legacy session has no SOURCE to pin, and letting one be pinned would be giving the runner
    // permission to invent a baseline. Its start point is the workDir's HEAD, as it always was.
    throw new ConflictException(
      'this session resolves no SOURCE; it starts from the workspace checkout',
    );
  }
  let wonRace = false;
  if (baseSha !== undefined) {
    const claimed = await prisma.session.updateMany({
      where: {
        id: actor.sessionId,
        assignedRunnerId: actor.runnerId,
        // Both halves of the seal. `sourceState` is what the state machine reads and
        // `sourceBaseSha IS NULL` is what the freeze guard reads; 0231's `session_source_pin_chk`
        // makes them equivalent, and naming both says which invariant each reader relies on.
        sourceState: 'SELECTED',
        sourceBaseSha: null,
      },
      data: {
        sourceState: 'PINNED',
        sourceBaseSha: baseSha,
        sourceResolvedAt: new Date(),
        sourceResolvedByRunnerId: actor.runnerId,
      },
    });
    wonRace = claimed.count === 1;
  } else if (refusal) {
    const claimed = await prisma.session.updateMany({
      where: { id: actor.sessionId, assignedRunnerId: actor.runnerId, sourceState: 'SELECTED' },
      data: {
        sourceState: 'REFUSED',
        sourceRefusalCode: refusal.code,
        // `fixAction` travels WITH the code because §10.1 pairs them, and a client that re-derives
        // the pairing is a second copy of the table that can disagree with it (SR49).
        sourceRefusalDetail: {
          ...(refusal.detail ?? {}),
          fixAction: SOURCE_FIX_ACTIONS[refusal.code as SourceRefusalCode],
        },
      },
    });
    wonRace = claimed.count === 1;
  }
  const after = await prisma.session.findUniqueOrThrow({
    where: { id: actor.sessionId },
    select: SESSION_SOURCE_SELECT,
  });
  return {
    state: after.sourceState as SourceState,
    baseSha: after.sourceBaseSha ?? undefined,
    resolvedAt: after.sourceResolvedAt?.toISOString(),
    resolvedByRunnerId: after.sourceResolvedByRunnerId ?? undefined,
    refusalCode: (after.sourceRefusalCode as SourceRefusalCode | null) ?? undefined,
    wonRace,
  };
}
