/**
 * A PROJECT'S TITLE AND CRITERIA ARE TRANSLATED (project 'Translate project criteria and title for the owner',
 * criterion 1; decision 1A; migration 1600; wire shape ProjectTextTranslation in @orbit/shared translation.ts).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-text-translation.pg.spec.ts
 *
 * Against the real schema and the owner's real preferences row, with DeepSeek stubbed, `GET /projects/:id`
 * (ProjectsService.get) is held to:
 *   (a) translated and served: the first read with translation on serves none and queues one; once it is stored
 *       the read serves `{ lang, title, criteria: [{ id, text }] }` in the owner's language, without its digest,
 *       beside the project's own untouched words; PROJECT_CHANGED is published; a verificationMethod never reaches
 *       the translator; a read of a current translation queues nothing;
 *   (b) stale after an edit: editing the title, or one criterion's text, means the stored one is not served and a
 *       new one is queued, which the next read serves;
 *   (c) failed: a failure is stored and served as `{ lang, failed: true }`, and is not tried again on read;
 *   (d) translation off: nothing is translated, stored or served, and a stored one is not served;
 *   (e) the owner's language changed: the stored one is not served and one in the new language is queued.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { Client } from 'pg';
import { RunEventType } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { replyTranslationsSettled } from '../sessions/reply-translation';
import { resetTranslationBreaker } from '../sessions/translation';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

beforeEach(() => resetTranslationBreaker());

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const ON = { translationEnabled: true, translationLanguage: 'zh-Hans' };
const OFF = { translationEnabled: false, translationLanguage: 'zh-Hans' };
const JA = { translationEnabled: true, translationLanguage: 'ja' };

const METHOD = 'Read the project page and say whether it holds';

/** What the translator was asked, in order, and how it answers: `<LANG>[text]`, or a 500 while `failing`. */
const asked: string[] = [];
let failing = false;
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await replyTranslationsSettled();
  }
}

test('a project\'s title and criteria are translated, served while current, re-queued when stale', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('https://api.deepseek.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const text = body.messages.find((m) => m.role === 'user')!.content;
    const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
    asked.push(text);
    if (failing) return { ok: false, status: 500, body: null } as Response;
    const tag = /Japanese/u.test(system) ? 'JA' : 'ZH';
    return {
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: `${tag}[${text}]` } }] }),
    } as Response;
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = realKey;
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const published: string[] = [];
  const realtime = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === 'publishForUser') {
        return (_owner: string, type: string, id: unknown) => { if (typeof id === 'string') published.push(`${type}:${id}`); };
      }
      return () => undefined;
    },
  }) as unknown as RealtimeService;
  const prisma = db as unknown as PrismaService;
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma), undefined, realtime);

  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `project-text-translation-${ownerId}@example.invalid`, name: 'owner', passwordHash: 'x',
      preferences: OFF,
    },
  });
  const prefer = (preferences: object) => db.user.update({ where: { id: ownerId }, data: { preferences } });
  const reset = async () => {
    await settle();
    asked.length = 0;
    published.length = 0;
    failing = false;
    resetTranslationBreaker();
  };

  /** A project of this account with two criteria, stated through the owner's own door. */
  const project = async (title: string) => {
    const id = randomUUID();
    await db.project.create({ data: { id, ownerId, title, goal: title } });
    await projects.update(ownerId, id, {
      acceptanceCriteriaItems: [
        { text: `${title}: the first criterion`, verificationMethod: METHOD },
        { text: `${title}: the second criterion`, verificationMethod: METHOD },
      ],
    } as never);
    return id;
  };
  type Read = {
    title: string;
    acceptanceCriteriaItems: Array<{ id: string; text: string }>;
    translation?: unknown;
  };
  const read = async (id: string) => (await projects.get(ownerId, id)) as unknown as Read;
  const stored = async (id: string) =>
    (await sql.query('SELECT translation FROM project_text_translation WHERE project_id = $1', [id])).rows[0]
      ?.translation ?? null;
  /** The translation a read should serve for the project as it stands now, in `tag`'s language. */
  const expected = (doc: Read, lang: string, tag: string) => ({
    lang,
    title: `${tag}[${doc.title}]`,
    criteria: doc.acceptanceCriteriaItems.map((item) => ({ id: item.id, text: `${tag}[${item.text}]` })),
  });

  await t.test('(a) the first read queues one; once stored, the read serves it in the owner\'s language', async () => {
    await reset();
    await prefer(ON);
    const id = await project('Translate the done card');
    await settle();
    await reset();
    await db.projectTextTranslation.deleteMany({ where: { projectId: id } });

    const first = await read(id);
    assert.equal(first.translation, undefined, 'the read that queues it serves none');
    await settle();
    const want = expected(first, 'zh-Hans', 'ZH');
    const row = await stored(id) as Record<string, unknown> | null;
    assert.ok(row, 'the translation is stored');
    assert.match(String(row.sourceDigest), /^[0-9a-f]{64}$/u, 'beside the digest of the words it was made from');
    const { sourceDigest: _digest, ...rest } = row;
    assert.deepEqual(rest, want, 'the title and every criterion, each criterion under its own id');

    const second = await read(id);
    assert.deepEqual(second.translation, want, 'the read serves it, without its digest');
    assert.equal(second.title, 'Translate the done card', 'the project\'s own title is untouched');
    assert.deepEqual(second.acceptanceCriteriaItems.map((item) => item.text), [
      'Translate the done card: the first criterion',
      'Translate the done card: the second criterion',
    ], 'and its criteria are what the agent wrote');
    assert.ok(published.includes(`${RunEventType.PROJECT_CHANGED}:${id}`),
      `PROJECT_CHANGED is published (got ${published.join(', ')})`);
    assert.ok(!asked.some((text) => text.includes(METHOD)), 'a verificationMethod never reaches the translator');

    asked.length = 0;
    await read(id);
    await settle();
    assert.deepEqual(asked, [], 'a current translation is not translated again on read');
  });

  await t.test('(b) an edit of the title or of a criterion makes it stale: not served, and a new one queued', async () => {
    await reset();
    await prefer(ON);
    const id = await project('Stale after edit');
    await read(id);
    await settle();
    assert.ok((await read(id)).translation, 'translated before the edits');

    // The title.
    const before = await stored(id) as { title: string; sourceDigest: string };
    await reset();
    await projects.update(ownerId, id, { title: 'Stale after a title edit' } as never);
    assert.deepEqual(await stored(id), before, 'the edit leaves the translation of the old title stored');
    const renamed = await read(id);
    assert.equal(renamed.translation, undefined, 'one made from older words is not served');
    await settle();
    assert.ok(asked.includes('Stale after a title edit'), 'and a new one is queued, with the new title');
    assert.deepEqual((await read(id)).translation, expected(renamed, 'zh-Hans', 'ZH'), 'which the next read serves');

    // One criterion's text, the criterion kept under its id. A rewording is held as a proposal (criteria-edit-
    // classification.ts), so it is applied the way the owner applies one: approved at the decision door.
    await reset();
    const current = await read(id);
    await projects.update(ownerId, id, {
      acceptanceCriteriaItems: [
        { id: current.acceptanceCriteriaItems[0].id, text: 'Stale after a criterion edit', verificationMethod: METHOD },
        { id: current.acceptanceCriteriaItems[1].id, text: current.acceptanceCriteriaItems[1].text, verificationMethod: METHOD },
      ],
    } as never);
    const [proposal] = (await projects.pendingCriteriaDecisions(ownerId, id)).pending;
    assert.ok(proposal, 'the rewording is held for the owner');
    await projects.decideCriteriaChange(ownerId, id, proposal.intentId, {
      commitToken: proposal.commitToken, decision: 'APPROVE', baseSeal: proposal.currentSeal,
    } as never);
    await settle();
    asked.length = 0;
    const edited = await read(id);
    assert.equal(edited.acceptanceCriteriaItems[0].text, 'Stale after a criterion edit', 'the edit was applied');
    assert.equal(edited.acceptanceCriteriaItems[0].id, current.acceptanceCriteriaItems[0].id, 'to the same criterion');
    assert.equal(edited.translation, undefined, 'the translation of the old wording is not served');
    await settle();
    assert.ok(asked.includes('Stale after a criterion edit'), 'and a new one is queued, with the new wording');
    assert.deepEqual((await read(id)).translation, expected(edited, 'zh-Hans', 'ZH'), 'which the next read serves');
  });

  await t.test('(c) a failure is stored and served as { lang, failed: true }, and not tried again on read', async () => {
    await reset();
    await prefer(OFF);
    const id = await project('Failed translation');
    await settle();
    await reset();
    await prefer(ON);
    failing = true;
    resetTranslationBreaker();
    assert.equal((await read(id)).translation, undefined);
    await settle();
    failing = false;
    resetTranslationBreaker();
    const row = await stored(id) as Record<string, unknown>;
    const { sourceDigest: _digest, ...rest } = row;
    assert.deepEqual(rest, { lang: 'zh-Hans', failed: true }, 'the failure is recorded whole, never half');
    assert.deepEqual((await read(id)).translation, { lang: 'zh-Hans', failed: true }, 'and served as failed');
    asked.length = 0;
    await read(id);
    await settle();
    assert.deepEqual(asked, [], 'a project already tried in this language is not translated again on read');
  });

  await t.test('(d) translation off: nothing is translated, stored or served, and a stored one is not served', async () => {
    await reset();
    await prefer(OFF);
    const id = await project('Translation off');
    await settle();
    const off = await read(id);
    await settle();
    assert.deepEqual(asked, [], 'the translator is never asked');
    assert.equal(await stored(id), null, 'nothing is stored');
    assert.equal('translation' in off, false, 'the read carries no translation field');

    await prefer(ON);
    await read(id);
    await settle();
    assert.ok((await read(id)).translation, 'translated once switched on');
    await prefer(OFF);
    asked.length = 0;
    const offAgain = await read(id);
    await settle();
    assert.equal('translation' in offAgain, false, 'switched off again, the stored one is not served');
    assert.deepEqual(asked, [], 'and nothing is queued');
  });

  await t.test('(e) the owner\'s language changed: the stored one is not served, one in the new language is queued', async () => {
    await reset();
    await prefer(ON);
    const id = await project('Language changed');
    await read(id);
    await settle();
    assert.equal((await read(id)).translation && (await stored(id) as { lang: string }).lang, 'zh-Hans');

    await reset();
    await prefer(JA);
    const japanese = await read(id);
    assert.equal(japanese.translation, undefined, 'the zh-Hans one is not served to an owner reading Japanese');
    await settle();
    assert.ok(asked.length > 0, 'one in the new language is queued');
    assert.deepEqual((await read(id)).translation, expected(japanese, 'ja', 'JA'), 'and served once stored');
  });
});
