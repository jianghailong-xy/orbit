import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { COORDINATOR_WAKE_EVENTS, type CoordinatorWakeEvent } from './coordinator-wake';

/**
 * Every wake fact the coordinator-wake work put a producer behind, and the switched-off control
 * that proves each one obeys `coordinatorEnabled`.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Each unit of that work brought its own negative: a project with `coordinatorEnabled = false`,
 * the same write that wakes somebody when the switch is on, and an assertion that nobody was
 * woken. Each was shown red before its own unit was implemented, so the positive beside it is
 * known to travel the real write path rather than a shortcut. What no unit could establish is the
 * closing claim — that NO KIND was missed — because a unit only ever sees the kind it added.
 *
 * So this is a census with two halves. The first derives, from production source, every wake fact
 * kind that something can actually build, and compares that to a literal written down below. The
 * second takes each kind's registered negative and checks it is a real test, in a spec the full
 * round really runs, whose body really states that the fact produced nothing. A kind that gains a
 * producer and no negative fails the first half; a "negative" that merely mentions the switch
 * fails the second.
 *
 * WHY THE LIST IS EXACT RATHER THAN A LOWER BOUND
 * -----------------------------------------------
 * `WIRED` and `PREDATES_THIS_WORK` together are compared to the derived map with `deepEqual`, so a
 * new producer — of a new kind, or a SECOND producer of a kind already here — is a failure until
 * somebody writes down what it is and which control covers it. A subset check would be green for
 * exactly the case this file exists to catch. The price is that a legitimate new producer costs a
 * line here and a sentence explaining it, which is the intended price.
 *
 * WHY THE SCAN IS BOUNDED TO `COORDINATOR_WAKE_EVENTS`
 * ----------------------------------------------------
 * The alphabet is imported rather than copied, so an event added to that constant widens this scan
 * on the same commit. A fact built under a spelling in NEITHER that constant nor its retired list
 * is already a failure in `coordinator-wake.spec.ts`, which holds the union against the database's
 * own CHECK — so nothing escapes by inventing a name, and this file does not restate that claim.
 *
 * Bounded on purpose to `src/apiserver/src`, non-spec files, and to what the text says: this is a
 * syntactic census over the same source a reviewer reads, not a call-graph.
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='coordinator-disabled-negatives\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */

// Both resolved against the package, not `__dirname`: this runs from `build/projects`, while the
// subject is the TypeScript a reviewer reads. `BUILD` is the tree the full round enumerates.
const SRC = path.resolve(__dirname, '../../src');
const BUILD = path.resolve(__dirname, '..');

/**
 * What a switched-off control has to say, in the vocabulary the ledger actually uses.
 *
 * "Produced nothing" is NOT "the table is empty". `CoordinatorWakeService` claims the row before it
 * authorizes, so a fact that travelled the whole way and was refused on the switch leaves EXACTLY
 * ONE row saying so — and a control that asserted zero rows would be green over a producer nobody
 * calls, which is the state this work replaced. These four are the claims that distinguish the two
 * readings, and they are what a registered negative is checked for:
 *
 *   * `NO_JUDGMENT_SESSION`     — no judgment session exists for that owner.
 *   * `WAKE_REFUSED`            — the wake row reached a refusal rather than silence.
 *   * `REFUSED_ON_THE_SWITCH`   — the refusal was the coordinator switch, not something cheaper.
 *   * `WAKE_OPENED_NOTHING`     — the wake row carries no session.
 */
const NEGATIVE_CLAIMS: Record<string, RegExp> = {
  /** `assert.deepEqual(await judgmentSessions(...), [])`, however it is spelled across lines. */
  NO_JUDGMENT_SESSION: /judgmentSessions\((?:(?!judgmentSessions\()[\s\S])*?\)\s*,\s*\[\]/,
  WAKE_REFUSED: /\.status,\s*'REFUSED'/,
  /** Any of the producers' own exported constants; all four end in this. */
  REFUSED_ON_THE_SWITCH: /COORDINATOR_DISABLED/,
  WAKE_OPENED_NOTHING: /\.sessionId,\s*null/,
};

const ALL_CLAIMS: readonly string[] = Object.keys(NEGATIVE_CLAIMS).sort();

/** One `coordinatorEnabled = false` control: which spec carries it, and which test it is. */
interface SwitchedOffControl {
  /** Relative to `src/apiserver/src`, forward slashes — one directory deep, see `(b)`. */
  readonly spec: string;
  /** The test's name, byte for byte as `test(...)` spells it. */
  readonly test: string;
}

interface WiredWakeFact {
  readonly event: CoordinatorWakeEvent;
  /**
   * Every `path#declaration` under `src/apiserver/src` that can build this fact: the derivation
   * itself, and each production declaration that calls it.
   */
  readonly producedBy: readonly string[];
  readonly negatives: readonly SwitchedOffControl[];
}

/**
 * The fact kinds this work put behind a producer, and the control that proves the switch stops
 * each one.
 *
 * Five kinds, ten controls. The mapping is many-to-one in both directions on purpose: one kind is
 * reached by more than one write path and is controlled once per path, and one control can cover
 * two kinds when the same run drives both.
 */
const WIRED: readonly WiredWakeFact[] = [
  {
    // Delivered post-commit from the task write path (a task set closing) and from the runner door
    // (an acceptance exit code deriving DONE). Both paths get their own control, because the
    // second is where nearly every task in production actually settles.
    event: 'PROJECT_TASKS_SETTLED',
    producedBy: [
      'projects/coordinator-wake.ts#projectTasksSettledFact',
      'projects/project-tasks-settled.producer.ts#afterCommit',
    ],
    negatives: [
      {
        spec: 'tasks/task-write-settled-delivery.pg.spec.ts',
        test: 'a project whose coordinator is switched off wakes nobody',
      },
      {
        spec: 'tasks/task-executable-settled-delivery.pg.spec.ts',
        test: 'the switched-off coordinator is refused by the producer, not short-circuited by the caller',
      },
      {
        spec: 'tasks/task-executable-settled-delivery.pg.spec.ts',
        test: 'a derived DONE under a switched-off coordinator wakes nobody',
      },
    ],
  },
  {
    // One fact with two readings — a task that failed, and an attempt that ended over a task still
    // open — which is why two of its controls are two shapes of the same claim rather than a
    // duplicate. The third holds the convergence ledger's own accounting to the same switch, and
    // the fourth holds the terminal chooser to it.
    //
    // `attempt-ended-unsettled.producer.ts` still derives this fact and is registered nowhere: it
    // was hollowed out when its work moved onto the router, and `completion-input.spec.ts` is what
    // holds it to having no caller. It is named here because it can still BUILD the fact, and a
    // census of what can build one that skipped it would be a census with a hole in it.
    event: 'ATTEMPT_ENDED_UNSETTLED',
    producedBy: [
      'projects/attempt-ended-unsettled.producer.ts#afterCommit',
      'projects/coordinator-wake.ts#attemptEndedUnsettledFact',
      'projects/task-exception-input.producer.ts#factsFor',
    ],
    negatives: [
      {
        spec: 'tasks/task-exception-delivery.pg.spec.ts',
        test: 'a failed task under a switched-off coordinator produces nothing and wakes nobody',
      },
      {
        spec: 'tasks/task-exception-delivery.pg.spec.ts',
        test: 'an attempt that ended over an open task wakes nobody either, when the switch is off',
      },
      {
        spec: 'tasks/task-exception-convergence-budget.pg.spec.ts',
        test: 'with the coordinator switched off the fact is refused before the budget, and never charged',
      },
      {
        spec: 'tasks/task-wake-disposition.pg.spec.ts',
        test: 'a switched-off coordinator records both kinds of event and opens neither',
      },
    ],
  },
  {
    // The one kind whose delivery line was already connected before this work: the runner door has
    // metered a turn's budget through `wakes.claim(fact, this.authorize)` for as long as the meter
    // has existed, and `claim`'s second parameter has no default to eat. So its control is the
    // only one here that did NOT go red first — it was green the day it was written, because there
    // was nothing left to wire. That is recorded rather than papered over: dropping the row would
    // move the standard, and manufacturing a red would forge the evidence.
    event: 'ATTEMPT_BUDGET_SPENT',
    producedBy: [
      'projects/attempt-budget-meter.ts#meterAttempt',
      'projects/coordinator-wake.ts#attemptBudgetSpentFact',
    ],
    negatives: [
      {
        spec: 'tasks/task-exception-delivery.pg.spec.ts',
        test: 'a spent budget under a switched-off coordinator wakes nobody',
      },
    ],
  },
  {
    // Cut per criterion rather than per task, so its control is too: one criterion, one serving
    // task, driven to DONE through the acceptance exit code with the switch off.
    event: 'CRITERION_READY',
    producedBy: [
      'projects/coordinator-wake.ts#criterionReadyFact',
      'projects/criterion-ready.producer.ts#factsFor',
    ],
    negatives: [
      {
        spec: 'tasks/task-criterion-ready-delivery.pg.spec.ts',
        test: 'a ready criterion under a switched-off coordinator produces nothing and wakes nobody',
      },
    ],
  },
  {
    // The same unit as the kind above and the same control shape, over one clause more: whether a
    // merge receipt puts that finished work on the default branch. Its receipts are written by a
    // path the task write path does not touch, which changes nothing about the switch — the
    // producer's own authorizer refuses on the column before the convergence ledger is charged.
    event: 'CRITERION_UNLANDED',
    producedBy: [
      'projects/coordinator-wake.ts#criterionUnlandedFact',
      'projects/criterion-unlanded.producer.ts#factsFor',
    ],
    negatives: [
      {
        spec: 'tasks/task-criterion-unlanded-delivery.pg.spec.ts',
        test: 'an unlanded criterion under a switched-off coordinator produces nothing and wakes nobody',
      },
      // A second control for the same kind, and not a duplicate of the one above it: since
      // `wake-disposition.ts` §2.1 this fact is the one kind whose ordinary terminal is a judgment
      // SESSION, so "the switch stopped it" now has a half the first control could not have
      // stated. Its paired positive is in the same case, and it is what went red before the rule
      // read a landing at all.
      {
        spec: 'tasks/task-landing-wake-disposition.pg.spec.ts',
        test: 'finished work off main under a switched-off coordinator is refused once and wakes nobody',
      },
    ],
  },
];

/**
 * Fact kinds with a producer that this work did not put there, and therefore makes no claim about.
 *
 * One entry. An evidence revision is submitted by an agent on purpose and is bounded by that agent,
 * which is the single case `CompletionInputRouter.route`'s permissive default is right for — it is
 * routed with no authorizer at all, so there is no switch for a control to switch off. Every kind
 * DERIVED from a world that can go round again is in `WIRED` above instead, each carrying its
 * producer's own authorizer.
 *
 * This list is the census's one escape hatch and is deliberately a literal: adding a kind here
 * instead of giving it a control is a visible edit that says "this one predates the work", which
 * is a claim about history a reviewer can check. `COMPLETION_ACK_STALE` is NOT here — the constant
 * spells it, and nothing in production builds one, so the census never sees it. That is what
 * makes it the honest synthetic input for `(c)`.
 */
const PREDATES_THIS_WORK: readonly Pick<WiredWakeFact, 'event' | 'producedBy'>[] = [
  {
    event: 'COMPLETION_EVIDENCE_REVISED',
    producedBy: [
      'projects/completion-input.ts#completionEvidenceRevisedFact',
      'tasks/task-completion-evidence.service.ts#submit',
    ],
  },
];

const METHOD =
  /^ {2}(?:private |protected |public |static |readonly |abstract )*(?:async )?(?:\*)?([A-Za-z0-9_$]+)\s*[(<]/;
const FUNCTION =
  /^export (?:async )?function ([A-Za-z0-9_$]+)|^(?:async )?function ([A-Za-z0-9_$]+)|^export const ([A-Za-z0-9_$]+)\s*[=:]/;
const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'do', 'else', 'try',
]);

interface ScannedSource {
  /** Relative to `src/apiserver/src`, forward slashes — the way the census spells a site. */
  readonly path: string;
  readonly content: string;
}

/**
 * Blank out comments without moving a line.
 *
 * These files discuss the events they do not raise — the retired list names four, the opening
 * writer switches on all six — and a census that counted prose would report producers nobody can
 * delete.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
    .join('\n');
}

/** The declaration each line belongs to — a stable anchor, where a line number would be noise. */
function unitsByLine(code: string): string[] {
  let unit = '(module)';
  return code.split('\n').map((line) => {
    const asMethod = METHOD.exec(line);
    if (asMethod && !NOT_A_METHOD.has(asMethod[1]!)) {
      unit = asMethod[1]!;
    } else {
      const asFunction = FUNCTION.exec(line);
      if (asFunction) unit = asFunction[1] ?? asFunction[2] ?? asFunction[3]!;
    }
    return unit;
  });
}

/**
 * Every `path#declaration` that can build each wake fact kind, keyed by kind.
 *
 * Two passes, because a derivation and the place that calls it are both production points and only
 * the pair says anything: the derivations all sit in one module, so a census of them alone would
 * be one file's list of exported functions and would not notice a second producer arriving beside
 * an existing one. Kinds nothing builds are ABSENT rather than empty — an empty array would make
 * "nobody produces this" indistinguishable from "somebody does, and the scan stopped matching".
 */
function wakeProductionPoints(
  sources: readonly ScannedSource[],
): Record<string, string[]> {
  const scanned = sources.map((source) => {
    const code = withoutComments(source.content);
    return { path: source.path, lines: code.split('\n'), units: unitsByLine(code) };
  });

  const points: Record<string, Set<string>> = {};
  const derivations: [string, string][] = [];
  for (const event of COORDINATOR_WAKE_EVENTS) {
    const built = new RegExp(`\\bevent:\\s*'${event}'`);
    for (const source of scanned) {
      source.lines.forEach((line, index) => {
        if (!built.test(line)) return;
        const declaration = source.units[index]!;
        (points[event] ??= new Set()).add(`${source.path}#${declaration}`);
        derivations.push([event, declaration]);
      });
    }
  }

  for (const [event, declaration] of derivations) {
    // Not `\b` in front: `this.attemptBudgetSpentFact(` and a bare call are different things, and
    // a member access on some unrelated object is not a call of THIS declaration.
    const calls = new RegExp(`(?<![A-Za-z0-9_$.])${declaration}\\s*\\(`);
    for (const source of scanned) {
      source.lines.forEach((line, index) => {
        if (!calls.test(line)) return;
        const site = `${source.path}#${source.units[index]!}`;
        if (!site.endsWith(`#${declaration}`)) points[event]!.add(site);
      });
    }
  }

  return Object.fromEntries(
    Object.entries(points).map(([event, sites]) => [event, [...sites].sort()]),
  );
}

/**
 * The fact kinds something can build that no switched-off control witnesses.
 *
 * Empty is the answer this tree is supposed to give. It is a separate function from the comparison
 * in `(a)` so that `(c)` can ask it about a tree that does not exist.
 */
function unwitnessedFactKinds(points: Record<string, readonly string[]>): string[] {
  const witnessed = new Set<string>([
    ...WIRED.filter((fact) => fact.negatives.length > 0).map((fact) => fact.event),
    ...PREDATES_THIS_WORK.map((fact) => fact.event),
  ]);
  return Object.keys(points).filter((event) => !witnessed.has(event)).sort();
}

/**
 * Each top-level `test(...)` in a spec, mapped to the source of its body.
 *
 * A body runs to the next top-level `test(` or to the end, which is enough to attribute an
 * assertion to the case it was written in and costs no parser.
 */
function testBodies(spec: string): Map<string, string> {
  const bodies = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];
  for (const line of spec.split('\n')) {
    const named = /^test\('((?:[^'\\]|\\.)*)'/.exec(line);
    if (named) {
      if (current !== null) bodies.set(current, lines.join('\n'));
      current = named[1]!.replace(/\\'/g, "'");
      lines = [line];
    } else if (current !== null) {
      lines.push(line);
    }
  }
  if (current !== null) bodies.set(current, lines.join('\n'));
  return bodies;
}

/** Which of `NEGATIVE_CLAIMS` this test body actually makes, sorted. */
function negativeClaims(body: string): string[] {
  const code = withoutComments(body);
  return Object.entries(NEGATIVE_CLAIMS)
    .filter(([, pattern]) => pattern.test(code))
    .map(([claim]) => claim)
    .sort();
}

/**
 * Walked off the filesystem rather than asked of `git ls-files`, because an uncommitted file is
 * exactly the state a new producer is in while it is being added.
 */
function productionSources(dir: string = SRC, found: ScannedSource[] = []): ScannedSource[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      productionSources(full, found);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
    found.push({
      path: path.relative(SRC, full).split(path.sep).join('/'),
      content: readFileSync(full, 'utf8'),
    });
  }
  return found;
}

const source = (relative: string, lines: readonly string[]): ScannedSource =>
  ({ path: relative, content: lines.join('\n') });

// (a) ---------------------------------------------------------------------------------------------
test('(a) every wake fact something can build is written down here, with its producers', () => {
  const sources = productionSources();
  assert.ok(sources.length > 0, 'the census scanned no source files at all');

  const found = wakeProductionPoints(sources);
  // Three ways this comparison could be a comparison of nothing with nothing, each closed before
  // the one that matters: a scan that matched nothing, an empty manifest, and a manifest whose
  // entries carry no control.
  assert.ok(Object.keys(found).length > 0, 'the census found no wake fact producer at all');
  assert.ok(WIRED.length > 0, 'the wired manifest is empty');
  for (const fact of WIRED) {
    assert.ok(fact.negatives.length > 0, `${fact.event} is wired with no switched-off control`);
    assert.ok(fact.producedBy.length > 0, `${fact.event} is wired with no producer`);
  }

  assert.deepEqual(found, Object.fromEntries(
    [...WIRED, ...PREDATES_THIS_WORK].map((fact) => [fact.event, [...fact.producedBy]]),
  ));
  assert.deepEqual(unwitnessedFactKinds(found), []);
});

// (b) ---------------------------------------------------------------------------------------------
test('(b) each control is a real case the full round runs, and it says nothing was produced', () => {
  for (const fact of WIRED) {
    const stated = new Set<string>();
    for (const negative of fact.negatives) {
      const where = `${fact.event} -> ${negative.spec} :: ${negative.test}`;

      // The full round enumerates `build/*/*.spec.js` at exactly one directory deep, so a control
      // filed deeper would be a case nobody ever runs. Both halves are checked: the source a
      // reviewer opens, and the compiled file the round will pick up.
      assert.match(negative.spec, /^[a-z0-9-]+\/[a-z0-9.-]+\.spec\.ts$/, where);
      const specPath = path.join(SRC, negative.spec);
      assert.ok(existsSync(specPath), `${where}: no such spec`);
      assert.ok(
        existsSync(path.join(BUILD, negative.spec.replace(/\.ts$/, '.js'))),
        `${where}: the compiled case the full round would run is missing`,
      );

      const body = testBodies(readFileSync(specPath, 'utf8')).get(negative.test);
      assert.ok(body !== undefined, `${where}: that spec has no case by that name`);

      // Two of the four is the bar for one case, because two of these controls are halves of one
      // claim written as a pair — one shows the fact was refused on the switch, the other that
      // nothing was opened — and neither half alone states all four.
      const claims = negativeClaims(body);
      assert.ok(claims.length >= 2, `${where}: states only ${JSON.stringify(claims)}`);
      for (const claim of claims) stated.add(claim);
    }

    // Per KIND, though, all four have to be said by somebody. This is what stops a kind from being
    // covered by a case that only ever asserts the weakest half.
    assert.deepEqual([...stated].sort(), [...ALL_CLAIMS], fact.event);
  }
});

// (c) ---------------------------------------------------------------------------------------------
test('(c) a fact kind that gains a producer and no control is reported', () => {
  const real = productionSources();
  // The positive half. Without it the assertion below would also pass against a census that
  // reports every kind as unwitnessed, or one that reports the same answer whatever it is handed.
  assert.deepEqual(
    unwitnessedFactKinds(wakeProductionPoints(real)), [],
    'the tree already has a fact kind no control witnesses',
  );

  // `COMPLETION_ACK_STALE` is the honest synthetic: the constant spells it, the judgment opening
  // writes a paragraph for it, and nothing builds one — so it is a kind that could arrive
  // tomorrow, in the shape it would actually arrive in.
  const grown = wakeProductionPoints([...real, source('projects/completion-ack.producer.ts', [
    "import type { WakeFact } from './coordinator-wake';",
    '',
    'export function completionAckStaleFact(stale: {',
    '  projectId: string; taskId: string; ackVersion: string;',
    '}): WakeFact {',
    '  return {',
    "    event: 'COMPLETION_ACK_STALE',",
    '    projectId: stale.projectId,',
    "    subjectType: 'TASK',",
    '    subjectId: stale.taskId,',
    '    subjectVersion: stale.ackVersion,',
    '  };',
    '}',
  ])]);

  assert.deepEqual(
    grown['COMPLETION_ACK_STALE'],
    ['projects/completion-ack.producer.ts#completionAckStaleFact'],
  );
  assert.deepEqual(unwitnessedFactKinds(grown), ['COMPLETION_ACK_STALE']);
});

// (d) ---------------------------------------------------------------------------------------------
test('(d) a case that only mentions the switch is not a control', () => {
  // What the census would accept if it looked for the words instead of the assertions: the switch
  // is off, the write happens, and the only thing asserted is an empty table — which is equally
  // true of a producer nobody calls.
  const pretend = [
    "test('a switched-off coordinator writes nothing', async () => {",
    '  const stack = await connect();',
    "  const f = await fixture(stack, 'pretend', { coordinatorEnabled: false });",
    '  await settleByAcceptance(stack, f);',
    '  assert.equal((await wakes(stack.db, f.projectId)).length, 0);',
    '});',
  ].join('\n');
  const body = testBodies(pretend).get('a switched-off coordinator writes nothing');
  assert.ok(body !== undefined, 'the body reader lost the only case it was handed');
  assert.deepEqual(negativeClaims(body), []);

  // The control for the control: a real registered case, read the same way, states all four.
  // Without this half, `(d)` would pass against a `negativeClaims` that always answered nothing.
  const [real] = WIRED.flatMap((fact) => fact.negatives)
    .filter((negative) => negative.spec.endsWith('task-criterion-ready-delivery.pg.spec.ts'));
  assert.ok(real !== undefined, 'the case this half reads has been unregistered');
  const registered = testBodies(readFileSync(path.join(SRC, real.spec), 'utf8')).get(real.test);
  assert.ok(registered !== undefined, `${real.spec} has no case named ${real.test}`);
  assert.deepEqual(negativeClaims(registered), [...ALL_CLAIMS]);
});
