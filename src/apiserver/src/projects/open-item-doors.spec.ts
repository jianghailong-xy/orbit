import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  KNOWN_GAPS,
  OPEN_ITEM_DOOR_ASSIGNEES,
  OPEN_ITEM_DIRECT_DOOR_TABLE,
  OPEN_ITEM_DOOR_TABLE,
  cellForOpenItem,
  knownGapsForCell,
  openItemActionsFromDoors,
  type OpenItemDoor,
  type OpenItemDoorCell,
  type OpenItemDoorInput,
} from './open-item-doors';
import { OPEN_ITEM_KINDS } from './project-open-item';

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
