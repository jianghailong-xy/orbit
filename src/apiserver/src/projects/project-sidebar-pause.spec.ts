import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import { addTwins } from '../common/public-id-body';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { ProjectsService } from './projects.service';

/**
 * `GET /projects/sidebar` says whether each project is paused (design §4.2 2a/2b, §4.3 Pause /
 * Resume): `pausedAt` and `pausedReason` off the project row, and `fuse` off its open spend-fuse
 * episode — read in ONE statement for the whole page, because every open tab polls this every 15
 * seconds. `project-sidebar-pause.pg.spec.ts` runs the same read against real PostgreSQL.
 */

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OWNER_PAUSED = '00000000-0000-7000-8000-0000000000a1';
const LEGACY_PAUSED = '00000000-0000-7000-8000-0000000000a2';
const FUSE_PAUSED = '00000000-0000-7000-8000-0000000000a3';
const RUNNING = '00000000-0000-7000-8000-0000000000a4';
const EPISODE_ID = '00000000-0000-7000-8000-0000000000e1';
const PAUSED_AT = new Date('2026-11-19T10:00:00.000Z');

/** A sidebar read over `projects`, counting every statement it sends and how many read the fuse. */
function sidebarOver(projects: Array<Record<string, unknown>>) {
  const counts = { statements: 0, fuseReads: 0 };
  const prisma = {
    project: {
      findMany: async (args: any) => {
        counts.statements += 1;
        assert.equal(args.select.pausedAt, true, 'the rail selects pausedAt');
        assert.equal(args.select.pausedReason, true, 'the rail selects pausedReason');
        return projects;
      },
    },
    projectCodebase: { findMany: async () => { counts.statements += 1; return []; } },
    projectFuseEpisode: {
      findFirst: async () => assert.fail('the fuse is never read one project at a time'),
      findMany: async () => assert.fail('the fuse is read by the one raw statement'),
    },
    $queryRaw: async (...args: unknown[]) => {
      counts.statements += 1;
      const { text, values } = renderRawQuery(args);
      if (!text.includes('"project_fuse_episode"')) return [];
      counts.fuseReads += 1;
      assert.match(text, /= ANY\(/, 'one statement over every project id on the page');
      assert.match(text, /"resumed_at" IS NULL/, 'only the open pause');
      assert.deepEqual(values[0], projects.map((project) => project.id));
      return projects.some((project) => project.id === FUSE_PAUSED)
        ? [{ projectId: FUSE_PAUSED, id: EPISODE_ID, observed: 6, limit: 6 }]
        : [];
    },
  };
  return { service: new ProjectsService(prisma as never, {} as never), counts };
}

const project = (id: string, pausedAt: Date | null, pausedReason: string | null) =>
  ({ id, title: id, status: 'OPEN', createdAt: PAUSED_AT, startedAt: PAUSED_AT, pausedAt, pausedReason });

const FOUR = [
  project(OWNER_PAUSED, PAUSED_AT, 'OWNER'),
  project(LEGACY_PAUSED, PAUSED_AT, 'LEGACY_AUTOMATIC_OFF'),
  project(FUSE_PAUSED, null, null),
  project(RUNNING, null, null),
];

const NOT_FUSED = { paused: false, episodeId: null, observed: null, limit: null };

test('every sidebar row says how it is paused: by its owner, by the old switch, by the fuse, or not', async () => {
  const { service } = sidebarOver(FOUR);
  const rows = await service.listSidebar(OWNER_ID);
  const pause = (row: any) => ({ pausedAt: row.pausedAt, pausedReason: row.pausedReason, fuse: row.fuse });

  assert.deepEqual(rows.map(pause), [
    { pausedAt: PAUSED_AT, pausedReason: 'OWNER', fuse: NOT_FUSED },
    { pausedAt: PAUSED_AT, pausedReason: 'LEGACY_AUTOMATIC_OFF', fuse: NOT_FUSED },
    { pausedAt: null, pausedReason: null, fuse: { paused: true, episodeId: EPISODE_ID, observed: 6, limit: 6 } },
    { pausedAt: null, pausedReason: null, fuse: NOT_FUSED },
  ]);
});

test('the fuse is one read for the whole page: the statement count does not grow with the projects', async () => {
  const one = sidebarOver([project(RUNNING, null, null)]);
  await one.service.listSidebar(OWNER_ID);
  const four = sidebarOver(FOUR);
  await four.service.listSidebar(OWNER_ID);

  assert.equal(one.counts.fuseReads, 1);
  assert.equal(four.counts.fuseReads, 1, 'four projects, one fuse read');
  assert.equal(four.counts.statements, one.counts.statements,
    'the sidebar sends as many statements for four projects as for one');
});

test('an empty sidebar reads no fuse at all', async () => {
  const { service, counts } = sidebarOver([]);
  assert.deepEqual(await service.listSidebar(OWNER_ID), []);
  assert.equal(counts.fuseReads, 0);
});

test('the fuse episode id goes out in the public encoding the rest of the row uses', async () => {
  const { service } = sidebarOver(FOUR);
  const rows: any[] = await service.listSidebar(OWNER_ID);
  addTwins(rows, true);
  const fused = rows.find((row) => row.fuse.paused);
  assert.equal(fused.id, uuidToBase62(FUSE_PAUSED));
  assert.equal(fused.fuse.episodeId, uuidToBase62(EPISODE_ID));
  assert.equal(fused.fuse.episodePublicId, uuidToBase62(EPISODE_ID));
});
