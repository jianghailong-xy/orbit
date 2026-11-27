// Seed every row shape the legacy-word projector is pinned over (src/apiserver/src/sessions/session-legacy-words.fixture.ts
// WORD_SHAPES: every release shape as migration 1441 left it, the held words, the shapes the projector's rules turn on)
// into the rehearsal copy, the way a writer before deploy D1 leaves them: the stored word and the release facts only,
// no turn_state or phase (those columns do not exist yet). Several copies of each, with production's counts where
// they were measured (plan §3.4), and every released shape once more filed in Completed and once in Trash, which the
// sessionState word reads.
//
// On a database deploy D3 or D4 left (1671's trigger, or no session.status), a writer stores facts and no word: the row
// is written with the turn state its stored word stands for instead.
//
// Run inside an apiserver image (its dist holds the fixture and the Prisma client), or against a build (API_DIST):
//   docker run --rm --network <net> -e DATABASE_URL=... -v <this dir>:/kit:ro <project>-apiserver:d2 node /kit/seed-shapes.cjs
'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const API = process.env.API_DIST ?? '/app/src/apiserver/dist';
const { prismaClientFor } = require(path.join(API, 'prisma/prisma-client.js'));
const { WORD_SHAPES } = require(path.join(API, 'sessions/session-legacy-words.fixture.js'));

// Copies per shape: production's counts where measured (plan §3.4: 318 B3 rows on 2026-11-21, 13 of 85 FAILED rows
// with `completed`), else 3.
const COPIES = { B3: 318, 'B1 completed': 13 };
const DEFAULT_COPIES = 3;

const db = prismaClientFor(process.env.DATABASE_URL);

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const TURN_STATE_OF_WORD = { PENDING: 'QUEUED', RUNNING: 'IN_FLIGHT', INTERRUPTED: 'ABANDONED' };

async function main() {
  const [{ count }] = await db.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "session" WHERE "title" LIKE 'shape:%'`);
  if (count > 0) throw new Error(`${count} shape rows already seeded`);
  // Which writer this database takes: the word (before D3), or the facts (1671's trigger, or no column at all).
  const [{ word: writesWord }] = await db.$queryRawUnsafe(`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'session' AND column_name = 'status')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'session_aa_status_from_facts') AS word`);
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "user" ("id", "email", "name", "password_hash") VALUES ($1::uuid, $2, 'shapes', 'x')`,
    ownerId, `shapes-${ownerId}@rehearsal.invalid`);
  await db.$executeRawUnsafe(
    `INSERT INTO "runner" ("id", "name", "owner_id", "token_hash", "max_concurrent") VALUES ($1::uuid, 'shapes runner', $2::uuid, $3, 4)`,
    runnerId, ownerId, `hash-${runnerId}`);
  const workspaceId = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "workspace" ("id", "name", "owner_id", "runner_id") VALUES ($1::uuid, 'shapes ws', $2::uuid, $3::uuid)`,
    workspaceId, ownerId, runnerId);
  const project = await db.project.create({ data: { ownerId, title: 'shapes project' }, select: { id: true } });
  const codebase = await db.projectCodebase.create({
    data: {
      ownerId, projectId: project.id, canonicalRepoUrl: `https://github.com/example/shapes-${project.id}`,
      upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main', refAuthority: 'REMOTE',
    },
    select: { id: true },
  });

  const written = [];
  for (const shape of WORD_SHAPES) {
    const f = shape.facts;
    const released = f.finishedAt != null;
    const copies = COPIES[shape.name] ?? DEFAULT_COPIES;
    const filings = released ? ['open', 'completed', 'trash'] : ['open'];
    for (const filing of filings) {
      const n = filing === 'open' ? copies : 1;
      for (let i = 0; i < n; i++) {
        const id = randomUUID();
        const landing = f.sessionKind === 'LANDING';
        let taskId = null;
        if (landing) {
          const task = await db.task.create({
            data: { ownerId, creatorType: 'USER', creatorId: ownerId, title: `shape ${shape.name}`, projectId: project.id,
              completionCriterion: 'EVIDENCE_JUDGMENT' },
            select: { id: true },
          });
          taskId = task.id;
        }
        await db.$executeRawUnsafe(
          `INSERT INTO "session" ("id", "title", "prompt", "owner_id", "creator_id", "updated_at", ${writesWord ? '"status"' : '"turn_state"'}, "finished_at",
                                  "end_reason", "last_turn_outcome", "started_at", "import_source_cwd", "kind",
                                  "provider", "provider_builtin", "workspace_id", "assigned_runner_id",
                                  "completed_at", "deleted_at", "starts_task_work")
           VALUES ($1::uuid, $2, 'shapes', $3::uuid, $3::uuid, now(), ${writesWord ? '$4::run_status' : '$4'}, $5::timestamp, $6, $7, $8::timestamp,
                   $9, $10, $11, true, $12::uuid, $13::uuid, $14::timestamp, $15::timestamp, $16)`,
          id, `shape:${shape.name}:${filing}:${i}`, ownerId,
          writesWord ? shape.stored : (released ? null : TURN_STATE_OF_WORD[shape.stored] ?? null), iso(f.finishedAt), f.endReason,
          f.lastTurnOutcome, iso(f.startedAt), f.importSourceCwd, f.sessionKind, landing ? 'orbit' : 'claude',
          landing ? null : workspaceId, landing ? null : runnerId,
          filing === 'completed' ? iso(f.finishedAt) : null, filing === 'trash' ? iso(f.finishedAt) : null, !landing);
        if (landing && shape.landing) {
          await db.projectLanding.create({
            data: {
              id: randomUUID(), projectId: project.id, ownerId, codebaseId: codebase.id, subject: 'TASK', taskId,
              sessionId: id, settledAt: new Date(shape.landing.settledAt), settledAs: shape.landing.settledAs,
            },
            select: { id: true },
          });
        }
      }
      written.push({ shape: shape.name, stored: shape.stored, filing, rows: n });
    }
  }
  console.log(JSON.stringify({ ownerId, runnerId, writesWord, shapes: WORD_SHAPES.length, rows: written.reduce((a, w) => a + w.rows, 0), written }));
}

main().then(() => db.$disconnect(), async (err) => { console.error(err); await db.$disconnect(); process.exit(1); });
