/**
 * `GET /projects/sidebar` says how each project is paused, on real PostgreSQL (design §4.2 2a/2b,
 * §4.3 Pause / Resume).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-sidebar-pause.pg.spec.ts
 *
 * One account, four started projects: paused by its owner (`POST /projects/:id/pause`), paused by
 * the older Automatic switch, paused by the spend fuse (an open `project_fuse_episode`), and not
 * paused — which also holds a RESUMED episode, so a pause that was lifted is not read as one. The
 * statement count per page is pinned by `project-sidebar-pause.spec.ts`; this file pins the SQL.
 *
 * Not destructive: every case owns freshly generated ids.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

test('the sidebar says whether each project is paused by its owner, the old switch, the fuse, or not',
  { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
    const url = URL!;
    assertCoordinatorPgUrlIsIsolated(url);
    const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const db: PrismaClient = prismaClientFor(url);
    t.after(async () => {
      await db.$disconnect().catch(() => undefined);
      await sql.end().catch(() => undefined);
    });
    const projects = new ProjectsService(db as unknown as PrismaService, {} as never);

    const ownerId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `pause-${ownerId}@sidebar-pause.invalid`, name: 'pause', passwordHash: 'x' },
    });
    const startedAt = new Date('2026-11-19T09:00:00.000Z');
    const pausedAt = new Date('2026-11-19T10:00:00.000Z');

    async function project(title: string, paused: { at: Date; reason: string } | null): Promise<string> {
      const id = randomUUID();
      await db.project.create({
        data: {
          id, ownerId, title, startedAt,
          pausedAt: paused?.at ?? null, pausedReason: paused?.reason ?? null,
        },
      });
      return id;
    }

    async function episode(projectId: string, generation: number, resumedAt: Date | null): Promise<string> {
      const row = await db.projectFuseEpisode.create({
        data: {
          projectId, ownerId, generation, dimension: 'SELF_STARTED_TURNS', observed: 6, limitValue: 6,
          windowStart: new Date(pausedAt.getTime() - 24 * 3_600_000),
          spend: { selfStartedTurns: 6, sessionsOpened: 0, successorRetries: 0 },
          crossingFact: { table: 'task', id: randomUUID() },
          // A resumed episode names who resumed it (0284's project_fuse_episode_resumed_chk).
          pausedAt, resumedAt, resumedByUserId: resumedAt ? ownerId : null,
        },
        select: { id: true },
      });
      return row.id;
    }

    const owner = await project('owner paused', { at: pausedAt, reason: 'OWNER' });
    const legacy = await project('legacy paused', { at: pausedAt, reason: 'LEGACY_AUTOMATIC_OFF' });
    const fused = await project('fuse paused', null);
    const open = await project('not paused', null);
    const openEpisode = await episode(fused, 1, null);
    await episode(open, 1, new Date('2026-11-19T11:00:00.000Z'));

    const rows: any[] = await projects.listSidebar(ownerId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const pause = (id: string) => {
      const row = byId.get(id);
      assert.ok(row, `the sidebar lists ${id}`);
      return { pausedAt: row.pausedAt, pausedReason: row.pausedReason, fuse: row.fuse };
    };
    const notFused = { paused: false, episodeId: null, observed: null, limit: null };

    assert.deepEqual(pause(owner), { pausedAt, pausedReason: 'OWNER', fuse: notFused });
    assert.deepEqual(pause(legacy), { pausedAt, pausedReason: 'LEGACY_AUTOMATIC_OFF', fuse: notFused });
    assert.deepEqual(pause(fused), {
      pausedAt: null, pausedReason: null,
      fuse: { paused: true, episodeId: openEpisode, observed: 6, limit: 6 },
    });
    assert.deepEqual(pause(open), { pausedAt: null, pausedReason: null, fuse: notFused },
      'a resumed episode is not a pause');
  });
