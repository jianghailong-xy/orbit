import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  KNOWN_GAPS,
  OPEN_ITEM_DOOR_ASSIGNEES,
  OPEN_ITEM_DIRECT_DOOR_TABLE,
  OPEN_ITEM_DOOR_TABLE,
  appendOpenLanding,
  cellForOpenItem,
  doorsForCell,
  doorsForOpenItem,
  knownGapsForCell,
  openItemActionsFromDoors,
  type OpenItemDoor,
  type OpenItemDoorCell,
  type OpenItemDoorInput,
} from './open-item-doors';
import { OPEN_ITEM_KINDS, openItemMessage, type OpenItemMessageSource } from './project-open-item';

/**
 * A capability census, rather than a test of one particular open item.
 *
 * The open-item row is produced by several writers and is delivered through several sweeps.  A
 * new failure source can therefore look perfectly healthy while leaving one assignee with no way
 * to settle it.  The table is the contract; this spec checks its cells, its holders, and the
 * executable names it claims against the two registries that actually dispatch them.
 */

const SRC = path.resolve(__dirname, '../../src');
const MCP_SOURCE = path.resolve(SRC, '../../runner-go/mcp.go');
const CONTROLLER_FILES = [
  'runner-api/runner-projects.controller.ts',
  'runner-api/runner-tasks.controller.ts',
  'projects/projects.controller.ts',
  'projects/project-promotion.controller.ts',
  'projects/project-integration-retry.controller.ts',
  // The owner's own task doors — `POST /tasks/:id/execute` is the owner's run-again door the
  // TASK_FAILED cell names (§4.7), so the controllers that dispatch the matrix's owner routes are
  // part of what the route census has to see.
  'tasks/tasks.controller.ts',
  // The landing session's two doors (OPEN_LANDING, §2.9 LS1): the coordinator's `session_get`
  // answers on the runner route, and the owner's own route is their session page.
  'sessions/sessions.controller.ts',
  'runner-api/runner-sessions.controller.ts',
].map((file) => path.join(SRC, file));

const EXPECTED_GAPS = [] as const;

function mcpNames(source: string): Set<string> {
  return new Set([...source.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((match) => match[1]));
}

/** Read the route metadata as Nest declares it: class prefix plus method decorator. */
function routeMetadata(source: string): string[] {
  const prefixes = [...source.matchAll(/@Controller\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1]);
  const methods = [...source.matchAll(/@(Post|Get|Patch|Delete)\(\s*['"]([^'"]*)['"]\s*\)/g)]
    .map((match) => match[2]);
  return prefixes.flatMap((prefix) => methods.map((method) => `${prefix}/${method}`));
}

function canonicalRoute(route: string): string {
  return route
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/:[^/{}]+/g, ':param')
    .replace(/\{[^}]+\}/g, ':choice')
    .replace(/\/+/g, '/');
}

function routeChoices(route: string): string[] {
  const choice = route.match(/\{([^}]+)\}/);
  if (!choice) return [route];
  return choice[1].split('|').map((value) => route.replace(choice[0], value));
}

function allRouteMetadata(): Set<string> {
  const routes = new Set<string>();
  for (const file of CONTROLLER_FILES) {
    for (const route of routeMetadata(readFileSync(file, 'utf8'))) {
      routes.add(canonicalRoute(route));
    }
  }
  return routes;
}

test('the matrix has one resolving door per applicable cell and no unresolved conflict gaps', () => {
  assert.deepEqual([...KNOWN_GAPS], [...EXPECTED_GAPS]);
  assert.equal(KNOWN_GAPS.length, 0);
  assert.ok(OPEN_ITEM_DOOR_TABLE.length > 0);

  for (const cell of OPEN_ITEM_DOOR_TABLE) {
    assert.ok(cell.doors.length > 0, `empty door cell: ${JSON.stringify(cell)}`);
    assert.ok(
      cell.doors.every((door) => door.holder === cell.assignee),
      `a ${cell.assignee} cell contains a door held by another assignee: ${JSON.stringify(cell)}`,
    );
    const resolving = cell.doors.some((door) => door.implemented && door.resolving);
    const gaps = knownGapsForCell(cell);
    assert.ok(
      resolving || gaps.length > 0,
      `no resolving door and no declared gap for ${cell.todoType}/${cell.sourceJob}/${cell.failureClass}/${cell.assignee}`,
    );
  }
});

test('the door census explicitly registers every OpenItemKind, including newly added kinds', () => {
  const registered = [...new Set(OPEN_ITEM_DOOR_TABLE.map((cell) => cell.todoType))].sort();
  const kinds = [...OPEN_ITEM_KINDS].sort();
  assert.deepEqual(registered, kinds,
    'adding an OpenItemKind without registering its doors must fail the census');
  assert.deepEqual([...KNOWN_GAPS], [], 'the complete matrix has no white-listed gaps');
});

test('conflicts name their branch-changing repair doors, and owner landings have a retry door', () => {
  const promotionConflicts = OPEN_ITEM_DOOR_TABLE.filter((cell) =>
    (cell.sourceJob === 'CHECK_PROMOTION' || cell.sourceJob === 'LAND_PROMOTION')
    && cell.todoType.startsWith('INTEGRATION_')
    && cell.failureClass === 'CONFLICT');
  assert.ok(promotionConflicts.length > 0);
  assert.ok(promotionConflicts.every((cell) => {
    assert.deepEqual(knownGapsForCell(cell), []);
    return cell.doors.some((door) => door.name === 'task_create'
      && door.mcp === 'task_create' && door.capability === 'REPAIR'
      && door.implemented && door.resolving);
  }));

  const promotionMergeConflicts = OPEN_ITEM_DOOR_TABLE.filter((cell) =>
    cell.todoType === 'INTEGRATION_CONFLICT'
    && cell.sourceJob === 'CHECK_PROMOTION'
    && cell.failureClass === 'CONFLICT');
  assert.equal(promotionMergeConflicts.length, 2, 'one sync-task door for each assignee');
  assert.ok(promotionMergeConflicts.every((cell) =>
    cell.doors.some((door) => door.id === 'task-create-sync' && door.holder === cell.assignee)));

  const promotionFailures = OPEN_ITEM_DOOR_TABLE.filter((cell) =>
    (cell.sourceJob === 'CHECK_PROMOTION' || cell.sourceJob === 'LAND_PROMOTION')
    && cell.failureClass !== 'CONFLICT');
  assert.ok(promotionFailures.length > 0);
  assert.ok(promotionFailures.every((cell) => cell.todoType === 'PROMOTION_APPROVAL'
    ? cell.doors.some((door) => door.implemented && door.resolving && door.name === 'promotion review')
    : cell.doors.some((door) => door.implemented && door.resolving && door.name === 'integration_retry')));

  const mainSyncConflict = OPEN_ITEM_DOOR_TABLE.filter((cell) =>
    cell.sourceJob === 'MAIN_SYNC' && cell.failureClass === 'CONFLICT' && cell.assignee === 'COORDINATOR');
  assert.ok(mainSyncConflict.length > 0);
  assert.ok(mainSyncConflict.every((cell) => {
    assert.deepEqual(knownGapsForCell(cell), []);
    assert.ok(cell.doors.some((door) => door.name === 'task_comment' && door.mcp === 'task_comment'));
    return cell.doors.some((door) => door.name === 'task_reopen' && door.resolving);
  }));

  const ownerLanding = OPEN_ITEM_DOOR_TABLE.filter((cell) =>
    (cell.sourceJob === 'LAND_TASK' || cell.sourceJob === 'MAIN_SYNC')
    && cell.assignee === 'OWNER' && cell.todoType.startsWith('INTEGRATION_')
    && cell.failureClass !== 'CONFLICT');
  assert.ok(ownerLanding.length > 0);
  assert.ok(ownerLanding.every((cell) => cell.doors.some((door) =>
    door.name === 'integration_retry' && door.kind === 'ROUTE' && door.resolving)));

  const handover = OPEN_ITEM_DOOR_TABLE.flatMap((cell) => cell.doors)
    .filter((door) => door.name === 'open_item_hand_over');
  assert.ok(handover.length > 0, 'the implemented handover capability must remain named in the table');
  assert.ok(handover.every((door) => door.implemented && !door.resolving));
  assert.equal((KNOWN_GAPS as readonly string[]).includes('HANDOVER_DOOR'), false);
});

const TASK_ID = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d';
const PROMOTION_ID = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e';
const PROJECT_ID = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f';
const ITEM_ID = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a70';
const EPISODE_ID = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a71';
const FIX_TASK_ID = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a72';
const FIX_JOB_ID = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a73';

/** A row that lands on exactly this cell, for both projections the table feeds. */
function sampleFor(cell: OpenItemDoorCell) {
  const promotionSource = cell.sourceJob === 'CHECK_PROMOTION' || cell.sourceJob === 'LAND_PROMOTION';
  const task = cell.todoType.startsWith('INTEGRATION_') || cell.todoType === 'TASK_FAILED'
    || cell.todoType === 'DELIVERY_REVIEW';
  return {
    kind: cell.todoType,
    assignee: cell.assignee,
    taskId: task ? TASK_ID : null,
    promotionId: promotionSource || cell.todoType === 'PROMOTION_APPROVAL' ? PROMOTION_ID : null,
    fuseEpisodeId: cell.todoType === 'FUSE_PAUSED' ? EPISODE_ID : null,
    askable: true,
    sourceJob: cell.sourceJob,
    failureClass: cell.failureClass,
    phase: cell.sourceJob === 'MAIN_SYNC' ? 'MAIN_SYNC' : null,
    jobKind: cell.sourceJob === 'MAIN_SYNC' ? 'LAND_TASK' : cell.sourceJob,
    payload: {
      jobKind: cell.sourceJob === 'MAIN_SYNC' ? 'LAND_TASK' : cell.sourceJob,
      phase: cell.sourceJob === 'MAIN_SYNC' ? 'MAIN_SYNC' : undefined,
      failureClass: cell.failureClass,
      files: cell.failureClass === 'CONFLICT' ? ['src/conflicted.ts'] : undefined,
      reason: cell.todoType === 'DELIVERY_REVIEW' ? 'OUTSIDE_DECLARED_SCOPE' : undefined,
      paths: cell.todoType === 'DELIVERY_REVIEW' ? ['src/undeclared.ts'] : undefined,
      declaredPaths: cell.todoType === 'DELIVERY_REVIEW' ? ['src/declared'] : undefined,
    },
  };
}

/** Every executable name the table knows.  A message is checked against the names in here. */
function tableToolNames(): string[] {
  const doors = [
    ...OPEN_ITEM_DOOR_TABLE.flatMap((cell) => cell.doors),
    ...OPEN_ITEM_DIRECT_DOOR_TABLE.flatMap((cell) => cell.doors),
  ];
  return [...new Set(doors.filter((door) => door.implemented && door.mcp).map((door) => door.mcp!))];
}

test('no conflict cell holds the rerun its own decision refuses, and none projects RETRY', () => {
  // The integration kinds only: a TASK_FAILED cell's failureClass is a sentinel, and its RETRY is
  // `task_start` — a task that failed really can be run again, which no conflict's cell holds.
  const conflicts = OPEN_ITEM_DOOR_TABLE.filter((cell) =>
    cell.todoType.startsWith('INTEGRATION_') && cell.failureClass === 'CONFLICT');
  assert.ok(conflicts.length > 0);
  // Both kinds of conflict are in the census — a task landing's, and a promotion's — with both
  // assignees of each.
  for (const agree of [
    () => conflicts.some((cell) => cell.sourceJob === 'LAND_TASK' || cell.sourceJob === 'MAIN_SYNC'),
    () => conflicts.some((cell) => cell.sourceJob === 'CHECK_PROMOTION' || cell.sourceJob === 'LAND_PROMOTION'),
    () => conflicts.some((cell) => cell.assignee === 'COORDINATOR'),
    () => conflicts.some((cell) => cell.assignee === 'OWNER'),
  ]) assert.ok(agree(), 'the conflict census lost a source or an assignee');

  for (const cell of conflicts) {
    const where = `${cell.todoType}/${cell.sourceJob}/CONFLICT/${cell.assignee}`;
    // `decideIntegrationRetry` and `decidePromotionRetry` answer a conflict with 409
    // INTEGRATION_RETRY_NOT_APPLICABLE: the door is not in the cell at all.
    assert.equal(cell.doors.some((door) => door.mcp === 'integration_retry'), false,
      `${where} holds the rerun door a conflict is refused`);
    assert.equal(openItemActionsFromDoors(sampleFor(cell)).includes('RETRY'), false,
      `${where} projects a RETRY press the rerun door would refuse`);
  }
});

test('every cell’s coordinator message names only the doors that cell holds', () => {
  const names = tableToolNames();
  assert.ok(names.length >= 8, `the census found too few executable names: ${names.join(', ')}`);
  let named = 0;
  for (const cell of OPEN_ITEM_DOOR_TABLE) {
    const row = sampleFor(cell);
    // The messages are written for the coordinator whatever the row's own assignee, so the doors
    // they may name are the coordinator cell's.
    const doors = doorsForOpenItem({ ...row, assignee: 'COORDINATOR' }).filter((door) => door.implemented);
    // A fix task is only ever attached to an integration item or a failed task (§4.7), so the
    // re-keyed preface is rendered for those cells.
    const fixable = cell.todoType.startsWith('INTEGRATION_') || cell.todoType === 'TASK_FAILED';
    const item: OpenItemMessageSource = {
      id: ITEM_ID,
      kind: cell.todoType,
      title: `${cell.todoType} ${cell.sourceJob} ${cell.failureClass}`,
      projectId: PROJECT_ID,
      taskId: row.taskId,
      promotionId: row.promotionId,
      payload: row.payload,
      ...(fixable
        ? {
            landedFixes: [{
              taskId: FIX_TASK_ID,
              jobId: FIX_JOB_ID,
              state: 'LANDED',
              targetRef: 'refs/heads/project/34YhlsSkybFDaTXbOfcxM',
              landedSha: 'a'.repeat(40),
            }],
            failedSourceSha: 'b'.repeat(40),
          }
        : {}),
    };
    const message = openItemMessage(item);
    const where = `${cell.todoType}/${cell.sourceJob}/${cell.failureClass}/${cell.assignee}`;
    for (const name of names) {
      if (!new RegExp(`\\b${name}\\b`).test(message)) continue;
      named += 1;
      assert.ok(doors.some((door) => door.mcp === name),
        `${where} names ${name}, which its coordinator cell does not hold:\n${message}`);
    }
    if (cell.failureClass === 'CONFLICT') {
      assert.doesNotMatch(message, /\bintegration_retry\b/, `${where} offers the refused rerun in words`);
    }
  }
  assert.ok(named > 10, 'the message census named almost nothing — it is not reading the messages');
});

test('every named implemented MCP door exists in runner-go/mcp.go', () => {
  const names = mcpNames(readFileSync(MCP_SOURCE, 'utf8'));
  const missing = new Set<string>();
  const doors = [
    ...OPEN_ITEM_DOOR_TABLE.flatMap((cell) => cell.doors),
    ...OPEN_ITEM_DIRECT_DOOR_TABLE.flatMap((cell) => cell.doors),
  ];
  for (const door of doors) {
    if (door.implemented && door.mcp && !names.has(door.mcp)) missing.add(door.mcp);
  }
  assert.deepEqual([...missing].sort(), []);
});

test('every fixable item offers task_create as an item-linked repair door to its current assignee', () => {
  const fixable = OPEN_ITEM_DOOR_TABLE.filter((cell) =>
    cell.todoType === 'TASK_FAILED' || cell.todoType.startsWith('INTEGRATION_'));
  assert.ok(fixable.length > 0);
  for (const cell of fixable) {
    const repair = cell.doors.find((door) => door.id === 'task-create-fix');
    assert.ok(repair, `no concrete fix door for ${JSON.stringify(cell)}`);
    assert.equal(repair.holder, cell.assignee);
    assert.equal(repair.mcp, 'task_create');
    assert.equal(repair.capability, 'REPAIR');
    assert.equal(repair.resolving, false, 'filing work is progress, not a fabricated resolution');
  }
});

test('every named implemented route exists in controller metadata', () => {
  const routes = allRouteMetadata();
  const missing = new Set<string>();
  const doors = [
    ...OPEN_ITEM_DOOR_TABLE.flatMap((cell) => cell.doors),
    ...OPEN_ITEM_DIRECT_DOOR_TABLE.flatMap((cell) => cell.doors),
  ];
  for (const door of doors) {
    if (!door.implemented || !door.route) continue;
    const found = routeChoices(door.route).some((choice) => routes.has(canonicalRoute(choice)));
    if (!found) missing.add(door.route);
  }
  assert.deepEqual([...missing].sort(), []);
});

test('open-item assignment paths never offer a door to somebody who does not hold it', () => {
  const openItemSource = readFileSync(path.join(SRC, 'projects/project-open-item.ts'), 'utf8');
  const serviceSource = readFileSync(path.join(SRC, 'projects/project-open-item.service.ts'), 'utf8');

  // The four production paths are intentionally named here: opening a row, the direct handoff,
  // the timed escalation sweep, and a later owner-to-coordinator return.  The source census keeps
  // this test honest when one of those paths is moved to another declaration.
  assert.match(openItemSource, /assignee:\s*'COORDINATOR'/);
  assert.match(openItemSource, /assignee:\s*'OWNER'/);
  assert.match(serviceSource, /handToOwner/);
  assert.match(serviceSource, /assignee['"]?\s*[:=]\s*['"]OWNER['"]/);
  assert.match(serviceSource, /assignee['"]?\s*[:=]\s*['"]COORDINATOR['"]/);
  assert.match(serviceSource, /ESCALATED|CHAIN_LIMIT|COORDINATOR_ENDED|NO_COORDINATOR/);

  for (const assignee of OPEN_ITEM_DOOR_ASSIGNEES) {
    const cells = OPEN_ITEM_DOOR_TABLE.filter((cell) => cell.assignee === assignee);
    assert.ok(cells.length > 0, `no cells for ${assignee}`);
    for (const cell of cells) {
      for (const door of cell.doors) assert.equal(door.holder, assignee);
    }
  }

  // Check the actual action projection for each delivery holder.  The old public behavior is kept,
  // but every returned action must be backed by a door held by that same person.
  const samples = [
    { kind: 'FUSE_PAUSED', assignee: 'OWNER', taskId: null, promotionId: null, fuseEpisodeId: 'episode', askable: false },
    { kind: 'COORDINATOR_QUESTION', assignee: 'OWNER', taskId: null, promotionId: null, fuseEpisodeId: null, askable: false },
    { kind: 'INTEGRATION_CHECK_FAILED', assignee: 'COORDINATOR', taskId: 'task', promotionId: null, fuseEpisodeId: null, askable: true },
    { kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', taskId: 'task', promotionId: null, fuseEpisodeId: null, askable: true },
    { kind: 'TASK_FAILED', assignee: 'COORDINATOR', taskId: 'task', promotionId: null, fuseEpisodeId: null, askable: false },
    { kind: 'DELIVERY_REVIEW', assignee: 'COORDINATOR', taskId: 'task', promotionId: null, fuseEpisodeId: null, askable: false },
    { kind: 'PROMOTION_APPROVAL', assignee: 'OWNER', taskId: null, promotionId: 'promotion', fuseEpisodeId: null, askable: false },
  ] as const;
  for (const sample of samples) {
    const actions = openItemActionsFromDoors(sample);
    const cell = cellForOpenItem(sample);
    const direct = OPEN_ITEM_DIRECT_DOOR_TABLE.find((candidate) =>
      candidate.assignee === sample.assignee
      && ((sample.fuseEpisodeId && candidate.kind === 'FUSE_PAUSED')
        || (sample.kind === 'COORDINATOR_QUESTION' && candidate.kind === 'COORDINATOR_QUESTION')));
    const doors = cell?.doors ?? direct?.doors;
    assert.ok(doors, `sample did not map to a cell: ${JSON.stringify(sample)}`);
    for (const action of actions) {
      assert.ok(doors.some((door) => door.holder === sample.assignee && door.action === action),
        `${action} was projected without a door held by ${sample.assignee}`);
    }
  }
});

/**
 * A row standing for one matrix cell, in the shape the readers receive: every dimension the matrix
 * keys on, and the id the cell's kind carries. It reads back as the cell it was built from, which
 * the census checks rather than assumes (`cellForOpenItem(rowForCell(cell)) === cell`).
 */
function rowForCell(cell: OpenItemDoorCell): OpenItemDoorInput {
  const promotionSource = cell.sourceJob === 'CHECK_PROMOTION' || cell.sourceJob === 'LAND_PROMOTION';
  const taskKind = cell.todoType === 'TASK_FAILED' || cell.todoType === 'DELIVERY_REVIEW'
    || cell.todoType.startsWith('INTEGRATION_');
  return {
    kind: cell.todoType,
    assignee: cell.assignee,
    taskId: taskKind ? 'task' : null,
    promotionId: promotionSource || cell.todoType === 'PROMOTION_APPROVAL' ? 'promotion' : null,
    fuseEpisodeId: cell.todoType === 'FUSE_PAUSED' ? 'episode' : null,
    askable: true,
    sourceJob: cell.sourceJob,
    failureClass: cell.failureClass,
    payload: { jobKind: cell.sourceJob, failureClass: cell.failureClass },
  };
}

/** Whether the registry that dispatches a door knows it: a ROUTE by a controller's metadata, an
 * MCP door by runner-go's tool table. This is what "the holder can really call it" reduces to for
 * a door the matrix names. */
function executableByRegistry(routes: Set<string>, names: Set<string>) {
  return (door: OpenItemDoor): boolean => door.kind === 'ROUTE'
    ? door.route != null
      && routeChoices(door.route).some((choice) => routes.has(canonicalRoute(choice)))
    : door.mcp != null && names.has(door.mcp);
}

test('every action a cell projects is a door its holder can really call', () => {
  const routes = allRouteMetadata();
  const names = mcpNames(readFileSync(MCP_SOURCE, 'utf8'));
  const canExecute = executableByRegistry(routes, names);
  for (const cell of OPEN_ITEM_DOOR_TABLE) {
    const input = rowForCell(cell);
    assert.equal(cellForOpenItem(input), cell,
      'the row a reader builds for a cell must read back as that cell');
    const where = `${cell.todoType}/${cell.sourceJob}/${cell.failureClass}/${cell.assignee}`;
    for (const action of openItemActionsFromDoors(input)) {
      const backing = cell.doors.filter((door) =>
        door.implemented && door.action === action && door.holder === cell.assignee);
      assert.ok(backing.length > 0,
        `${where}: ${action} has no implemented door held by the cell's assignee`);
      assert.ok(backing.some(canExecute),
        `${where}: ${action} is only backed by doors whose name no registry dispatches`);
    }
  }
});

/**
 * The cell this census was widened for. A failed task's RETRY is the run-again step, and each
 * holder's run-again door is their own: the coordinator calls `task_start`, and the owner presses
 * their own route — the one Run now presses — because an agent's tool is not a door a person
 * holds. Both clients send this cell's RETRY through that door; before this, both sent it to the
 * integration retry, which refuses every task that is not DONE (J-T1b, by design), so the press
 * failed every time it was made.
 */
test('a failed task’s RETRY is the run-again door its holder owns', () => {
  const routes = allRouteMetadata();
  const names = mcpNames(readFileSync(MCP_SOURCE, 'utf8'));
  const canExecute = executableByRegistry(routes, names);
  const cells = OPEN_ITEM_DOOR_TABLE.filter((cell) => cell.todoType === 'TASK_FAILED');
  assert.ok(cells.length > 0);
  for (const cell of cells) {
    const where = `TASK_FAILED/${cell.sourceJob}/${cell.failureClass}/${cell.assignee}`;
    const retries = cell.doors.filter((door) =>
      door.implemented && door.action === 'RETRY' && door.holder === cell.assignee);
    assert.ok(retries.some(canExecute),
      `${where}: no door this holder can call carries RETRY — the lead press would be refused`);
  }

  const ownerRetries = OPEN_ITEM_DOOR_TABLE
    .filter((cell) => cell.todoType === 'TASK_FAILED' && cell.assignee === 'OWNER')
    .flatMap((cell) => cell.doors)
    .filter((door) => door.action === 'RETRY' && door.kind === 'ROUTE');
  assert.ok(ownerRetries.length > 0, 'the owner holds a ROUTE door for this cell’s RETRY');
  assert.ok(ownerRetries.every((door) => door.route === '/tasks/:id/execute'),
    'the owner’s run-again door is their own route, not a runner one');

  const coordinatorRetries = OPEN_ITEM_DOOR_TABLE
    .filter((cell) => cell.todoType === 'TASK_FAILED' && cell.assignee === 'COORDINATOR')
    .flatMap((cell) => cell.doors)
    .filter((door) => door.action === 'RETRY' && door.kind === 'MCP');
  assert.ok(coordinatorRetries.some((door) => door.mcp === 'task_start' && canExecute(door)),
    'the coordinator’s run-again door is the task_start tool, and runner-go dispatches it');
});

const LANDING_SESSION_ID = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a74';

/** The row a cell reads, with the landing session its failure recorded (§4.2's payload). */
function withLandingSession(row: ReturnType<typeof sampleFor>) {
  return { ...row, payload: { ...row.payload, landingSessionId: LANDING_SESSION_ID } };
}

test('OPEN_LANDING is the last action of every integration cell that names a landing session, for both holders', () => {
  const routes = allRouteMetadata();
  const names = mcpNames(readFileSync(MCP_SOURCE, 'utf8'));
  const canExecute = executableByRegistry(routes, names);
  const cells = OPEN_ITEM_DOOR_TABLE.filter((cell) => cell.todoType.startsWith('INTEGRATION_'));
  assert.ok(cells.length > 0);
  assert.deepEqual([...new Set(cells.map((cell) => cell.assignee))].sort(), ['COORDINATOR', 'OWNER'],
    'both holders of an integration cell must be in the census');

  for (const cell of cells) {
    const where = `${cell.todoType}/${cell.sourceJob}/${cell.failureClass}/${cell.assignee}`;
    const plain = sampleFor(cell);
    const row = withLandingSession(plain);
    const actions = openItemActionsFromDoors(row);
    assert.deepEqual(actions.slice(-1), ['OPEN_LANDING'],
      `${where} does not end with OPEN_LANDING: ${actions.join(', ')}`);
    // Everything the row offered before is still there, in the same order: the press is appended,
    // never inserted ahead of a door the cell already had.
    assert.deepEqual(actions.slice(0, -1), openItemActionsFromDoors(plain),
      `${where} changed the actions it already had`);

    const door = doorsForOpenItem(row).find((candidate) => candidate.action === 'OPEN_LANDING');
    assert.ok(door, `${where} holds no OPEN_LANDING door`);
    assert.equal(door.id, 'open-landing');
    assert.equal(door.holder, cell.assignee);
    assert.equal(door.capability, 'LOOKUP');
    assert.deepEqual([...door.outcomes], []);
    assert.equal(door.resolving, false);
    assert.equal(door.implemented, true);
    if (cell.assignee === 'COORDINATOR') {
      assert.equal(door.kind, 'MCP', `${where}: the coordinator opens it with the tool`);
      assert.equal(door.mcp, 'session_get');
      assert.equal(door.route, '/runner/sessions/:id');
    } else {
      assert.equal(door.kind, 'ROUTE', `${where}: the owner opens it on their own route`);
      assert.equal(door.route, '/sessions/:id');
    }
    assert.ok(canExecute(door), `${where}: no registry dispatches this landing door`);
    // The door is the last one the cell lists, which is where the card appends it.
    assert.equal(doorsForOpenItem(row).at(-1), door, `${where}: OPEN_LANDING is not the cell's last door`);
  }
});

test('a row that names no landing session, and a kind that lands nothing, never offers OPEN_LANDING', () => {
  for (const cell of OPEN_ITEM_DOOR_TABLE) {
    const where = `${cell.todoType}/${cell.sourceJob}/${cell.failureClass}/${cell.assignee}`;
    const row = sampleFor(cell);
    assert.equal(openItemActionsFromDoors(row).includes('OPEN_LANDING'), false,
      `${where}: projected OPEN_LANDING without a landing session to open`);
    if (!cell.todoType.startsWith('INTEGRATION_')) {
      const withSession = withLandingSession(row);
      assert.equal(doorsForOpenItem(withSession).some((door) => door.action === 'OPEN_LANDING'), false,
        `${where}: a kind that lands nothing holds a landing door`);
      assert.equal(openItemActionsFromDoors(withSession).includes('OPEN_LANDING'), false,
        `${where}: a kind that lands nothing projects a landing press`);
    }
  }
});

test('an OPEN_LANDING door that is not implemented is not drawn as a press', () => {
  const cell: OpenItemDoorCell = OPEN_ITEM_DOOR_TABLE.find((candidate) =>
    candidate.todoType === 'INTEGRATION_CONFLICT' && candidate.sourceJob === 'LAND_TASK'
    && candidate.failureClass === 'CONFLICT' && candidate.assignee === 'COORDINATOR')!;
  const input = withLandingSession(sampleFor(cell));
  const held = doorsForOpenItem(input).find((door) => door.action === 'OPEN_LANDING')!;

  assert.deepEqual(appendOpenLanding(['OPEN_TASK_SESSION'], input, [held], 'COORDINATOR'),
    ['OPEN_TASK_SESSION', 'OPEN_LANDING']);
  // A matrix row that later turns the door off leaves the action list as it was: the projection's
  // hardcoded list has to carry this filter itself, because the census rows name no session.
  assert.deepEqual(appendOpenLanding(['OPEN_TASK_SESSION'], input, [{ ...held, implemented: false }], 'COORDINATOR'),
    ['OPEN_TASK_SESSION']);
  // A door held by somebody else is not this holder's press.
  assert.deepEqual(appendOpenLanding(['OPEN_TASK_SESSION'], input, [held], 'OWNER'),
    ['OPEN_TASK_SESSION']);
  // And without the session, nothing is appended even for an implemented door.
  assert.deepEqual(appendOpenLanding(['OPEN_TASK_SESSION'], sampleFor(cell), [held], 'COORDINATOR'),
    ['OPEN_TASK_SESSION']);
});

/**
 * G6: `open-item:v1`'s text is replayed byte for byte, and the payload fields this revision adds
 * are for the card, never for the message. The generators are unchanged, and this holds them
 * there: the same item with and without them renders the same words — for all three integration
 * kinds, in both scopes, and through the re-keyed preface a landed fix writes.
 */
test('the landing session, round and moved commits move no delivery text', () => {
  const ITEM = {
    id: ITEM_ID,
    title: 'Integration failed',
    projectId: PROJECT_ID,
    promotionId: null as string | null,
  };
  const addedFields = {
    landingSessionId: LANDING_SESSION_ID,
    round: 3,
    upstreamMovedCommits: { total: 1, commits: [{ sha: 'a'.repeat(40), subject: 'somebody else landed first' }] },
  };
  const landedFixes = [{
    taskId: FIX_TASK_ID,
    jobId: FIX_JOB_ID,
    state: 'LANDED',
    targetRef: 'refs/heads/project/34YhlsSkybFDaTXbOfcxM',
    landedSha: 'a'.repeat(40),
  }];
  for (const kind of ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'] as const) {
    for (const scope of [
      { label: 'a task landing', taskId: TASK_ID, promotionId: null },
      { label: 'a candidate', taskId: null, promotionId: PROMOTION_ID },
    ]) {
      for (const rekeyed of [false, true]) {
        const payload = {
          jobKind: 'LAND_TASK', phase: 'LAND_TASK', targetRef: 'refs/heads/project/x',
          files: ['src/a.ts'], errorCode: 'TARGET_MOVED', errorDetail: { why: 'the remote moved' },
          failureClass: 'ERROR', generation: 1,
        };
        const item = {
          ...ITEM, kind,
          taskId: scope.taskId, promotionId: scope.promotionId,
          payload,
          ...(rekeyed ? { landedFixes, failedSourceSha: 'b'.repeat(40) } : {}),
        };
        const before = openItemMessage(item);
        const after = openItemMessage({ ...item, payload: { ...payload, ...addedFields } });
        assert.equal(after, before,
          `${kind}/${scope.label}${rekeyed ? ' (re-keyed)' : ''}: the new payload fields moved the delivery text`);
      }
    }
  }
});
