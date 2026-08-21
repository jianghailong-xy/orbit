import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PrismaClient } from '@prisma/client';

import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * Unit 02A, the persistence half: an Agent written and read back through the generated client, on
 * the schema `prisma migrate deploy` really produces.
 *
 * Driven through Prisma rather than through raw SQL on purpose. The migration spec next door
 * already asserts what the DDL builds; what this one adds is that `schema.prisma` and that DDL
 * agree — a model whose defaults or column names have drifted from the migration compiles fine and
 * fails only at runtime, and 03A's service layer is written against the model, not the SQL.
 *
 * There is no Agent API yet (03A), so the owner boundary is asserted where it is actually enforced
 * at this stage: the owner-scoped query every read path is built from. `02A.5`'s 403 is the same
 * fact stated at the HTTP door and belongs with the door.
 *
 * Cases: 02A.1 (create with a name alone; every field reads back), 02A.2 (a soft-deleted name is
 * free again), 02A.3 (a live duplicate is refused), 02A.5 (tenant isolation), and the selector
 * half of 02A.9.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

const OWNER_A = '00000000-0000-7000-8000-00000000a101';
const OWNER_B = '00000000-0000-7000-8000-00000000b101';

async function connect(): Promise<PrismaClient> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const prisma = prismaClientFor(URL);
  // This suite owns the two tenants it names and nothing else, so it removes its own rows rather
  // than truncating tables another spec on the same disposable database may be using.
  await prisma.agent.deleteMany({ where: { ownerId: { in: [OWNER_A, OWNER_B] } } });
  await prisma.user.deleteMany({ where: { id: { in: [OWNER_A, OWNER_B] } } });
  await prisma.user.createMany({
    data: [
      { id: OWNER_A, email: 'owner-a@agents.test', name: 'A', passwordHash: 'x' },
      { id: OWNER_B, email: 'owner-b@agents.test', name: 'B', passwordHash: 'x' },
    ],
  });
  return prisma;
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.agent.deleteMany({ where: { ownerId: { in: [OWNER_A, OWNER_B] } } });
  await prisma.user.deleteMany({ where: { id: { in: [OWNER_A, OWNER_B] } } });
  await prisma.$disconnect();
}

test('02A.1 a name is enough to create one, and the defaults are the closed ones', { skip },
  async () => {
    const prisma = await connect();
    try {
      const agent = await prisma.agent.create({ data: { ownerId: OWNER_A, name: 'reviewer' } });

      // Everything else is optional, and every default is the one that grants nothing and changes
      // nothing: no provider opinion (§3.1), no downgrade path (§7.4), no requirement, no
      // permission. A default that granted something would grant it to every Agent ever created.
      assert.equal(agent.description, null);
      assert.equal(agent.role, null);
      assert.equal(agent.systemPrompt, null);
      assert.equal(agent.appendSystemPrompt, null);
      assert.equal(agent.defaultProvider, null);
      assert.equal(agent.defaultModel, null);
      assert.equal(agent.defaultEffort, null);
      assert.deepEqual(agent.providerFallbacks, []);
      assert.deepEqual(agent.disallowedTools, []);
      // Non-null on both sides: the client types this `String[]`, and the column is NOT NULL so a
      // raw-SQL writer cannot hand a later reader the null its type says cannot happen. The
      // migration spec asserts the refusal; this asserts the value the default actually produces.
      assert.deepEqual(agent.requiredCapabilities, []);
      assert.notEqual(agent.requiredCapabilities, null);
      assert.equal(agent.canCreateTasks, false);
      assert.equal(agent.canDelegate, false);
      assert.equal(agent.enabled, true);
      assert.equal(agent.deletedAt, null);
      // A hand-created Agent is never a mirror (§3.1).
      assert.equal(agent.legacyWorkspaceId, null);
    } finally {
      await cleanup(prisma);
    }
  });

test('02A.1 every configured field reads back', { skip }, async () => {
  const prisma = await connect();
  try {
    const written = await prisma.agent.create({
      data: {
        ownerId: OWNER_A,
        name: 'ios build',
        description: 'ships the iOS client',
        role: 'dev',
        systemPrompt: 'you build iOS',
        appendSystemPrompt: 'run the Mac CI',
        defaultProvider: 'claude',
        defaultModel: 'claude-opus-5',
        defaultEffort: 'high',
        providerFallbacks: [{ provider: 'codex', model: 'gpt-5' }],
        disallowedTools: ['WebSearch'],
        requiredCapabilities: ['macos', 'xcode'],
        canCreateTasks: true,
        canDelegate: true,
      },
    });
    const read = await prisma.agent.findFirst({ where: { id: written.id, ownerId: OWNER_A } });
    assert.ok(read);
    assert.equal(read.defaultProvider, 'claude');
    assert.equal(read.defaultModel, 'claude-opus-5');
    assert.equal(read.defaultEffort, 'high');
    // The one that has to survive the round trip as a STRUCTURE: an ordered fallback list read
    // back as a string, or reordered, is a different set of instructions (§7.4).
    assert.deepEqual(read.providerFallbacks, [{ provider: 'codex', model: 'gpt-5' }]);
    assert.deepEqual(read.disallowedTools, ['WebSearch']);
    assert.deepEqual(read.requiredCapabilities, ['macos', 'xcode']);
    assert.equal(read.canCreateTasks, true);
    assert.equal(read.canDelegate, true);
    assert.equal(read.role, 'dev');
  } finally {
    await cleanup(prisma);
  }
});

test('02A.3 the same owner cannot hold the same live name twice', { skip }, async () => {
  const prisma = await connect();
  try {
    await prisma.agent.create({ data: { ownerId: OWNER_A, name: 'dev' } });
    await assert.rejects(
      () => prisma.agent.create({ data: { ownerId: OWNER_A, name: 'dev' } }),
      (error: { code?: string }) => error.code === 'P2002',
      'A2: the live (owner, name) pair is unique, and it is the DATABASE that says so',
    );
  } finally {
    await cleanup(prisma);
  }
});

test('02A.2 a soft-deleted name is free again', { skip }, async () => {
  const prisma = await connect();
  try {
    const first = await prisma.agent.create({ data: { ownerId: OWNER_A, name: 'dev' } });
    await prisma.agent.update({ where: { id: first.id }, data: { deletedAt: new Date() } });

    // The whole reason A2's index is partial. Under a total unique index, deleting an Agent called
    // "dev" would mean never having a "dev" again — a name held for ever by a row nothing shows.
    const second = await prisma.agent.create({ data: { ownerId: OWNER_A, name: 'dev' } });
    assert.notEqual(second.id, first.id);

    // And both rows are still there: a soft delete keeps history resolvable.
    const all = await prisma.agent.findMany({ where: { ownerId: OWNER_A, name: 'dev' } });
    assert.equal(all.length, 2);

    // Two soft-deleted rows may share a name too — they are outside the index entirely, so a second
    // delete cannot be refused by a name somebody already gave up.
    await prisma.agent.update({ where: { id: second.id }, data: { deletedAt: new Date() } });
    const live = await prisma.agent.findMany({
      where: { ownerId: OWNER_A, deletedAt: null },
    });
    assert.deepEqual(live, []);
  } finally {
    await cleanup(prisma);
  }
});

test('02A.5 one owner never reads or writes another owner\'s Agent', { skip }, async () => {
  const prisma = await connect();
  try {
    const theirs = await prisma.agent.create({ data: { ownerId: OWNER_B, name: 'theirs' } });

    // The read every list is built from. Scoped by owner, the other tenant's row is not there —
    // and a lookup by a KNOWN id is scoped the same way, which is the case an `findUnique({ id })`
    // written for convenience quietly gets wrong.
    assert.deepEqual(await prisma.agent.findMany({ where: { ownerId: OWNER_A } }), []);
    assert.equal(await prisma.agent.findFirst({ where: { id: theirs.id, ownerId: OWNER_A } }), null);

    // The write, stated the same way: an owner-scoped update matches nothing rather than editing
    // somebody else's identity. `updateMany` because that is the shape that carries the filter.
    const updated = await prisma.agent.updateMany({
      where: { id: theirs.id, ownerId: OWNER_A },
      data: { name: 'stolen' },
    });
    assert.equal(updated.count, 0);
    const untouched = await prisma.agent.findUnique({ where: { id: theirs.id } });
    assert.equal(untouched?.name, 'theirs');

    // Names are unique per tenant, not globally: the same name on both sides is not a conflict.
    await prisma.agent.create({ data: { ownerId: OWNER_A, name: 'theirs' } });
  } finally {
    await cleanup(prisma);
  }
});

test('02A.9 neither a deleted nor a disabled Agent is in the assignable set', { skip }, async () => {
  const prisma = await connect();
  try {
    await prisma.agent.create({ data: { ownerId: OWNER_A, name: 'live' } });
    await prisma.agent.create({
      data: { ownerId: OWNER_A, name: 'gone', deletedAt: new Date() },
    });
    await prisma.agent.create({ data: { ownerId: OWNER_A, name: 'off', enabled: false } });
    // A mirror is not special. §3.1 A4: mirrored rows and hand-made rows are treated identically
    // on every read path, so `legacyWorkspaceId` changes nothing about who can be assigned.
    await prisma.agent.create({
      data: {
        ownerId: OWNER_A,
        name: 'mirrored',
        legacyWorkspaceId: '00000000-0000-7000-8000-00000000c101',
      },
    });

    const assignable = await prisma.agent.findMany({
      where: { ownerId: OWNER_A, deletedAt: null, enabled: true },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    assert.deepEqual(assignable.map((a) => a.name), ['live', 'mirrored']);
  } finally {
    await cleanup(prisma);
  }
});
