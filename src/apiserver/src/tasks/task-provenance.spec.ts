import assert from 'node:assert/strict';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';

import { addTwins } from '../common/public-id-body';
import { CreatorType } from '@prisma/client';
import { TasksService } from './tasks.service';

/**
 * Unit L2 — the write path, and what the wire does with what it writes.
 *
 * Two claims, and they are the ones the schema cannot make on its own.
 *
 * The first is that provenance is SERVER-DERIVED. The incident these columns exist for is a
 * coordinator session filing a batch into a project it does not coordinate; a
 * `discoveredFromProjectId` the caller supplied would simply have named the target, and the row
 * would be exactly as indistinguishable from a deliberate one as it is today. So the interesting
 * test is not "the column can hold a value" — it is that a create which NAMES a foreign project
 * still records the scope it was actually written from.
 *
 * The second is that recording it changes nothing. `projectId` is what the caller asked for,
 * before and after; enforcement is unit L3's, and L2 refusing here would put the rule in the one
 * place the contract says it must not be — a service, ahead of the state it is supposed to leave
 * behind (§8 CM2's observe-then-enforce).
 */

const OWNER = '00000000-0000-7000-8000-000000000901';
const COORDINATED = '00000000-0000-7000-8000-000000000902';
const OTHER = '00000000-0000-7000-8000-000000000903';
const SESSION = '00000000-0000-7000-8000-000000000904';
const RUNNING_TASK = '00000000-0000-7000-8000-000000000905';
const CREATED = '00000000-0000-7000-8000-000000000906';

type SessionRow = {
  id: string;
  taskId: string | null;
  task: { projectId: string | null } | null;
  coordinatorForProject: { id: string } | null;
};

function fixture(session: SessionRow | null) {
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    project: { findFirst: async () => ({ id: OTHER }) },
    taskList: { findMany: async () => [] },
    session: { findFirst: async () => session },
    conversationTurn: { findFirst: async () => null },
    task: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...data, id: CREATED, parentTaskId: null, verifiesTaskId: null };
      },
    },
  } as never;
  const realtime = { publishTaskChanged: () => undefined } as never;
  const service = new TasksService(prisma, {} as never, realtime);
  return { service, writes };
}

const COORDINATOR_SESSION: SessionRow = {
  id: SESSION,
  taskId: RUNNING_TASK,
  task: { projectId: COORDINATED },
  coordinatorForProject: { id: COORDINATED },
};

test('a coordinator filing into another project records the scope it wrote FROM', async () => {
  const { service, writes } = fixture(COORDINATOR_SESSION);
  await service.create(
    OWNER,
    { title: 'work', projectId: OTHER } as never,
    { type: CreatorType.AGENT, id: OWNER },
    SESSION,
  );

  assert.equal(writes.length, 1);
  const row = writes[0];
  // Authority: exactly what was asked for. L2 persists the discrepancy; L3 refuses it.
  assert.equal(row.projectId, OTHER, 'the authoritative column is the caller\'s, unchanged');
  // Evidence: where the write actually came from — the comparison that was impossible before.
  assert.equal(row.discoveredFromProjectId, COORDINATED);
  assert.equal(row.sourceSessionId, SESSION);
  assert.equal(row.sourceTaskId, RUNNING_TASK);
  assert.equal(row.triggerEvent, 'coordinator.session_filed');
  assert.notEqual(
    row.discoveredFromProjectId,
    row.projectId,
    'the row worth reading is the one where the two differ — that is the whole unit',
  );
});

test('a session that coordinates nothing falls back to the project of the task it is running', async () => {
  const { service, writes } = fixture({
    id: SESSION,
    taskId: RUNNING_TASK,
    task: { projectId: COORDINATED },
    coordinatorForProject: null,
  });
  await service.create(
    OWNER, { title: 'work', projectId: OTHER } as never,
    { type: CreatorType.AGENT, id: OWNER }, SESSION,
  );
  assert.equal(writes[0].discoveredFromProjectId, COORDINATED);
  assert.equal(writes[0].triggerEvent, 'task.session_filed');
});

test('a session that is neither guesses nothing', async () => {
  const { service, writes } = fixture({
    id: SESSION, taskId: null, task: null, coordinatorForProject: null,
  });
  await service.create(
    OWNER, { title: 'work', projectId: OTHER } as never,
    { type: CreatorType.AGENT, id: OWNER }, SESSION,
  );
  // Null rather than a guess: "I could not tell" and "it came from nowhere" are the same fact, and
  // inventing a scope here is where reading this column as authority would begin.
  assert.equal(writes[0].discoveredFromProjectId, null);
  assert.equal(writes[0].sourceTaskId, null);
  assert.equal(writes[0].sourceSessionId, SESSION);
  assert.equal(writes[0].triggerEvent, 'agent.session_filed');
});

test('a user-API create records no provenance at all', async () => {
  const { service, writes } = fixture(null);
  await service.create(OWNER, { title: 'work', projectId: OTHER } as never);
  // The user is the one principal the scope contract exempts (§4 R1). There is no scope to compare
  // theirs against, so recording one would be recording a fiction.
  assert.equal(writes[0].discoveredFromProjectId, undefined);
  assert.equal(writes[0].triggerEvent, undefined);
  assert.equal(writes[0].sourceTaskId, undefined);
  assert.equal(writes[0].sourceSessionId, undefined);
});

test('nothing in a request body can reach the provenance columns', async () => {
  const { service, writes } = fixture(COORDINATOR_SESSION);
  await service.create(
    OWNER,
    {
      title: 'work',
      projectId: OTHER,
      // Everything a caller might try, in every spelling.
      discoveredFromProjectId: OTHER,
      triggerEvent: 'i.said.so',
      sourceTaskId: CREATED,
      sourceSessionId: CREATED,
    } as never,
    { type: CreatorType.AGENT, id: OWNER },
    SESSION,
  );
  const row = writes[0];
  assert.equal(row.discoveredFromProjectId, COORDINATED, 'the session decided, not the body');
  assert.equal(row.triggerEvent, 'coordinator.session_filed');
  assert.equal(row.sourceTaskId, RUNNING_TASK);
  assert.equal(row.sourceSessionId, SESSION);
});

test('the provenance ids are served in base62, in both spellings and above the machine protocol', () => {
  const body = {
    id: CREATED,
    projectId: OTHER,
    discoveredFromProjectId: COORDINATED,
    sourceTaskId: RUNNING_TASK,
    sourceSessionId: SESSION,
    triggerEvent: 'coordinator.session_filed',
  };

  // Below the machine-protocol boundary: the twin is ADDED beside the uuid.
  const dual = addTwins({ ...body }, false) as Record<string, unknown>;
  assert.equal(dual.discoveredFromProjectPublicId, uuidToBase62(COORDINATED));
  assert.equal(dual.sourceTaskPublicId, uuidToBase62(RUNNING_TASK));
  assert.equal(dual.sourceSessionPublicId, uuidToBase62(SESSION));
  assert.equal(dual.discoveredFromProjectId, COORDINATED, 'the uuid half is kept for old clients');
  assert.equal(dual.triggerEvent, 'coordinator.session_filed', 'a fact name is not an id');

  // Above it — the API every client and every model reads — base62 IS the id.
  const replaced = addTwins({ ...body }, true) as Record<string, unknown>;
  assert.equal(replaced.discoveredFromProjectId, uuidToBase62(COORDINATED));
  assert.equal(replaced.sourceTaskId, uuidToBase62(RUNNING_TASK));
  assert.equal(replaced.sourceSessionId, uuidToBase62(SESSION));
  assert.equal(replaced.projectId, uuidToBase62(OTHER));
  assert.equal(replaced.triggerEvent, 'coordinator.session_filed');
});
