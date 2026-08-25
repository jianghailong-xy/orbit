import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectsService } from './projects.service';
import { SessionsService } from '../sessions/sessions.service';

const OWNER = '00000000-0000-7000-8000-000000000001';
const PROJECT = '00000000-0000-7000-8000-0000000000a1';
const SESSION = '00000000-0000-7000-8000-0000000000b1';

function fixture(managed = true) {
  const project = {
    id: PROJECT,
    ownerId: OWNER,
    title: 'Initial project',
    coordinatorEnabled: true,
    coordinatorSessionId: SESSION as string | null,
  };
  const session = {
    id: SESSION,
    ownerId: OWNER,
    title: 'Initial project',
    titleManagedByProject: managed,
  };
  const announced: string[] = [];

  const prisma: any = {
    project: {
      findFirst: async ({ where }: any) =>
        where.id === project.id && where.ownerId === project.ownerId
          ? {
              id: project.id,
              coordinatorEnabled: project.coordinatorEnabled,
              coordinatorSessionId: project.coordinatorSessionId,
            }
          : null,
      update: async ({ data }: any) => {
        if (typeof data.title === 'string') project.title = data.title;
        return {
          ...project,
          goal: null,
          acceptanceCriteria: null,
          acceptanceCriteriaFormat: 'LEGACY_TEXT',
          instructions: null,
          status: 'OPEN',
          members: [],
          runtime: { coordinatorGeneration: 0n },
          acceptanceCriterionDefinitions: [],
        };
      },
    },
    session: {
      findFirst: async ({ where }: any) =>
        where.id === session.id && where.ownerId === session.ownerId ? { ...session } : null,
      update: async ({ where, data }: any) => {
        assert.equal(where.id, session.id);
        Object.assign(session, data);
        return { ...session };
      },
      updateMany: async ({ where, data }: any) => {
        if (where.id !== session.id || where.ownerId !== session.ownerId) return { count: 0 };
        if (
          where.titleManagedByProject !== undefined &&
          where.titleManagedByProject !== session.titleManagedByProject
        ) return { count: 0 };
        Object.assign(session, data);
        return { count: 1 };
      },
    },
    $queryRaw: async (query: { text?: string }) => {
      const sql = query.text ?? '';
      if (sql.includes('FROM "session"')) return [{ id: session.id }];
      if (sql.includes('FROM "project"')) {
        return [{
          coordinator_enabled: project.coordinatorEnabled,
          config_revision: 0n,
          status: 'OPEN',
          coordinator_session_id: project.coordinatorSessionId,
          accepted_run_id: null,
          legacy_accepted_at: null,
          acceptance_epoch: 0n,
        }];
      }
      throw new Error(`unexpected raw query: ${sql}`);
    },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(prisma),
  };
  const realtime = { publishSessionUpdated: (id: string) => announced.push(id) };
  const sessions = new SessionsService(prisma, {} as never, realtime as never);
  const projects = new ProjectsService(
    prisma,
    {} as never,
    {
      announceProjectSessionChanged: (id: string) => announced.push(id),
    } as never,
  );
  return { project, session, announced, projects, sessions };
}

test('a managed coordinator title follows a project rename and publishes after commit', async () => {
  const f = fixture(true);

  await f.projects.update(OWNER, PROJECT, { title: 'Renamed project' } as never);

  assert.equal(f.project.title, 'Renamed project');
  assert.equal(f.session.title, 'Renamed project');
  assert.equal(f.session.titleManagedByProject, true);
  assert.deepEqual(f.announced, [SESSION]);
});

test('a manual session rename exits project title management permanently', async () => {
  const f = fixture(true);

  await f.sessions.rename(OWNER, SESSION, 'My working title');
  await f.projects.update(OWNER, PROJECT, { title: 'Project moved on' } as never);

  assert.equal(f.project.title, 'Project moved on');
  assert.equal(f.session.title, 'My working title');
  assert.equal(f.session.titleManagedByProject, false);
  // Both writes publish: the managed title stays put, but the relation's projectTitle changed and
  // list/detail clients still need to refresh that backlink metadata.
  assert.deepEqual(f.announced, [SESSION, SESSION]);
});

test('renaming a session to the same text still opts out (the ABA case)', async () => {
  const f = fixture(true);

  await f.sessions.rename(OWNER, SESSION, 'Initial project');
  await f.projects.update(OWNER, PROJECT, { title: 'Later project title' } as never);

  assert.equal(f.session.title, 'Initial project');
  assert.equal(f.session.titleManagedByProject, false);
});

test('the migration never guesses title ownership for historical coordinator sessions', () => {
  const sql = readFileSync(
    path.resolve(
      __dirname,
      '../../prisma/migrations/0173_project_managed_coordinator_title/migration.sql',
    ),
    'utf8',
  );

  assert.match(sql, /title_managed_by_project" BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.doesNotMatch(sql, /UPDATE\s+"session"/i);
  assert.match(sql, /Only an explicit promotion\/new coordinator/);
});
