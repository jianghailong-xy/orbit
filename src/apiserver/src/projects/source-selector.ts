import {
  SourceKind,
  SourceRefAuthority,
  SourceRefusalCode,
} from '@orbit/shared';

/**
 * §4's resolver: which line of code a task's run STARTS FROM, as a pure function.
 *
 * `docs/project-source-contract.md` §4.1 is the priority table this implements and §4.2 is why the
 * rows are in that order. Two properties are structural rather than reviewed:
 *
 *  - **WHERE cannot leak in** (SR1/SR17). `SourceResolutionInput` below names no workspace, no
 *    workDir, no `defaultMergeTarget` and no runner. A resolution that wanted to read the machine's
 *    current HEAD has nothing to read it from — the leak is not forbidden, it is unrepresentable.
 *  - **A missing input is a refusal, never the next row** (SR19). Falling through would hand a run
 *    that should have stopped a baseline that merely looks runnable, which is the exact shape of
 *    the three degradations in §0 that this contract exists to remove.
 *
 * The admission gate (§5, G0–G6) is a SEPARATE thing and deliberately not here: this picks WHICH
 * selector, the gate decides whether it may be used, and the gate runs on the runner because the
 * runner is the machine that has the repository. Mixing them would reintroduce "resolve, and if
 * that fails resolve something else".
 */

/** A `ProjectCodebase` as the resolver sees it — the binding, never the machine running it. */
export interface SourceCodebaseInput {
  id: string;
  canonicalRepoUrl: string;
  rootCommitSha: string | null;
  upstreamRef: string;
  integrationRef: string;
  refAuthority: SourceRefAuthority;
  remoteName: string;
  authorityRunnerId: string | null;
  /** The binding's CONFIGURATION version (SR6: never a bare `revision`). */
  configRevision: bigint;
}

/**
 * SR17's closed input set, verbatim. Adding a field to it is a contract change, and the contract
 * self-check asserts the forbidden names' absence in the document this mirrors.
 */
export interface SourceResolutionInput {
  task: {
    id: string;
    projectId: string | null;
    verifiesTaskId: string | null;
    pinnedRevision: string | null;
    codeless: boolean;
    attemptGeneration: bigint;
    inheritedKnownGoodSha: string | null;
    dependsOnTaskIds: readonly string[];
  };
  codebase: SourceCodebaseInput | null;
  /** The commit a verification is judging: its subject's newest ACCEPTED checkpoint (SR43). */
  subjectCandidate: { taskId: string; commitSha: string } | null;
  /** Prerequisite products. Only `ACCEPTED` rows may enter the closure (SR25). */
  prerequisiteCheckpoints: readonly { taskId: string; commitSha: string; kind: string }[];
}

/** Which row of §4.1 won, and on what evidence (SR18). */
export interface SourceReason {
  rank: "P0'" | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
  /** One sentence a person can read in the UI: why this run starts where it starts. */
  because: string;
}

/** The nine create-frozen columns, as values (SR11's create-frozen set). */
export interface SourceSelector {
  kind: SourceKind;
  codebaseId: string;
  repoUrl: string;
  rootCommitSha: string | null;
  /** Exactly one of `ref` / `revisionSha` is non-null — §4.1's selector-type column. */
  ref: string | null;
  revisionSha: string | null;
  configRevision: bigint;
  refAuthority: SourceRefAuthority;
  requiredContains: string[];
}

export type SourceResolution =
  | { state: 'UNBOUND'; reason: SourceReason }
  | { state: 'SELECTED'; selector: SourceSelector; reason: SourceReason };

/** A resolution that stops rather than substitutes. Carries one of §10.1's frozen codes. */
export class SourceResolutionRefusal extends Error {
  constructor(
    readonly code: SourceRefusalCode,
    readonly detail: Record<string, unknown>,
    message: string,
  ) {
    super(message);
    this.name = 'SourceResolutionRefusal';
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const FULL_REF = /^refs\/[^\s]+$/;

/** SR15: a full 40-hex SHA is a SHA; anything else must be a full-name ref; abbreviations are not. */
export function classifyPinnedRevision(
  value: string,
): { kind: 'sha'; sha: string } | { kind: 'ref'; ref: string } {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  if (FULL_SHA.test(lowered)) return { kind: 'sha', sha: lowered };
  if (FULL_REF.test(trimmed)) return { kind: 'ref', ref: trimmed };
  throw new SourceResolutionRefusal(
    'CODEBASE_AUTHORITY_INVALID',
    { field: 'pinnedRevision', value: trimmed },
    // An abbreviation is ambiguous BY CONSTRUCTION, and the whole point of recording a baseline is
    // that somebody can check it afterwards against exactly one commit.
    `pinnedRevision must be a full 40-hex commit SHA or a full-name ref (refs/…), got "${trimmed}"`,
  );
}

/**
 * §4.1, top to bottom, first predicate wins.
 *
 * Every `throw` below is SR19: the row that matched owns the answer, and an unusable input under it
 * is a refusal rather than permission to try the row underneath.
 */
export function resolveSource(input: SourceResolutionInput): SourceResolution {
  const { task, codebase } = input;

  // P0' — no binding, or a task that opted out. SR5's escape hatch, and the ONLY way a session is
  // Legacy: a stored state, never an inference from "does it have a projectId".
  //
  // P0 (a task that needs code in a project with no binding) is unreachable in v1 and that is a
  // property of the definitions, not an omission: "code task" IS "its project has a binding and the
  // task is not codeless" (§2), so `codebase == null` settles the question before it is asked. Gate
  // G0 keeps the code for the day something else can declare the need.
  if (codebase === null || task.codeless) {
    return {
      state: 'UNBOUND',
      reason: {
        rank: "P0'",
        because:
          codebase === null
            ? 'this task belongs to no project code line, so it starts wherever the workspace already is (Legacy)'
            : 'this task is marked codeless, so it resolves no SOURCE (Legacy)',
      },
    };
  }

  const base = {
    codebaseId: codebase.id,
    repoUrl: codebase.canonicalRepoUrl,
    rootCommitSha: codebase.rootCommitSha,
    configRevision: codebase.configRevision,
    refAuthority: codebase.refAuthority,
  };
  // Only P4 fills `requiredContains`, and it is frozen with the rest of the selector: a prerequisite
  // that lands a further checkpoint after this session was created belongs to the NEXT session, not
  // this one.
  const closure = closureFor(input);
  const requiredContains = closure.requiredContains;

  // P1 — a verification checks THE candidate it was filed against. Beats a pin (D1) and beats an
  // inherited known-good (D2): re-running a verification must re-check the same commit, or the code
  // that failed last round escapes the re-check by the tip having moved.
  if (task.verifiesTaskId !== null) {
    if (input.subjectCandidate === null) {
      throw new SourceResolutionRefusal(
        'BASE_SHA_UNAVAILABLE',
        { sourceKind: 'VERIFICATION_SUBJECT', subjectTaskId: task.verifiesTaskId },
        'the task this verification checks has no accepted checkpoint yet, so there is no candidate commit to verify',
      );
    }
    return {
      state: 'SELECTED',
      selector: {
        ...base,
        kind: 'VERIFICATION_SUBJECT',
        ref: null,
        revisionSha: input.subjectCandidate.commitSha,
        requiredContains,
      },
      reason: {
        rank: 'P1',
        because: `it verifies the accepted checkpoint ${input.subjectCandidate.commitSha.slice(0, 8)} of the task it was filed against`,
      },
    };
  }

  // P2 — an explicit baseline somebody wrote down. Beats P3 (D3): what a person wrote outranks what
  // the machine remembered.
  if (task.pinnedRevision !== null && task.pinnedRevision.trim() !== '') {
    const pinned = classifyPinnedRevision(task.pinnedRevision);
    return {
      state: 'SELECTED',
      selector: {
        ...base,
        kind: 'PINNED_REVISION',
        ref: pinned.kind === 'ref' ? pinned.ref : null,
        revisionSha: pinned.kind === 'sha' ? pinned.sha : null,
        requiredContains,
      },
      reason: {
        rank: 'P2',
        because:
          pinned.kind === 'ref'
            ? `the task pins its baseline to ${pinned.ref}`
            : `the task pins its baseline to commit ${pinned.sha.slice(0, 8)}`,
      },
    };
  }

  // P3 — a retry continues the SAME work. Beats P4 (D4): re-basing onto a moved integration tip
  // throws away the known-good point the previous generation earned and redoes solved work. The
  // dependency check is not skipped by that ordering, it just runs against this baseline (SR22).
  if (task.attemptGeneration > 0n && task.inheritedKnownGoodSha !== null) {
    const sha = task.inheritedKnownGoodSha.trim().toLowerCase();
    if (!FULL_SHA.test(sha)) {
      throw new SourceResolutionRefusal(
        'BASE_SHA_UNAVAILABLE',
        { sourceKind: 'TASK_KNOWN_GOOD', sha: task.inheritedKnownGoodSha },
        `the known-good commit carried into this retry is not a full commit SHA: "${task.inheritedKnownGoodSha}"`,
      );
    }
    return {
      state: 'SELECTED',
      selector: {
        ...base,
        kind: 'TASK_KNOWN_GOOD',
        ref: null,
        revisionSha: sha,
        requiredContains,
      },
      reason: {
        rank: 'P3',
        because: `this is retry ${task.attemptGeneration} of the same work, continuing from the known-good commit ${sha.slice(0, 8)}`,
      },
    };
  }

  // P4 — has code prerequisites: start from the integration tip AND require it to contain each
  // prerequisite's accepted product. `requiredContains` is what makes "landed" mean containment
  // rather than "somebody reported a merge" (SR26).
  //
  // The predicate is §4.1's own — "there is at least one CODE prerequisite" — and not "the closure
  // came out non-empty". The two differ exactly when a code prerequisite has produced nothing
  // accepted, and that difference is SR19's third negative: the row matched, its input is unusable,
  // so it refuses. Reading the closure as the predicate instead would fall through to P5 and start
  // the run from the upstream tip with no containment requirement at all — the prerequisite's work
  // would be neither present nor asked for.
  if (closure.codePrerequisites.length > 0) {
    if (closure.withoutAcceptedProduct.length > 0) {
      throw new SourceResolutionRefusal(
        'BASE_SHA_UNAVAILABLE',
        {
          sourceKind: 'DEPENDENCY_CLOSURE',
          prerequisiteTaskIds: closure.withoutAcceptedProduct,
        },
        `${closure.withoutAcceptedProduct.length} prerequisite(s) of this task have no accepted checkpoint, so there is no commit for its baseline to be required to contain: ${closure.withoutAcceptedProduct.join(', ')}`,
      );
    }
    return {
      state: 'SELECTED',
      selector: {
        ...base,
        kind: 'DEPENDENCY_CLOSURE',
        ref: codebase.integrationRef,
        revisionSha: null,
        requiredContains,
      },
      reason: {
        rank: 'P4',
        because: `it depends on work that must already be in ${codebase.integrationRef} (${requiredContains.length} commit(s))`,
      },
    };
  }

  // P5 — an ordinary project code task: the line's upstream tip.
  return {
    state: 'SELECTED',
    selector: {
      ...base,
      kind: 'PROJECT_UPSTREAM',
      ref: codebase.upstreamRef,
      revisionSha: null,
      requiredContains: [],
    },
    reason: {
      rank: 'P5',
      because: `it is an ordinary task of this project's code line, which starts from ${codebase.upstreamRef}`,
    },
  };
}

/**
 * P4's predicate and its input, read off the same rows.
 *
 * `codePrerequisites` is SR27 as the closed input set can express it: a prerequisite is a CODE
 * prerequisite exactly when the caller gathered checkpoint rows for it. A `codeless` prerequisite,
 * or one whose project has no binding, contributes no row and therefore cannot make this task P4 —
 * a documentation prerequisite must not manufacture a Git requirement. The caller owns that
 * exclusion because `dependsOnTaskIds` alone cannot say which prerequisites are code tasks.
 *
 * `requiredContains` takes only `ACCEPTED` rows (SR25) — a `WIP_RED` commit may not become
 * anybody's baseline, the same rule the merge receipt trigger already enforces one table over.
 * `withoutAcceptedProduct` names the code prerequisites left with nothing after that filter, which
 * is what P4 refuses on rather than silently shipping a closure that is short by one prerequisite.
 *
 * Deduplicated and sorted so the frozen column is a function of the facts and not of row order —
 * two resolutions of the same state have to produce the same nine columns.
 */
function closureFor(input: SourceResolutionInput): {
  codePrerequisites: string[];
  requiredContains: string[];
  withoutAcceptedProduct: string[];
} {
  const accepted = new Map<string, string[]>();
  for (const checkpoint of input.prerequisiteCheckpoints) {
    const sha = checkpoint.commitSha.trim().toLowerCase();
    const shas = accepted.get(checkpoint.taskId) ?? [];
    if (checkpoint.kind === 'ACCEPTED' && FULL_SHA.test(sha)) shas.push(sha);
    accepted.set(checkpoint.taskId, shas);
  }
  return {
    codePrerequisites: [...accepted.keys()].sort(),
    requiredContains: [...new Set([...accepted.values()].flat())].sort(),
    withoutAcceptedProduct: [...accepted]
      .filter(([, shas]) => shas.length === 0)
      .map(([taskId]) => taskId)
      .sort(),
  };
}
