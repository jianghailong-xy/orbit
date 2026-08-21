/**
 * The doors onto §13.2's relation, at the layer where a request becomes a DTO.
 *
 * `verifiesTaskId` is what makes a verification a structured fact rather than a title convention,
 * and until this unit there was no way to write it: the column existed, `verdict` refused every
 * task a caller could create, and `VERIFICATION_PASSED` counted a set nothing could add to. These
 * tests are about the two halves that decide whether the door is usable at all — the id spelling
 * a caller may hand in, and the batch rules that let a phase and its check be filed in one call.
 *
 * The refusals that need a database (a subject in another project, a check of a check, a verdict
 * concluded from the subject's own session) are in `task-verification-doors.pg.spec.ts`, against
 * a real one.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PUBLIC_ID_FIELDS, uuidToBase62 } from '@orbit/shared';
import { PROJECT_TASK_TREE_SELECT } from '../projects/projects.service';
import { CreateTaskDto, UpdateTaskDto } from './dto';
import { TASK_LIST_SELECT, TasksService } from './tasks.service';

const SUBJECT_ID = '4a2f0a1e-9c3b-4a1d-8f42-6b1c2d3e4f50';
const SUBJECT_PUBLIC_ID = uuidToBase62(SUBJECT_ID);

/** A prisma stub that owns nothing and is asked nothing — the batch rules under test are pure. */
function service() {
  const prisma = {
    workspace: { findMany: async () => [], findFirst: async () => null },
    task: { findMany: async () => [], findFirst: async () => null, count: async () => 0 },
    taskList: { findMany: async () => [], findFirst: async () => null },
    project: { findFirst: async () => null },
  };
  return new TasksService(prisma as any, {} as any, {} as any);
}

/** `previewCreateMany` runs every rule the write runs, and writes nothing. */
async function refusal(items: unknown[]): Promise<string> {
  try {
    await service().previewCreateMany('owner-1', { tasks: items } as any);
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  return '';
}

test('a caller may name the subject in base62, the spelling every door hands them', () => {
  const dto = plainToInstance(CreateTaskDto, {
    title: '[VERIFY] phase 1',
    verifiesTaskId: SUBJECT_PUBLIC_ID,
  });
  assert.deepEqual(validateSync(dto), []);
  // Decoded on the way in, exactly like parentTaskId beside it. A door that accepted only the
  // internal uuid would be one no agent could use: base62 is the only spelling task_get returns.
  assert.equal(dto.verifiesTaskId, SUBJECT_ID);
});

test('the raw uuid keeps working, and anything else is a 400 that names the field', () => {
  const raw = plainToInstance(CreateTaskDto, { title: 'x', verifiesTaskId: SUBJECT_ID });
  assert.deepEqual(validateSync(raw), []);
  assert.equal(raw.verifiesTaskId, SUBJECT_ID);

  const junk = plainToInstance(CreateTaskDto, { title: 'x', verifiesTaskId: 'not-an-id!' });
  const errors = validateSync(junk);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].property, 'verifiesTaskId');
});

test('update takes the same three states as every other link: keep, detach, re-point', () => {
  const untouched = plainToInstance(UpdateTaskDto, { title: 'x' });
  assert.deepEqual(validateSync(untouched), []);
  assert.equal(untouched.verifiesTaskId, undefined, 'omitted must not read as "detach"');

  const detach = plainToInstance(UpdateTaskDto, { verifiesTaskId: null });
  assert.deepEqual(validateSync(detach), []);
  assert.equal(detach.verifiesTaskId, null);

  const repoint = plainToInstance(UpdateTaskDto, { verifiesTaskId: SUBJECT_PUBLIC_ID });
  assert.deepEqual(validateSync(repoint), []);
  assert.equal(repoint.verifiesTaskId, SUBJECT_ID);
});

test('the id comes back base62, so nothing here leaks a raw uuid', () => {
  // The interceptor encodes by field NAME, so being in this set is the whole of the guarantee —
  // and the reason the column had to be added to the task list projection under its real name.
  assert.ok(PUBLIC_ID_FIELDS.has('verifiesTaskId'));
});

test('every projection a plan is read through carries the relation and what it concluded', () => {
  // Three surfaces, one question: looking at a list of tasks, which of these is a check, of what,
  // and what did it decide. Answering it per row means one GET per row — which is the download
  // these selects exist to avoid, so the columns have to be IN them.
  for (const [name, select] of [
    ['TASK_LIST_SELECT', TASK_LIST_SELECT],
    ['PROJECT_TASK_TREE_SELECT', PROJECT_TASK_TREE_SELECT],
  ] as const) {
    for (const field of ['verifiesTaskId', 'completionPolicy', 'verdict']) {
      assert.equal((select as Record<string, unknown>)[field], true, `${name} omits ${field}`);
    }
  }
});

test('a batch files a phase and the check on that phase in one call', async () => {
  const created = await service().previewCreateMany('owner-1', {
    tasks: [
      { title: 'Phase 1', ref: 'p1', completionPolicy: 'VERIFICATION_PASSED' },
      { title: 'Implement', parentRef: 'p1' },
      { title: '[VERIFY] Phase 1', verifiesRef: 'p1' },
    ],
  } as any);
  // The preview's job is to say what would happen, and what would happen here is three tasks and
  // no runs — none of them is assigned, so none of them starts.
  assert.equal(created.taskCount, 3);
  assert.equal(created.startingNow, 0);
});

test('a verifiesRef must name an EARLIER item, which is what makes self-verification unconstructible', async () => {
  assert.match(
    await refusal([
      { title: '[VERIFY] Phase 1', verifiesRef: 'p1' },
      { title: 'Phase 1', ref: 'p1' },
    ]),
    /verifiesRef "p1" must name an earlier task in this batch/,
  );
  assert.match(
    await refusal([{ title: 'checks itself', ref: 'me', verifiesRef: 'me' }]),
    /verifiesRef "me" must name an earlier task in this batch/,
  );
});

test('naming both spellings names two subjects, and is refused rather than resolved', async () => {
  assert.match(
    await refusal([
      { title: 'Phase 1', ref: 'p1' },
      { title: '[VERIFY]', verifiesRef: 'p1', verifiesTaskId: SUBJECT_ID },
    ]),
    /verifiesRef and verifiesTaskId name two different subjects/,
  );
});

test('a check of a check has nothing left to verify, inside a batch as well as outside one', async () => {
  assert.match(
    await refusal([
      { title: 'Phase 1', ref: 'p1' },
      { title: '[VERIFY] Phase 1', ref: 'v1', verifiesRef: 'p1' },
      { title: '[VERIFY] the verify', verifiesRef: 'v1' },
    ]),
    /itself a verification/,
  );
});

test('a check and its subject must share a project, or nothing will ever count it', async () => {
  // The quiet one. Aggregation plans over one project's tasks, so a check filed across that line
  // is counted by nobody — and `VERIFICATION_PASSED` reads "no checks" as "nothing outstanding"
  // only because it separately requires at least one pass. Refusing here is what keeps the two
  // halves of that rule from ever disagreeing.
  assert.match(
    await refusal([
      { title: 'Phase 1', ref: 'p1', projectId: SUBJECT_ID },
      { title: '[VERIFY] Phase 1', verifiesRef: 'p1' },
    ]),
    /must be in the same project as the task it verifies/,
  );
});
