import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PUBLIC_ID_FIELDS, uuidToBase62 } from '@orbit/shared';
import { UpdateProjectDto } from './dto';
import { ProjectsService } from './projects.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';

/** The acceptance service this controller also takes. A double rather than a real one: every
 *  scenario in this file is about the project routes, and a scenario that reached acceptance would
 *  say so by failing here. */
function acceptanceDouble(): never {
  return {
    overview: async () => assert.fail('this scenario does not read acceptance'),
    openRun: async () => assert.fail('this scenario does not open an acceptance run'),
    finalizeRun: async () => assert.fail('this scenario does not conclude an acceptance run'),
    recordMergeEvidence: async () => assert.fail('this scenario does not record merge evidence'),
  } as never;
}


const { PrismaClientKnownRequestError } = Prisma;

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000a1';
const AGENT_ID = '00000000-0000-7000-8000-0000000000b1';
const AGENT_OTHER = '00000000-0000-7000-8000-0000000000b2';
const SESSION_ID = '00000000-0000-7000-8000-0000000000c1';

/**
 * Who coordinates a project, where its coordination runs, and how far it may act — the three
 * facts this unit persists, and the rules that decide what may write them.
 *
 * Everything here is about the DIFFERENCE between a project that existed before this feature and
 * one created after it. The two populations have to differ by a decision somebody made, not by
 * when they happened to be created, and the way that is arranged (column defaults protecting the
 * old rows, the service writing the new values explicitly) is what most of this file asserts.
 */

interface Fixture {
  /** What the project row says before the update under test. */
  project?: { coordinatorEnabled?: boolean } | null;
  /** The coordinator membership that already exists, if any. */
  coordinator?: { id: string; agentId: string } | null;
  /** Agents this owner has that are not deleted. */
  agents?: string[];
  /** The member write raises this — the partial unique index, or a vanished agent. */
  memberWriteFails?: Error;
}

function makeService(fx: Fixture = {}) {
  const projectWrites: any[] = [];
  const memberWrites: string[] = [];
  /** Where the identity each member write establishes came from — the same transaction, one row. */
  const runtimeWrites: string[] = [];
  const agents = fx.agents ?? [AGENT_ID, AGENT_OTHER];
  let coordinator = fx.coordinator === undefined ? null : fx.coordinator;

  const prisma: any = {
    project: {
      findFirst: async () =>
        fx.project === null
          ? null
          : { id: PROJECT_ID, coordinatorEnabled: fx.project?.coordinatorEnabled ?? false },
      create: async (args: any) => {
        projectWrites.push(args.data);
        return {
          id: PROJECT_ID,
          ...args.data,
          members: [],
          runtime: { coordinatorGeneration: 0n },
        };
      },
      update: async (args: any) => {
        projectWrites.push(args.data);
        return {
          id: PROJECT_ID,
          ...args.data,
          members: coordinator ? [{ agentId: coordinator.agentId }] : [],
          runtime: { coordinatorGeneration: 3n },
        };
      },
    },
    projectMember: {
      findFirst: async () => coordinator,
      create: async ({ data }: any) => {
        if (fx.memberWriteFails) throw fx.memberWriteFails;
        memberWrites.push(`create:${data.agentId}:${data.role}`);
        coordinator = { id: 'member-new', agentId: data.agentId };
        return coordinator;
      },
      update: async ({ where, data }: any) => {
        if (fx.memberWriteFails) throw fx.memberWriteFails;
        memberWrites.push(`update:${where.id}:${data.agentId}`);
        coordinator = { id: where.id, agentId: data.agentId };
        return coordinator;
      },
      delete: async ({ where }: any) => {
        memberWrites.push(`delete:${where.id}`);
        coordinator = null;
        return { id: where.id };
      },
    },
    projectRuntime: {
      // An upsert because a project an old writer inserted has no runtime row until the deferred
      // trigger gives it one at COMMIT, which is after this runs.
      upsert: async ({ where, update }: any) => {
        runtimeWrites.push(`${where.projectId}:${update.coordinatorIdentitySource}`);
        return { projectId: where.projectId, ...update };
      },
    },
    workspace: {
      // Honours owner and soft-deletion, so the check's own test cannot pass with the check gone.
      findFirst: async ({ where }: any) =>
        where.ownerId === OWNER_ID && where.deletedAt === null && agents.includes(where.id)
          ? { id: where.id }
          : null,
    },
    $queryRaw: async () => [{ id: PROJECT_ID }],
  };
  prisma.$transaction = async (fn: any) => fn(prisma);

  const sessions = {
    create: async () => ({ id: SESSION_ID }),
  };

  return {
    projectWrites,
    memberWrites,
    runtimeWrites,
    service: new ProjectsService(prisma as never, sessions as never),
  };
}

// ── What a new project starts as, and what an old one keeps (§12.1 G1) ────────────────────────

test('a new project is created coordinated, at the guarded level, with its runtime row', async () => {
  const f = makeService();

  const project = await f.service.create(OWNER_ID, { title: 'Ship it' } as never);

  // Written EXPLICITLY rather than left to the column defaults, which say the opposite. That pair
  // is what keeps the migration from turning every project that already exists into an automatic
  // one, while still making "somebody recorded this to have it coordinated" the new default.
  assert.equal(f.projectWrites[0].coordinatorEnabled, true);
  assert.equal(f.projectWrites[0].automationPolicy, 'GUARDED_AUTO');
  // The control loop's row comes with the project, so "does this project have one" is never a
  // question a later reader has to answer with a fallback.
  assert.deepEqual(f.projectWrites[0].runtime, { create: {} });
  assert.equal(project.coordinatorAgentId, null);
  assert.equal(project.coordinatorGeneration, 0n);
});

test('a project recorded from a session is coordinated by that session’s agent', async () => {
  const f = makeService();
  const prisma: any = (f.service as any).prisma;
  prisma.session = {
    findFirst: async () => ({ workspaceId: AGENT_ID }),
  };

  await f.service.createInSession(OWNER_ID, 'runner-1', uuidToBase62(SESSION_ID), {
    title: 'Planned here',
  } as never);

  // The conversation the project was planned in is bound as its coordinator SESSION; the agent
  // running that conversation is bound as its coordinator AGENT. The first is replaceable, the
  // second is the identity that survives every replacement — and both are nested writes of the
  // same insert, so no project can exist half-bound.
  assert.equal(f.projectWrites[0].coordinatorSessionId, SESSION_ID);
  assert.deepEqual(f.projectWrites[0].members, {
    create: { agentId: AGENT_ID, role: 'COORDINATOR' },
  });
});

test('the column defaults are the opposite of the new-project defaults, and nothing rewrites them', () => {
  const sql = readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/0111_project_coordinator_identity/migration.sql'),
    'utf8',
  );

  assert.match(sql, /"coordinator_enabled" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /"automation_policy" "project_automation_policy" NOT NULL DEFAULT 'MANUAL'/);
  // No project that already exists is switched on by this migration — not by an UPDATE, and not by
  // a default that means "automatic". A project already running under the old behaviour must come
  // out of the migration exactly as silent as it went in.
  assert.doesNotMatch(sql, /UPDATE\s+"project"/i);
  assert.doesNotMatch(sql, /coordinator_enabled"?\s*=\s*true/i);
  // And nothing is taken away: a column dropped here would break the previous build the moment it
  // is deployed, which is the property that makes this migration safe to land first.
  assert.doesNotMatch(sql, /DROP COLUMN/i);
});

// ── Turning it on is a decision, not an inheritance (§12.1 G3) ────────────────────────────────

test('switching a project into automation requires saying how far it may go', async () => {
  const f = makeService({ project: { coordinatorEnabled: false } });

  await assert.rejects(
    () => f.service.update(OWNER_ID, PROJECT_ID, { coordinatorEnabled: true } as never),
    (e: any) => e.status === 400 && /automationPolicy/.test(e.message),
  );
  assert.deepEqual(f.projectWrites, []);
});

test('naming the level in the same request is what turns it on', async () => {
  const f = makeService({ project: { coordinatorEnabled: false } });

  await f.service.update(OWNER_ID, PROJECT_ID, {
    coordinatorEnabled: true,
    automationPolicy: 'MANUAL',
  } as never);

  assert.equal(f.projectWrites[0].coordinatorEnabled, true);
  assert.equal(f.projectWrites[0].automationPolicy, 'MANUAL');
});

test('a project that is already coordinated changes one field at a time', async () => {
  const f = makeService({ project: { coordinatorEnabled: true } });

  // Already enabled: the level exists and its owner is looking at it, so a budget change does not
  // have to restate it.
  await f.service.update(OWNER_ID, PROJECT_ID, { maxConcurrentTasks: 5 } as never);
  // Turning it OFF never needs one either — "stop" is unambiguous.
  await f.service.update(OWNER_ID, PROJECT_ID, { coordinatorEnabled: false } as never);

  assert.equal(f.projectWrites[0].maxConcurrentTasks, 5);
  assert.equal(f.projectWrites[1].coordinatorEnabled, false);
});

// ── The authorization set, and its revision (§9.6 AU2/AU3) ────────────────────────────────────

test('the authorization set is exactly the four fields that decide what may happen', () => {
  assert.deepEqual(
    [...ProjectsService.AUTHORIZATION_FIELDS],
    ['coordinatorEnabled', 'automationPolicy', 'maxConcurrentTasks', 'sessionBudgetPerDay'],
  );
  // Who decides is not the same question as what a decider may do: the two are set, revoked and
  // read separately, so the coordinator's identity is deliberately not in the set above.
  assert.equal(
    (ProjectsService.AUTHORIZATION_FIELDS as readonly string[]).includes('coordinatorAgentId'),
    false,
  );
});

test('writing any of them bumps the revision once, and prose never does', async () => {
  const f = makeService({ project: { coordinatorEnabled: true } });

  await f.service.update(OWNER_ID, PROJECT_ID, { goal: 'A goal', title: 'Renamed' } as never);
  await f.service.update(OWNER_ID, PROJECT_ID, { maxConcurrentTasks: 2 } as never);
  await f.service.update(OWNER_ID, PROJECT_ID, {
    automationPolicy: 'AUTO',
    maxConcurrentTasks: 4,
    sessionBudgetPerDay: 40,
    coordinatorEnabled: true,
  } as never);

  // Prose is not authorization: a renamed project has not become more or less permitted to do
  // anything, and a revision that moved for it would make every audit of a revoke read as a race.
  assert.equal(f.projectWrites[0].configRevision, undefined);
  assert.deepEqual(f.projectWrites[1].configRevision, { increment: 1 });
  // One bump per write, however many of the four it carried: a revision is a version of the set,
  // not a count of columns.
  assert.deepEqual(f.projectWrites[2].configRevision, { increment: 1 });
});

test('the revision is incremented, never read and written back', async () => {
  const f = makeService({ project: { coordinatorEnabled: true } });

  await f.service.update(OWNER_ID, PROJECT_ID, { sessionBudgetPerDay: null } as never);

  // A read-then-write would let two writes land on the same number, which is precisely what a
  // revision is for ruling out. `null` is a value here — it clears the budget — so it counts.
  assert.deepEqual(f.projectWrites[0].configRevision, { increment: 1 });
  assert.equal(f.projectWrites[0].sessionBudgetPerDay, null);
});

// ── The coordinator agent: one per project, and it outlives every session ─────────────────────

test('setting a coordinator agent writes one membership row', async () => {
  const f = makeService({ coordinator: null });

  const project = await f.service.update(OWNER_ID, PROJECT_ID, {
    coordinatorAgentId: AGENT_ID,
  } as never);

  assert.deepEqual(f.memberWrites, [`create:${AGENT_ID}:COORDINATOR`]);
  assert.equal(project.coordinatorAgentId, AGENT_ID);
  // And, in the same transaction, that this identity was CHOSEN. Without it the next writer that
  // only knows the 0110 columns relocates the coordination workspace and the database re-derives
  // the identity from it — a change to WHO nobody authorized (validation 04R2, P1-04R2-01).
  assert.deepEqual(f.runtimeWrites, [`${PROJECT_ID}:EXPLICIT`]);
  // Not part of the authorization set — see the test above — so it moves no revision.
  assert.equal(f.projectWrites[0].configRevision, undefined);
});

test('replacing one edits the row rather than dropping and re-adding it', async () => {
  const f = makeService({ coordinator: { id: 'member-1', agentId: AGENT_ID } });

  await f.service.update(OWNER_ID, PROJECT_ID, { coordinatorAgentId: AGENT_OTHER } as never);

  // A delete/insert pair would make the project briefly uncoordinated inside the transaction, for
  // no reason: the membership IS the identity, and identity changing hands is one write.
  assert.deepEqual(f.memberWrites, [`update:member-1:${AGENT_OTHER}`]);
});

test('naming the agent that already coordinates it writes nothing', async () => {
  const f = makeService({ coordinator: { id: 'member-1', agentId: AGENT_ID } });

  await f.service.update(OWNER_ID, PROJECT_ID, { coordinatorAgentId: AGENT_ID } as never);

  assert.deepEqual(f.memberWrites, []);
  // Except the one thing this request is the only evidence of. A seat that equals the project's
  // landing is exactly what a DERIVED identity looks like, so an owner naming it is the one case
  // the database cannot recognise from the rows afterwards — and the case that would otherwise
  // silently follow the landing the next time an old writer moved it.
  assert.deepEqual(f.runtimeWrites, [`${PROJECT_ID}:EXPLICIT`]);
});

test('clearing it removes the membership and leaves the project', async () => {
  const f = makeService({ coordinator: { id: 'member-1', agentId: AGENT_ID } });

  const project = await f.service.update(OWNER_ID, PROJECT_ID, {
    coordinatorAgentId: null,
  } as never);

  assert.deepEqual(f.memberWrites, ['delete:member-1']);
  assert.equal(project.coordinatorAgentId, null);
  // "This project has no coordinator" is a decision too, and the membership row that would have
  // carried it is the row this request deleted — so it is recorded on the runtime row, where a
  // later landing event can still find it and decline to seat one.
  assert.deepEqual(f.runtimeWrites, [`${PROJECT_ID}:EXPLICIT`]);
});

test('an agent that is not this owner’s live agent is refused, in one wording', async () => {
  for (const id of [AGENT_ID, AGENT_OTHER]) {
    const f = makeService({ agents: [] }); // unknown, another owner's, or soft-deleted
    await assert.rejects(
      () => f.service.update(OWNER_ID, PROJECT_ID, { coordinatorAgentId: id } as never),
      (e: any) => e.status === 400 && /no such agent/.test(e.message),
    );
    // Refused before anything is written, so a bad id cannot bump a revision or move a member row.
    assert.deepEqual(f.memberWrites, []);
    assert.deepEqual(f.projectWrites, []);
  }
});

test('a second coordinator racing in is the rule the index states, not a 500', async () => {
  const f = makeService({
    coordinator: null,
    memberWriteFails: new PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    }),
  });

  await assert.rejects(
    () => f.service.update(OWNER_ID, PROJECT_ID, { coordinatorAgentId: AGENT_ID } as never),
    (e: any) => e.status === 409 && /already has a coordinator/.test(e.message),
  );
});

test('an agent deleted between the check and the write reads as the same refusal', async () => {
  const f = makeService({
    coordinator: null,
    memberWriteFails: new PrismaClientKnownRequestError('Foreign key constraint failed', {
      code: 'P2003',
      clientVersion: 'test',
    }),
  });

  await assert.rejects(
    () => f.service.update(OWNER_ID, PROJECT_ID, { coordinatorAgentId: AGENT_ID } as never),
    (e: any) => e.status === 400 && /no such agent/.test(e.message),
  );
});

test('a project response says who coordinates it and how often that conversation has been replaced', async () => {
  const f = makeService({ coordinator: { id: 'member-1', agentId: AGENT_ID } });

  const project: any = await f.service.update(OWNER_ID, PROJECT_ID, { title: 'Renamed' } as never);

  assert.equal(project.coordinatorAgentId, AGENT_ID);
  assert.equal(project.coordinatorGeneration, 3n);
  // The rows themselves are not the API: a `members` array in every project payload would be a
  // team endpoint nobody designed.
  assert.equal('members' in project, false);
  assert.equal('runtime' in project, false);
});

// ── Which door may write them (PAC §8.2) ──────────────────────────────────────────────────────

test('an agent cannot widen its own authority through the runner door', async () => {
  const projects = { update: async () => assert.fail('the refusal must come before the write') };
  const controller = new RunnerProjectsController(projects as never, acceptanceDouble(), {} as never);
  const runner = { ownerId: OWNER_ID, id: 'runner-1' } as never;

  for (const field of [...ProjectsService.AUTHORIZATION_FIELDS, 'coordinatorAgentId']) {
    const dto = { [field]: field === 'coordinatorAgentId' ? AGENT_ID : 1 } as never;
    assert.throws(
      () => controller.updateProject(runner, PROJECT_ID, undefined, dto),
      (e: any) => e.status === 403 && e.message.includes(field),
      `${field} must not be writable with a runner credential`,
    );
  }
});

test('the runner door still carries everything an agent may say about the work', async () => {
  const seen: any[] = [];
  const projects = {
    update: async (...args: any[]) => {
      seen.push(args);
      return { id: PROJECT_ID };
    },
  };
  const controller = new RunnerProjectsController(projects as never, acceptanceDouble(), {} as never);

  await controller.updateProject({ ownerId: OWNER_ID, id: 'runner-1' } as never, PROJECT_ID, undefined, {
    goal: 'A goal it worked out',
    status: 'DONE',
  } as never);

  assert.deepEqual(seen[0][2], { goal: 'A goal it worked out', status: 'DONE' });
});

// ── The wire: base62 in, base62 out, bounds checked ───────────────────────────────────────────

test('the coordinator’s agent is a public id in both directions', () => {
  // Encoded on the way out by the interceptor and decoded on the way in by the DTO — a name that
  // is in neither list reaches a `::uuid` cast as a base62 string, which is a 500 nobody can act
  // on. `agentId` is the same id under the name the membership row uses.
  assert.equal(PUBLIC_ID_FIELDS.has('coordinatorAgentId'), true);
  assert.equal(PUBLIC_ID_FIELDS.has('agentId'), true);
});

async function validateDto(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdateProjectDto, payload);
  const errors = await validate(dto as object);
  return errors.map((e) => e.property);
}

test('a base62 coordinatorAgentId arrives as the uuid the column keys by', async () => {
  const dto = plainToInstance(UpdateProjectDto, { coordinatorAgentId: uuidToBase62(AGENT_ID) });

  assert.deepEqual(await validate(dto as object), []);
  assert.equal(dto.coordinatorAgentId, AGENT_ID);
});

test('the budgets refuse the value nobody meant', async () => {
  assert.deepEqual(await validateDto({ maxConcurrentTasks: 1 }), []);
  assert.deepEqual(await validateDto({ maxConcurrentTasks: 100 }), []);
  // Zero is not a budget: "run nothing" is already spelled by coordinatorEnabled false and by
  // MANUAL, both of which a reader can tell apart from a cap that silently admits nothing.
  assert.deepEqual(await validateDto({ maxConcurrentTasks: 0 }), ['maxConcurrentTasks']);
  assert.deepEqual(await validateDto({ maxConcurrentTasks: 101 }), ['maxConcurrentTasks']);
  assert.deepEqual(await validateDto({ maxConcurrentTasks: 2.5 }), ['maxConcurrentTasks']);
  // null is how a daily budget is cleared, and it is the only field of the four that has one.
  assert.deepEqual(await validateDto({ sessionBudgetPerDay: null }), []);
  assert.deepEqual(await validateDto({ sessionBudgetPerDay: 0 }), ['sessionBudgetPerDay']);
  assert.deepEqual(await validateDto({ automationPolicy: 'GUARDED_AUTO' }), []);
  assert.deepEqual(await validateDto({ automationPolicy: 'SOMETIMES' }), ['automationPolicy']);
  assert.deepEqual(await validateDto({ coordinatorEnabled: 'yes' }), ['coordinatorEnabled']);
});

// ── Sent-as-null is a value, not an omission (validation 04, P1-05) ────────────────────────────
//
// `@IsOptional()` skips `undefined` AND `null`, so `null` on a NOT NULL column used to pass every
// validator on its property, reach Prisma, and come back as a `PrismaClientValidationError` — no
// status, no code, a 500 for a request that was simply invalid. The three fields below have no
// "cleared" state to spell; `sessionBudgetPerDay` does, and keeps it.

/** The pipe exactly as `main.ts` configures it, which is the one both doors go through. */
const appPipe = () =>
  new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });

const BODY = { type: 'body', metatype: UpdateProjectDto } as const;

test('an explicit null on a NOT NULL policy field is refused, not forwarded', async () => {
  for (const field of ['coordinatorEnabled', 'automationPolicy', 'maxConcurrentTasks']) {
    assert.deepEqual(await validateDto({ [field]: null }), [field], `${field}: null is a value`);
    await assert.rejects(
      () => appPipe().transform({ [field]: null }, BODY as never),
      (e: { status?: number }) => e.status === 400,
      `${field}: the door must answer 400 rather than let Prisma answer`,
    );
  }
});

test('omitting those fields still means "leave them alone"', async () => {
  // The distinction being drawn, and the reason this is not just "reject null everywhere": a
  // request that does not mention a field must go on writing nothing to it.
  const forwarded = await appPipe().transform({ title: 'renamed' }, BODY as never);

  assert.deepEqual(await validateDto({}), []);
  // `undefined` is what the service reads as "not sent" — every write it builds is keyed on
  // `!== undefined`. (The key itself may exist: class-transformer materialises declared
  // properties, which is exactly why `in` is not the question.)
  assert.equal(forwarded.coordinatorEnabled, undefined);
  assert.equal(forwarded.automationPolicy, undefined);
  assert.equal(forwarded.maxConcurrentTasks, undefined);
});

test('the one field that can be cleared still can be', async () => {
  const forwarded = await appPipe().transform({ sessionBudgetPerDay: null }, BODY as never);

  assert.equal(forwarded.sessionBudgetPerDay, null);
  assert.notEqual(forwarded.sessionBudgetPerDay, undefined, 'cleared is not the same as unsent');
});

test('the runner door refuses those nulls too, before anything can be written', async () => {
  // Two independent refusals, in the order a request meets them: the shared pipe answers 400, and
  // a caller that somehow got past it still meets `refuseGovernance` — which counts a field as
  // NAMED when it is null, so nothing reaches the service either way.
  const projects = { update: async () => assert.fail('the refusal must come before the write') };
  const controller = new RunnerProjectsController(projects as never, acceptanceDouble(), {} as never);
  const runner = { ownerId: OWNER_ID, id: 'runner-1' } as never;

  for (const field of ['coordinatorEnabled', 'automationPolicy', 'maxConcurrentTasks']) {
    await assert.rejects(
      () => appPipe().transform({ [field]: null }, BODY as never),
      (e: { status?: number }) => e.status === 400,
      `${field}: the runner door goes through the same pipe`,
    );
    assert.throws(
      () => controller.updateProject(runner, PROJECT_ID, undefined, { [field]: null } as never),
      (e: { status?: number }) => e.status === 403,
      `${field}: and the door itself does not treat null as unsent`,
    );
  }
});
