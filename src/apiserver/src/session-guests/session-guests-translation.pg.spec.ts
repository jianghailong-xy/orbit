/**
 * A guest's message under the OWNER's Settings › Translation (guest composer project, decision D2), against a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   (1) owner Translation on: the guest turn is written HELD in the guest's own language, and released translated into
 *       the owner's agent language (Japanese here, not the default), the guest's words kept as the turn's original;
 *   (2) optimizedTranslation: held, and released with that text, with no translator call;
 *   (3) skipTranslation: never held, sent as written; either field of the wrong type is a 400 that writes nothing;
 *   (4) owner Translation off: sent as written, never held, no translator call;
 *   (5) a replay of the same clientTurnId (held, and again after its release) counts once toward the 50/day cap.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/session-guests/session-guests-translation.pg.spec.ts
 *
 * DeepSeek is stubbed. Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { type Prisma, type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { TRANSLATION_LANGUAGE_NAMES } from '@orbit/shared';

import type { AttachmentsService } from '../attachments/attachments.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { resetTranslationBreaker } from '../sessions/translation';
import { SessionsService } from '../sessions/sessions.service';
import { GUEST_TURN_ACTIVITY, SessionGuestsService } from './session-guests.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

const FRENCH = 'Peux-tu corriger le bouton Google de la page de connexion ?';
const JAPANESE = 'ログインページの Google ボタンを直してください';

let db: PrismaClient;
let sessions: SessionsService;
let guests: SessionGuestsService;
/** What the translator answers next, and the system prompt of every translator call, in order. */
let replies: string[] = [];
let translatorCalls: string[] = [];
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;
const created: string[] = [];

function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: URL ? false : 'set COORDINATOR_PG_URL to run the guest translation suite', concurrency: 1 }, body);
}

before(async () => {
  if (!URL) return;
  db = prismaClientFor(URL);
  await db.$connect();
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.deepseek.com/')) return realFetch(url);
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === 'system')!.content;
    // A session title or any other DeepSeek caller is not the translator, and takes none of its replies.
    if (!system.startsWith('You are a translator.')) return { ok: false, status: 500, body: null } as Response;
    translatorCalls.push(system);
    const reply = replies.shift();
    // Nothing queued: a refusal the translator does not retry, so the turn is left HELD and FAILED at once.
    if (reply === undefined) return { ok: false, status: 400, body: null } as Response;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }) } as Response;
  }) as typeof fetch;
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) }) as unknown as RealtimeService;
  sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, realtime);
  guests = new SessionGuestsService(prisma, sessions, {} as AttachmentsService);
});

beforeEach(() => {
  resetTranslationBreaker();
  replies = [];
  translatorCalls = [];
});

after(async () => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = realKey;
  if (!db) return;
  await db.session.deleteMany({ where: { ownerId: { in: created } } });
  await db.workspace.deleteMany({ where: { ownerId: { in: created } } });
  await db.runner.deleteMany({ where: { ownerId: { in: created } } });
  await db.activity.deleteMany({ where: { actorId: { in: created } } });
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

interface World { ownerId: string; guestId: string; sessionId: string }

/**
 * An owner's live conversation waiting for its next message, shared with one guest who writes French. `ownerPrefs`
 * is the owner's Settings › Translation.
 */
async function world(label: string, ownerPrefs: Prisma.InputJsonValue): Promise<World> {
  const w: World = { ownerId: randomUUID(), guestId: randomUUID(), sessionId: randomUUID() };
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const users: Array<[string, string, Prisma.InputJsonValue]> = [
    [w.ownerId, 'owner', ownerPrefs],
    [w.guestId, 'guest', { translationLanguage: 'fr' }],
  ];
  for (const [id, who, preferences] of users) {
    created.push(id);
    await db.user.create({
      data: { id, email: `${label}-${who}-${RUN}-${id}@guest-translation.invalid`, name: `${label} ${who}`, passwordHash: 'x', preferences },
    });
  }
  await db.runner.create({
    data: {
      id: runnerId, ownerId: w.ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId: w.ownerId, runnerId, name: `${label}-agent`, enabled: true } });
  await db.session.create({
    data: {
      id: w.sessionId, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `${label} conversation`, prompt: 'hello', provider: 'claude', providerBuiltin: true, engine: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER, numTurns: 1, engineTurnActive: false,
      runtimeSessionId: randomUUID(), startedAt: new Date(),
    },
  });
  await db.sessionGuest.create({ data: { sessionId: w.sessionId, userId: w.guestId, ownerId: w.ownerId } });
  return w;
}

/** Owner writes Chinese, the agent works in Japanese, Translation on. */
const TRANSLATION_ON = { translationEnabled: true, translationLanguage: 'zh-Hans', translationAgentLanguage: 'ja' };

const turnOf = (w: World, clientTurnId: string) => db.conversationTurn.findUniqueOrThrow({
  where: { sessionId_clientTurnId: { sessionId: w.sessionId, clientTurnId } },
  select: {
    id: true, status: true, content: true, displayPrompt: true, translationState: true, translationLang: true,
    externalSenderSource: true, externalSenderId: true,
  },
});
const turnsToday = async (w: World) =>
  (await db.sessionGuest.findFirstOrThrow({ where: { sessionId: w.sessionId, userId: w.guestId } })).turnsOnDay;
const guestActivities = (w: World) =>
  db.activity.count({ where: { actorId: w.ownerId, type: GUEST_TURN_ACTIVITY } });

scenario('(1) owner Translation on: a guest turn is held in the guest language, then released in the owner agent language', async () => {
  const w = await world('held', TRANSLATION_ON);
  const clientTurnId = randomUUID();
  replies = [JAPANESE];
  // The translator is held until the row has been read HELD: nothing races the assertion below.
  let releaseTranslator!: () => void;
  const gate = new Promise<void>((resolve) => { releaseTranslator = resolve; });
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { await gate; return stubbed(...args); }) as typeof fetch;
  try {
    const sent = await guests.turn(w.guestId, w.sessionId, { clientTurnId, content: FRENCH }) as { translation?: unknown };
    assert.deepEqual(sent.translation, { state: 'TRANSLATING', from: 'fr', original: FRENCH }, 'the guest is told it is being translated');
    const held = await turnOf(w, clientTurnId);
    assert.equal(held.status, 'HELD');
    assert.equal(held.translationState, 'TRANSLATING');
    assert.equal(held.translationLang, 'fr', "held in the guest's own language, not the owner's");
    assert.equal(held.displayPrompt, FRENCH);
    assert.equal(held.externalSenderSource, 'ORBIT_GUEST');
    assert.equal(held.externalSenderId, w.guestId);
    const row = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    assert.equal(row.lastUserText, FRENCH);
    assert.equal(row.lastUserFromExternalSource, 'ORBIT_GUEST', 'the preview names the guest, held or not');
    assert.equal(row.status, RunStatus.AWAITING_INPUT, 'nothing is woken while it is held');
    assert.equal(await turnsToday(w), 1, 'a held guest turn counts toward the day');
    assert.equal(await guestActivities(w), 1);
  } finally {
    releaseTranslator();
    globalThis.fetch = stubbed;
  }
  await sessions.translationsSettled();
  assert.equal(translatorCalls.length, 1);
  assert.match(translatorCalls[0]!, new RegExp(`from ${TRANSLATION_LANGUAGE_NAMES.fr} into ${TRANSLATION_LANGUAGE_NAMES.ja}\\.`));
  const released = await turnOf(w, clientTurnId);
  assert.equal(released.status, 'PENDING');
  assert.equal(released.content, JAPANESE, "released in the owner's agent language");
  assert.equal(released.displayPrompt, FRENCH, "the guest's words stay the original");
  assert.equal(released.translationState, 'DONE');
  assert.equal(released.translationLang, 'fr');
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: w.sessionId } })).status, RunStatus.PENDING, 'released, the session is woken');
});

scenario('(2) optimizedTranslation: held, and released with that text and no translator call', async () => {
  const w = await world('optimized', TRANSLATION_ON);
  const clientTurnId = randomUUID();
  const optimized = 'ログインページの Google サインインボタンの不具合を修正してください。';
  const sent = await guests.turn(w.guestId, w.sessionId, { clientTurnId, content: FRENCH, optimizedTranslation: optimized }) as {
    translation?: { state: string };
  };
  assert.equal(sent.translation?.state, 'TRANSLATING');
  await sessions.translationsSettled();
  assert.equal(translatorCalls.length, 0, 'the optimizer already wrote the agent-language text');
  const released = await turnOf(w, clientTurnId);
  assert.equal(released.status, 'PENDING');
  assert.equal(released.content, optimized);
  assert.equal(released.displayPrompt, FRENCH);
  assert.equal(released.translationState, 'DONE');
  assert.equal(await turnsToday(w), 1);
});

scenario('(3) skipTranslation: never held, sent as written; a wrong type of either field is a 400 that writes nothing', async () => {
  const w = await world('skip', TRANSLATION_ON);
  for (const body of [
    { skipTranslation: 'true' }, { skipTranslation: 1 }, { skipTranslation: null },
    { optimizedTranslation: 5 }, { optimizedTranslation: { text: 'x' } }, { optimizedTranslation: 'x'.repeat(64_001) },
  ]) {
    const clientTurnId = randomUUID();
    await assert.rejects(
      guests.turn(w.guestId, w.sessionId, { clientTurnId, content: FRENCH, ...body }),
      (error: unknown) => error instanceof BadRequestException,
      JSON.stringify(body).slice(0, 80),
    );
    assert.equal(await db.conversationTurn.count({ where: { sessionId: w.sessionId, clientTurnId } }), 0);
  }
  assert.equal(await turnsToday(w), 0, 'a refused message counts nothing');

  const clientTurnId = randomUUID();
  const sent = await guests.turn(w.guestId, w.sessionId, { clientTurnId, content: FRENCH, skipTranslation: true }) as { translation?: unknown };
  assert.equal(sent.translation, undefined);
  const turn = await turnOf(w, clientTurnId);
  assert.equal(turn.status, 'PENDING', 'never held');
  assert.equal(turn.content, FRENCH);
  assert.equal(turn.displayPrompt, null);
  assert.equal(turn.translationState, null);
  await sessions.translationsSettled();
  assert.equal(translatorCalls.length, 0);
  assert.equal(await turnsToday(w), 1);
  // skipTranslation: false is the default, and is held.
  const second = randomUUID();
  replies = [JAPANESE];
  await guests.turn(w.guestId, w.sessionId, { clientTurnId: second, content: FRENCH, skipTranslation: false });
  await sessions.translationsSettled();
  assert.equal((await turnOf(w, second)).content, JAPANESE);
});

scenario('(4) owner Translation off: a guest turn goes as written, never held, no translator call', async () => {
  for (const [label, prefs] of [
    ['off', { translationEnabled: false, translationLanguage: 'zh-Hans', translationAgentLanguage: 'ja' }],
    ['absent', {}],
  ] as const) {
    const w = await world(label, prefs);
    const clientTurnId = randomUUID();
    const sent = await guests.turn(w.guestId, w.sessionId, { clientTurnId, content: FRENCH }) as { translation?: unknown };
    assert.equal(sent.translation, undefined, label);
    const turn = await turnOf(w, clientTurnId);
    assert.equal(turn.status, 'PENDING', label);
    assert.equal(turn.content, FRENCH, label);
    assert.equal(turn.translationState, null, label);
    // optimizedTranslation is ignored with Translation off, as on the owner's door.
    const optimized = randomUUID();
    await guests.turn(w.guestId, w.sessionId, { clientTurnId: optimized, content: FRENCH, optimizedTranslation: JAPANESE });
    assert.equal((await turnOf(w, optimized)).content, FRENCH, label);
    await sessions.translationsSettled();
    assert.equal(translatorCalls.length, 0, label);
    assert.equal(await turnsToday(w), 2, label);
  }
});

scenario('(5) a replayed clientTurnId counts once toward the day, held and after its release', async () => {
  const w = await world('replay', TRANSLATION_ON);
  const clientTurnId = randomUUID();
  // The first translation fails, so the turn stays held through the first replay.
  replies = [];
  const first = await guests.turn(w.guestId, w.sessionId, { clientTurnId, content: FRENCH });
  await sessions.translationsSettled();
  assert.equal((await turnOf(w, clientTurnId)).status, 'HELD');
  const triedOnce = translatorCalls.length;
  const replayHeld = await guests.turn(w.guestId, w.sessionId, { clientTurnId, content: FRENCH });
  assert.equal(replayHeld.turnId, first.turnId);
  assert.equal(await turnsToday(w), 1, 'a replay of a held turn counts nothing');
  // Released by Retry, then replayed again.
  replies = [JAPANESE];
  await sessions.retryTurnTranslation(w.ownerId, w.sessionId, first.turnId);
  await sessions.translationsSettled();
  assert.equal((await turnOf(w, clientTurnId)).content, JAPANESE);
  const replayReleased = await guests.turn(w.guestId, w.sessionId, { clientTurnId, content: FRENCH });
  assert.equal(replayReleased.turnId, first.turnId);
  assert.equal(await turnsToday(w), 1, 'a replay after release counts nothing');
  assert.equal(await guestActivities(w), 1, 'and records nothing again');
  assert.equal(await db.conversationTurn.count({ where: { sessionId: w.sessionId, clientTurnId } }), 1);
  assert.equal(translatorCalls.length, triedOnce + 1, 'the Retry alone; no replay translates');
});
