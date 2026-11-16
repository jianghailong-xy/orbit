import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { managedRunnerWorld } from '../test-support/managed-runner-world';

const URL = process.env.COORDINATOR_PG_URL;
const migration = readFileSync(path.join(__dirname, '..', '..', 'prisma', 'migrations', '0930_managed_runner_no_default_workspace', 'migration.sql'), 'utf8');

test('0930 releases only unused default workspaces, and a second pass changes nothing', { skip: !URL, timeout: 60_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  const w = managedRunnerWorld(db);
  const fixtures = [];
  for (const use of ['unused', 'session', 'task', 'project'] as const) {
    const ownerId = await w.makeUser(`migration-${use}`);
    await w.service.ensure(ownerId, `migration-${use}`);
    const mapping = await w.mappingOf(ownerId);
    assert.equal(mapping.defaultWorkspaceId, null);
    const workspace = await db.workspace.create({ data: { ownerId, runnerId: mapping.runnerId, targetRunnerId: mapping.runnerId, name: 'Default', workDir: '/tmp/default' } });
    await db.managedRunner.update({ where: { id: mapping.id }, data: { defaultWorkspaceId: workspace.id } });
    if (use === 'session') {
      await db.session.create({ data: { ownerId, creatorId: ownerId, workspaceId: workspace.id, assignedRunnerId: mapping.runnerId, title: 'Earlier conversation', prompt: 'hello', provider: 'claude' } });
    } else if (use === 'task') {
      await db.task.create({ data: { ownerId, creatorType: 'USER', creatorId: ownerId, title: 'Earlier task', completionCriterion: 'EVIDENCE_JUDGMENT', assigneeId: workspace.id } });
    } else if (use === 'project') {
      const project = await db.project.create({ data: { ownerId, title: 'Earlier project' } });
      await db.projectMember.create({ data: { projectId: project.id, agentId: workspace.id, role: 'MEMBER' } });
    }
    fixtures.push({ use, mappingId: mapping.id, workspaceId: workspace.id });
  }
  const snapshot = async () => Promise.all(fixtures.map(async (f) => ({
    use: f.use,
    mapping: await db.managedRunner.findUniqueOrThrow({ where: { id: f.mappingId } }),
    workspace: await db.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } }),
  })));
  const before = await snapshot();
  await sql.query(migration);
  const after = await snapshot();
  for (let i = 0; i < fixtures.length; i += 1) {
    const f = fixtures[i];
    if (f.use === 'unused') {
      assert.equal(after[i].mapping.defaultWorkspaceId, null);
      assert.ok(after[i].workspace.deletedAt);
    } else {
      assert.deepEqual(after[i], before[i], `${f.use} keeps the mapping and workspace unchanged`);
    }
  }
  await sql.query(migration);
  assert.deepEqual(await snapshot(), after, 'running the entire migration twice is idempotent');
});
