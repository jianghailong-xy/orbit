/**
 * Unit L4: what has to be true of a PLAN before any of it is written.
 *
 * A batch create is the most consequential thing an agent does here and the least visible — the ops
 * are fifty titles, and what actually happens is a graph of work filed against somebody's goals. The
 * failure this exists for is not a bad title. It is a plan that is written HALFWAY, or written whole
 * and then discovered to be unrunnable: a subtask in the wrong project, an edge that quietly makes
 * one goal wait on another, an assignee that no runner can reach, a project whose acceptance moved
 * while the plan was being made.
 *
 * Two properties, and they are the whole module:
 *
 *   1. **Deterministic and complete.** Every check runs over every item and ALL findings come back
 *      together, in a fixed order. A validator that throws on the first problem turns a fifty-item
 *      plan into fifty round trips, and — worse — makes "is this plan legal" a question whose answer
 *      depends on which problem happens to be first.
 *   2. **Zero writes on failure.** This function is pure: no clock, no database, no Nest. It runs
 *      BEFORE the caller opens its transaction, so a refused plan costs no row, no lock and no
 *      partial batch. The transaction that follows re-checks the few facts a lock can protect; this
 *      is what keeps the common case from ever reaching it.
 *
 * WHAT "COVERED" MEANS HERE
 * -------------------------
 * Several of the six dimensions were already answered before this unit, by checks inside
 * `TasksService`. Re-implementing those here would be two spellings of one rule, and the direction
 * they drift is a preflight that promises a plan the write then refuses. So `PLAN_PREFLIGHT_COVERAGE`
 * is a register: every dimension names its checks, and each check says whether it lives HERE or
 * upstream — by function name, so "who answers this" is a question with an address rather than an
 * assumption. `task-plan-preflight.spec.ts` asserts the register covers every dimension and that
 * nothing claims to be here without being here.
 *
 * SEVERITY
 * --------
 * `REFUSE` stops the plan. `WARN` does not, and the distinction is not a hedge: a warning is a fact
 * about what will HAPPEN (nothing will start; it will queue behind the budget), and refusing a plan
 * because it is queued would make this validator an opinion about how people are allowed to work.
 * A refusal is reserved for a plan that is wrong — one that cannot be written correctly, or that
 * would file work under an authority nobody granted.
 */

import type { ScopePrincipal } from '../projects/project-scope-contract';
import { dependencyCrossingRefusal } from '../projects/project-handoff';
import type { HandoffApproval } from '../projects/project-scope-decision';

export const PLAN_PREFLIGHT_DIMENSIONS = [
  'PROJECT',
  'HIERARCHY',
  'DEPENDENCY_AUTHORITY',
  'ACCEPTANCE_MAPPING',
  'EXECUTION_IDENTITY',
  'BUDGET',
] as const;
export type PlanPreflightDimension = (typeof PLAN_PREFLIGHT_DIMENSIONS)[number];

export type PlanPreflightSeverity = 'REFUSE' | 'WARN';

export interface PlanPreflightCheck {
  /** What is being asked. */
  check: string;
  /** `'here'`, or the name of the function that already answers it. */
  where: string;
}

/**
 * The register. One row per dimension, and the argument for why each check lives where it does.
 *
 * The upstream entries are not a way of claiming credit for somebody else's work — they are what
 * makes this list a complete answer to "is every dimension gated". A dimension whose only check is
 * upstream still has to be NAMED here, or the day that check moves nobody finds out from this file.
 */
export const PLAN_PREFLIGHT_COVERAGE: Readonly<
  Record<PlanPreflightDimension, readonly PlanPreflightCheck[]>
> = {
  PROJECT: [
    { check: 'the project exists and this account owns it', where: 'TasksService.assertOwnedProject' },
    { check: 'the write lands in the scope the server derived, or declares a crossing', where: 'TasksService.admitScopedWrite' },
    { check: 'a settled project takes no new work (R8)', where: 'decideProjectScopeWrite' },
    { check: 'the crossing has an approval that names it (R9-R14)', where: 'decideProjectScopeWrite' },
  ],
  HIERARCHY: [
    { check: 'a parent named inside the batch is earlier and in the same project', where: 'TasksService.assertBatchValid' },
    { check: 'a parent that already exists is in the same project', where: 'TasksService.assertBatchHierarchy' },
    { check: 'a verification is in the same project as its subject, and its subject is not itself a check', where: 'TasksService.assertVerificationEligible' },
    { check: 'both sides are judged against the project the item was BOUND to, before any lock is taken', where: 'here' },
    { check: 'a ref names exactly one item of this plan, so no link is resolved by input order', where: 'here' },
  ],
  DEPENDENCY_AUTHORITY: [
    { check: 'every prerequisite is owned by this account', where: 'TasksService.assertOwnedTasks' },
    { check: 'an edge that makes one project wait on another has an approval that names it', where: 'here' },
    { check: 'an edge onto an item of this SAME plan does not cross projects — nothing can name a row that does not exist yet', where: 'here' },
  ],
  ACCEPTANCE_MAPPING: [
    { check: 'a verification counts towards the project whose acceptance reads it', where: 'here' },
  ],
  EXECUTION_IDENTITY: [
    { check: 'the assignee workspace exists, is not deleted, and this account owns it', where: 'TasksService.assertOwnedWorkspace' },
    { check: 'the provider is a built-in engine or one of this account enabled providers', where: 'TasksService.assertUsableProvider' },
    { check: 'the list exists and this account owns it', where: 'TasksService.assertOwnedList' },
    { check: 'the assignee is on the team of the project the work is filed under', where: 'here' },
    { check: 'the assignee is bound to a runner, so something can actually start it', where: 'here' },
  ],
  BUDGET: [
    { check: 'at most TASK_BATCH_CREATE_MAX items in one plan', where: 'TasksService.assertBatchValid' },
    { check: 'the project can admit work at all', where: 'here' },
    { check: 'what the plan would start at once, against the project concurrency and daily session budget', where: 'here' },
  ],
};

export interface PlanPreflightFinding {
  /** The item this is about, or -1 for a finding about the plan as a whole. */
  index: number;
  ref: string | null;
  dimension: PlanPreflightDimension;
  severity: PlanPreflightSeverity;
  /**
   * The code. Authority findings reuse L1's frozen refusal codes verbatim — §12 E2 forbids a
   * synonym, and "this crossing has no approval" is the same event whether a task write or an edge
   * discovered it. Everything else is a `PLAN_*` code, which is new vocabulary about plans rather
   * than a second name for an existing refusal.
   */
  code: string;
  message: string;
  /** One executable sentence. Same discipline as a blocker's `requiredAction` (§11.1 BL0). */
  requiredAction: string;
}

export interface PlanItemFacts {
  index: number;
  ref: string | null;
  /**
   * True for an item this call did not write — one an earlier attempt of the same turn already
   * committed, found by its idempotency key.
   *
   * It is in the plan because later items may still NAME it, and it is judged by nothing: the
   * checks below are about work that is about to be written, and re-judging a committed row against
   * a world that has moved since would make a lost response into a refusal of work that already
   * exists. A replay reads back what it wrote; it does not re-earn it.
   */
  frozen?: boolean;
  /** The project the item was BOUND to by the scope admission — not the one it asked for. */
  projectId: string | null;
  parentTaskId: string | null;
  parentRef: string | null;
  verifiesTaskId: string | null;
  verifiesRef: string | null;
  dependsOnTaskIds: readonly string[];
  dependsOnRefs: readonly string[];
  assigneeId: string | null;
  listId: string | null;
  /** Whether this item would start on its own once its prerequisites finish. */
  autoRunWhenReady: boolean;
}

export interface PlanProjectFacts {
  /** Unit L7: what a person calls this project. Read by nothing that DECIDES — it is here so the
   *  plan can be shown before it is written, and never so a check can match on prose. */
  title: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  maxConcurrentTasks: number;
  sessionBudgetPerDay: number | null;
  /** Workspaces on this project's team. */
  memberWorkspaceIds: ReadonlySet<string>;
}

export interface PlanTaskFacts {
  projectId: string | null;
  verifiesTaskId: string | null;
}

export interface PlanWorldFacts {
  principal: ScopePrincipal;
  /** Keyed by project id. A project absent from this map is one nothing could be read for. */
  projects: Readonly<Record<string, PlanProjectFacts>>;
  /** Every existing task the plan names, keyed by id. */
  tasks: Readonly<Record<string, PlanTaskFacts>>;
  /** Keyed by workspace id. */
  workspaces: Readonly<Record<string, { hasRunner: boolean }>>;
  /**
   * The answer that exists for each cross-project edge, keyed `<itemIndex>:<prerequisiteTaskId>`.
   * Absent (or null) means no answer exists, which is `CROSS_PROJECT_APPROVAL_REQUIRED`.
   */
  dependencyAnswers: Readonly<Record<string, HandoffApproval | null>>;
}

export interface PlanFacts {
  items: readonly PlanItemFacts[];
  world: PlanWorldFacts;
}

/**
 * The items of the plan, by `ref`, and the refs that name more than one of them.
 *
 * `assertBatchValid` already refuses a duplicate ref, and this computes it again anyway: a resolver
 * that silently took the first match would decide which project a subtask belongs to by input
 * order, and every check below reads through it. Two answers to "which item is `db`" is not a
 * question this module is entitled to pick a winner for.
 */
function indexRefs(items: readonly PlanItemFacts[]): {
  byRef: Map<string, PlanItemFacts>;
  ambiguous: Set<string>;
} {
  const byRef = new Map<string, PlanItemFacts>();
  const ambiguous = new Set<string>();
  for (const item of items) {
    if (item.ref === null) continue;
    if (byRef.has(item.ref)) ambiguous.add(item.ref);
    else byRef.set(item.ref, item);
  }
  return { byRef, ambiguous };
}

/** Where a reference lands: an existing task, or an item of this same plan. */
type ReferenceTarget =
  | { resolved: true; projectId: string | null; item: PlanItemFacts | null }
  | { resolved: false; reason: 'UNKNOWN' | 'AMBIGUOUS' };

function resolveReference(
  facts: PlanFacts,
  refs: ReturnType<typeof indexRefs>,
  taskId: string | null,
  ref: string | null,
): ReferenceTarget {
  if (taskId) {
    const task = facts.world.tasks[taskId];
    return task
      ? { resolved: true, projectId: task.projectId, item: null }
      : { resolved: false, reason: 'UNKNOWN' };
  }
  if (ref) {
    if (refs.ambiguous.has(ref)) return { resolved: false, reason: 'AMBIGUOUS' };
    const item = refs.byRef.get(ref);
    return item
      ? { resolved: true, projectId: item.projectId, item }
      : { resolved: false, reason: 'UNKNOWN' };
  }
  return { resolved: false, reason: 'UNKNOWN' };
}

/**
 * Every check, over every item, in one pass.
 *
 * Order is by item and then by the dimension order above — fixed, so two runs over one plan produce
 * the same list in the same order and a test can pin it. Nothing here reads a clock or a database:
 * the world arrives as facts, which is what lets the same function answer for the preview card and
 * for the write without the two being able to disagree.
 */
export function preflightPlan(facts: PlanFacts): PlanPreflightFinding[] {
  const findings: PlanPreflightFinding[] = [];
  const add = (
    item: PlanItemFacts | null,
    dimension: PlanPreflightDimension,
    severity: PlanPreflightSeverity,
    code: string,
    message: string,
    requiredAction: string,
  ): void => {
    findings.push({
      index: item?.index ?? -1,
      ref: item?.ref ?? null,
      dimension,
      severity,
      code,
      message,
      requiredAction,
    });
  };

  const refs = indexRefs(facts.items);
  for (const ref of [...refs.ambiguous].sort()) {
    add(
      null,
      'HIERARCHY',
      'REFUSE',
      'PLAN_AMBIGUOUS_REF',
      `more than one item in this plan is called "${ref}"`,
      'Give each item its own ref. Which item a link points at is not something the server may '
        + 'decide by input order.',
    );
  }

  for (const item of facts.items) {
    if (item.frozen) continue;
    const project = item.projectId ? facts.world.projects[item.projectId] : undefined;

    // HIERARCHY. Judged against the BOUND project rather than the one the caller asked for, and
    // before any lock is taken. The upstream checks ask the same question — one of them inside the
    // transaction, under the owner lock, which is where the answer has to still be true when the
    // row is written. This one is what keeps an ordinary mistake from ever costing that lock.
    for (const [kind, taskId, ref] of [
      ['parent', item.parentTaskId, item.parentRef],
      ['verification', item.verifiesTaskId, item.verifiesRef],
    ] as const) {
      if (!taskId && !ref) continue;
      const target = resolveReference(facts, refs, taskId, ref);
      // A reference this module cannot resolve is not one it may wave through: the upstream checks
      // answer "it does not exist" and "it is not earlier", and if one of them ever stops running,
      // silence here would become a link nobody judged. Ambiguity is refused above; an unknown
      // target is left to the check that owns that answer, and the crossing test below is skipped
      // because there is nothing to compare against.
      if (!target.resolved) continue;
      if ((target.projectId ?? null) !== (item.projectId ?? null)) {
        add(
          item,
          'HIERARCHY',
          'REFUSE',
          kind === 'parent' ? 'PLAN_PARENT_CROSSES_PROJECT' : 'PLAN_VERIFICATION_CROSSES_PROJECT',
          kind === 'parent'
            ? 'a subtask must be in the same project as its parent task'
            : 'a verification must be in the same project as the task it verifies',
          'File both under the same project (or neither) before linking them. A crossing here is '
            + 'never approvable: aggregation and acceptance read one project, so a link across that '
            + 'line is counted by nobody.',
        );
      }
      if (kind === 'verification') {
        const subject = taskId ? facts.world.tasks[taskId] : null;
        const subjectItem = target.resolved ? target.item : null;
        const subjectIsCheck = subject
          ? !!subject.verifiesTaskId
          : !!(subjectItem && (subjectItem.verifiesTaskId || subjectItem.verifiesRef));
        if (subjectIsCheck) {
          add(
            item,
            'ACCEPTANCE_MAPPING',
            'REFUSE',
            'PLAN_VERIFIES_A_VERIFICATION',
            'that task is itself a verification — a check of a check has nothing left to verify',
            'Point this check at the work it is meant to settle.',
          );
        }
      }
    }

    // DEPENDENCY_AUTHORITY. An edge does not move a task between projects, so L1's write decision
    // never sees it as a crossing — and yet "my goal now waits on yours" is the same authority
    // question, asked about a different row. Refused with L1's own codes rather than a parallel
    // vocabulary.
    // The half of this that is easy to miss: a prerequisite created by this SAME plan. `ref` edges
    // are checked by `assertBatchValid` for existence and backwardness and for nothing else, so a
    // plan filing one item into B and another into A, with the second waiting on the first, builds
    // a cross-project wait that no approval ever named. It cannot be approved in this shape either
    // — an approval names the prerequisite, and a row that does not exist yet cannot be named — so
    // this is a refusal with an executable next step rather than a request for an answer.
    for (const ref of item.dependsOnRefs) {
      const target = resolveReference(facts, refs, null, ref);
      if (!target.resolved) continue;
      const from = item.projectId ?? null;
      const to = target.projectId ?? null;
      if (!from || !to || from === to) continue;
      if (facts.world.principal === 'USER') continue;
      add(
        item,
        'DEPENDENCY_AUTHORITY',
        'REFUSE',
        'PLAN_BATCH_DEPENDENCY_CROSSES_PROJECT',
        `this item waits on "${ref}", which this same plan files under another project`,
        'File the prerequisite first, then declare the crossing against the task that exists — an '
          + 'approval names the prerequisite, and a row this batch has not written yet cannot be '
          + 'named by one.',
      );
    }

    for (const prerequisiteId of item.dependsOnTaskIds) {
      const prerequisite = facts.world.tasks[prerequisiteId];
      if (!prerequisite) continue; // the upstream owner check answers "it does not exist".
      const from = item.projectId ?? null;
      const to = prerequisite.projectId ?? null;
      // Both ends must NAME a goal for this to be a crossing between two of them. An edge touching
      // work that is filed under no project changes what nobody's acceptance counts, and refusing
      // it would refuse the ordinary shape of every unfiled task in the product.
      if (!from || !to || from === to) continue;
      // §4 R1: the owner is outside this contract. Their edge is an authorization in itself.
      if (facts.world.principal === 'USER') continue;
      const refusal = dependencyCrossingRefusal(
        facts.world.dependencyAnswers[`${item.index}:${prerequisiteId}`] ?? null,
      );
      if (refusal) {
        add(
          item,
          'DEPENDENCY_AUTHORITY',
          'REFUSE',
          refusal,
          'this edge would make one project wait on another project work, and no approval names it',
          refusal === 'APPROVAL_DENIED'
            ? 'That crossing was refused. File the work inside this project, or ask the user to '
              + 'link the two projects themselves.'
            : 'Declare the crossing and wait for the user to answer it.',
        );
      }
    }

    // EXECUTION_IDENTITY. Everything about WHO does the work and WHERE, past the ownership checks
    // upstream. Both of these are warnings: they describe what will happen (nothing), not a plan
    // that is wrong, and a validator that refused them would be deciding how people may stage work.
    if (item.assigneeId) {
      const workspace = facts.world.workspaces[item.assigneeId];
      if (workspace && !workspace.hasRunner) {
        add(
          item,
          'EXECUTION_IDENTITY',
          'WARN',
          'PLAN_ASSIGNEE_HAS_NO_RUNNER',
          'the assignee is not bound to a runner, so nothing will start this task',
          'Bind the workspace to a runner, or expect to start this task somewhere else.',
        );
      }
      if (project && item.projectId && !project.memberWorkspaceIds.has(item.assigneeId)) {
        add(
          item,
          'EXECUTION_IDENTITY',
          'WARN',
          'PLAN_ASSIGNEE_NOT_ON_PROJECT_TEAM',
          'the assignee is not on this project team, so the coordinator will refuse to dispatch it',
          'Add the workspace to the project team, or assign the task to somebody already on it.',
        );
      }
    }
  }

  // BUDGET, over the plan as a whole and per project: what it would start at once, against what the
  // project says it may run.
  const byProject = new Map<string, PlanItemFacts[]>();
  for (const item of facts.items) {
    if (!item.projectId || item.frozen) continue;
    const bucket = byProject.get(item.projectId) ?? [];
    bucket.push(item);
    byProject.set(item.projectId, bucket);
  }
  for (const [projectId, items] of [...byProject.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const project = facts.world.projects[projectId];
    if (!project) continue;
    // Defence in depth rather than a reachable API state: both budgets are `@Min(1)` at the door.
    // A non-positive one can only arrive from a raw write or a restored backup, and it means this
    // project can admit nothing — which a plan filed into it should be told, not discover later.
    if (project.maxConcurrentTasks <= 0
        || (project.sessionBudgetPerDay !== null && project.sessionBudgetPerDay <= 0)) {
      add(
        items[0],
        'BUDGET',
        'REFUSE',
        'PLAN_BUDGET_ADMITS_NOTHING',
        'this project budget admits no work at all, so nothing filed under it can ever run',
        'Raise the project concurrency or daily session budget before filing work under it.',
      );
      continue;
    }
    // A task with no prerequisites is never auto-run (AUTO_RUN_READY_SQL wants a prerequisite that
    // is DONE), and one waiting on an item of this same plan is blocked by construction — its
    // prerequisite is brand new and therefore OPEN. So what starts at once is exactly the items
    // that opted in, have an assignee on a runner, and wait on nothing this plan creates.
    const startingNow = items.filter((item) =>
      item.autoRunWhenReady
      && !!item.assigneeId
      && facts.world.workspaces[item.assigneeId]?.hasRunner
      && item.dependsOnRefs.length === 0
      && item.dependsOnTaskIds.length > 0).length;
    if (startingNow > project.maxConcurrentTasks) {
      add(
        items[0],
        'BUDGET',
        'WARN',
        'PLAN_EXCEEDS_PROJECT_CONCURRENCY',
        `${startingNow} of these would start at once and this project admits `
          + `${project.maxConcurrentTasks}`,
        'Expect the rest to queue. Raise the limit or stage the plan if that is not what you want.',
      );
    }
    // Against the WHOLE daily budget, not against what is left of it. Deliberate: how much of a
    // rolling 24h window has been spent is a moving number, and a preflight that read it would give
    // two different answers about one plan depending on when it was asked. "More than this project
    // may start in a day" is true whenever it is true.
    if (project.sessionBudgetPerDay !== null && startingNow > project.sessionBudgetPerDay) {
      add(
        items[0],
        'BUDGET',
        'WARN',
        'PLAN_EXCEEDS_SESSION_BUDGET',
        `${startingNow} of these would start at once and this project may start `
          + `${project.sessionBudgetPerDay} session(s) a day`,
        'Expect the rest to wait for the budget window. Raise the budget or stage the plan.',
      );
    }
  }

  return findings;
}

/** The findings that stop a plan. */
export function planPreflightRefusals(
  findings: readonly PlanPreflightFinding[],
): PlanPreflightFinding[] {
  return findings.filter((finding) => finding.severity === 'REFUSE');
}

/**
 * Unit L7: where one item of a plan would land, said in the words a person reads.
 *
 * The whole reason this exists as a separate table rather than as fields on a finding: an item
 * that passes every check has a landing too, and it is the one a person most needs to see BEFORE
 * they submit. A plan is fifty titles on screen and a graph of work filed against somebody's goals
 * underneath, and "which goal" was previously answerable only by reading the ids back out of the
 * rows afterwards.
 *
 * `projectId` is emitted under that exact name so `PublicIdInterceptor` and
 * `PublicIdExceptionFilter` render the Base62 twin beside it — an id inside prose is one no filter
 * can find, which is why the title and the id are separate fields here rather than one sentence.
 */
export interface PlanItemLanding {
  index: number;
  ref: string | null;
  /** The project this item would be FILED under — what the scope admission bound, not what the
   *  request asked for. */
  projectId: string | null;
  /** Its title, or null when the item lands under no project or names one that cannot be read. */
  projectTitle: string | null;
  projectStatus: 'OPEN' | 'DONE' | 'CANCELLED' | null;
  /** True for an item an earlier attempt already committed: it is reported, not re-decided. */
  frozen: boolean;
}

/**
 * Every item's landing, in plan order.
 *
 * Total: an item whose project cannot be read gets a row with nulls and its id, not no row at all.
 * A preview that silently omitted the items it could not resolve would be a preview that reads as
 * "these are the ones there are".
 */
export function planItemLandings(facts: PlanFacts): PlanItemLanding[] {
  return facts.items.map((item) => {
    const project = item.projectId ? facts.world.projects[item.projectId] : undefined;
    return {
      index: item.index,
      ref: item.ref,
      projectId: item.projectId,
      projectTitle: project?.title ?? null,
      projectStatus: project?.status ?? null,
      frozen: item.frozen === true,
    };
  });
}

/**
 * The refusal, as a response body.
 *
 * Every finding, not the first: a caller that has to fix a plan needs the whole list, and a body
 * that reported one problem at a time would make a fifty-item plan a fifty-round-trip negotiation.
 * No ids in the prose — the fields carry them, and `PublicIdExceptionFilter` maps an error body by
 * field name, so an id inside a sentence would ship as a raw uuid.
 *
 * `plan` (unit L7) is the landing of every item, refused ones included. A refusal that named only
 * the broken items would leave the reader unable to see the thing most often actually wrong: the
 * forty items that were about to be filed under a project nobody meant.
 */
export interface PlanPreflightRefusalBody {
  code: 'PLAN_PREFLIGHT_FAILED';
  message: string;
  /** Nothing of the plan was written. Stated in the body because it is the caller first question. */
  written: 0;
  findings: PlanPreflightFinding[];
  plan: PlanItemLanding[];
}

export function planPreflightRefusalBody(
  findings: readonly PlanPreflightFinding[],
  facts: PlanFacts,
): PlanPreflightRefusalBody {
  const refusals = planPreflightRefusals(findings);
  return {
    code: 'PLAN_PREFLIGHT_FAILED',
    message:
      `this plan was refused by ${refusals.length} check`
      + `${refusals.length === 1 ? '' : 's'}; nothing was written`,
    written: 0,
    findings: refusals,
    plan: planItemLandings(facts),
  };
}

/**
 * Unit L7: the whole plan, judged and not written.
 *
 * What `POST /tasks/batch-create` returns for `dryRun: true`. Same findings, same landings, same
 * order — the difference is that `written` is 0 because nothing was attempted rather than because
 * something was refused, and `wouldWrite` says how many rows the real call would add.
 */
export interface PlanPreviewBody {
  dryRun: true;
  /** True when the real call would go through: no finding refuses it. */
  wouldWrite: number;
  refused: boolean;
  findings: PlanPreflightFinding[];
  plan: PlanItemLanding[];
}

export function planPreviewBody(
  findings: readonly PlanPreflightFinding[],
  facts: PlanFacts,
): PlanPreviewBody {
  const refusals = planPreflightRefusals(findings);
  return {
    dryRun: true,
    // The items that are neither already committed nor part of a refused plan. A refused plan
    // writes nothing at all (AC5), so the count is zero rather than "the ones that were fine":
    // reporting a partial number would describe an outcome this endpoint cannot produce.
    wouldWrite: refusals.length ? 0 : facts.items.filter((item) => item.frozen !== true).length,
    refused: refusals.length > 0,
    // Every finding here, warnings included. A refusal body carries only what refuses because that
    // is what has to be fixed; a preview is being read to decide, and a warning — "this will queue
    // behind the budget" — is exactly the kind of thing a decision turns on.
    findings: [...findings],
    plan: planItemLandings(facts),
  };
}
