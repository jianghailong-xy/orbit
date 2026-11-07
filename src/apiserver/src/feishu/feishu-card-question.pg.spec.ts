/**
 * The owner answers the agent's question (AskUserQuestion) on its Feishu card (docs/feishu-bot-design.md §6.1, §6.4,
 * §7.2, §7.4; task F2-2), end to end against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, the
 * production apiserver (`build/main.js`), and the fake open platform its long connection reaches
 * (feishu/test-support/fake-open-platform.ts). The runner's side is its own HTTP door: it files the question with
 * `POST /api/runner/sessions/:id/approvals`, which makes PushService send the card, and long-polls the decision with
 * `GET /api/runner/sessions/:id/approvals/:approvalId` as the engine's permission prompt does. Each submission is pushed
 * down the long connection as Feishu pushes a form's submit: the Submit button's value, and the form's values by the
 * names on the card Feishu received. What it is held to:
 *
 *   (1) single select: the runner's long poll gets allow with answers {question → [the chosen label]}, the same as the
 *       web app's decision route gives it for the same choice; recorded as FEISHU with one Activity row; toast
 *       `Answer sent.` and the card drawn as `Answered in Orbit` with no control;
 *   (2) multi select: answers {question → the chosen labels};
 *   (3) Other text: a typed answer on a single select is the answer, and on a multi select joins the picks;
 *   (4) TITLES_ONLY: the card has no answer control, only Open in Orbit, and shows no question; a submission naming
 *       the question is refused and writes nothing;
 *   (5) a form leaving a question unanswered, Allow once naming a question, and the form naming a tool approval are
 *       refused and write nothing; the same submission handled a second time decides nothing more.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-card-question.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { WRITE_TRAP } from '../auth/tenant-isolation-fixtures';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FakeOpenPlatform, type FakeConnection } from './test-support/fake-open-platform';

const URL_ = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-card-question-${randomUUID()}`;
const RUN = randomBytes(4).toString('hex');
const JWT_SECRET = `feishu-card-question-${randomUUID()}`;
const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit questions bot' };
const ALICE = 'ou_alice_owner';

async function until<T>(what: string, probe: () => Promise<T> | T, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

type Row = Record<string, unknown>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const without = (row: Row, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

function tagged(value: unknown, tag: string): Json[] {
  if (Array.isArray(value)) return value.flatMap((v) => tagged(v, tag));
  if (!value || typeof value !== 'object') return [];
  const self = (value as { tag?: unknown }).tag === tag ? [value as Json] : [];
  return [...self, ...Object.values(value).flatMap((v) => tagged(v, tag))];
}
const callbacks = (card: unknown): Json[] =>
  tagged(card, 'button').flatMap((b) => ((b.behaviors as Json[]) ?? []).filter((x) => x.type === 'callback').map((x) => x.value as Json));
/** Every control on a card other than a link to Orbit. */
const answerControls = (card: unknown): string[] => [
  ...['form', 'select_static', 'multi_select_static', 'input', 'checker'].filter((tag) => tagged(card, tag).length > 0),
  ...tagged(card, 'button').filter((b) => ((b.behaviors as Json[]) ?? []).some((x) => x.type !== 'open_url')).map((b) => JSON.stringify(b)),
];

/** The question the agent asks: one single-select and one multi-select question. */
const DATABASE = 'Which database should the service use?';
const CHECKS = 'Which checks should run before merging?';
const QUESTIONS = {
  questions: [
    {
      question: DATABASE, header: 'Database', multiSelect: false,
      options: [{ label: 'Postgres', description: 'what production runs' }, { label: 'SQLite', description: 'a file' }],
    },
    {
      question: CHECKS, header: 'Checks', multiSelect: true,
      options: [{ label: 'Unit tests' }, { label: 'Lint' }, { label: 'End-to-end' }],
    },
  ],
};

/** A card's form, read as a person filling it in reads it: which field is which question's select or own-answer box. */
function formOf(card: Json) {
  const [form, ...more] = tagged(card, 'form');
  assert.ok(form, 'the card has an answer form');
  assert.deepEqual(more, [], 'one form for one question card');
  const selects = [...tagged(form, 'select_static'), ...tagged(form, 'multi_select_static')];
  const inputs = tagged(form, 'input');
  const submit = tagged(form, 'button').find((b) => b.form_action_type === 'submit');
  assert.ok(submit, 'the form has a Submit');
  /** The select of the n-th question, and the value of its option labelled `label` as the card shows it. */
  const option = (n: number, label: string): string => {
    const select = selects.find((s) => s.name.endsWith(`_q${n}`));
    assert.ok(select, `question ${n} has a select`);
    const o = (select.options as Json[]).find((x) => x.text.content === label);
    assert.ok(o, `question ${n} offers ${label}`);
    return o.value as string;
  };
  return {
    selectName: (n: number) => selects.find((s) => s.name.endsWith(`_q${n}`))!.name as string,
    selectTag: (n: number) => selects.find((s) => s.name.endsWith(`_q${n}`))!.tag as string,
    otherName: (n: number) => inputs.find((i) => i.name.endsWith(`_q${n}_other`))!.name as string,
    option,
    submit: (submit.behaviors as Json[]).find((x) => x.type === 'callback')!.value as Json,
    submitName: submit.name as string,
  };
}

test('Feishu: the owner answers the agent\'s question on its card — single, multi and typed answers reach the runner', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const fake = new FakeOpenPlatform();
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await fake.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  fake.addApp(X);
  const fakeUrl = await fake.start();
  process.env[FEISHU_TEST_OPEN_PLATFORM_ENV] = fakeUrl;

  // ── the account: its own app with Alice as its owner, detail FULL, a runner and a workspace; no device ─────────────
  const ownerId = randomUUID();
  const email = `feishu-card-question-${RUN}@feishu-card-question.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'Feishu questions', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' } });
  await db.feishuApp.create({
    data: {
      ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), ownerOpenId: ALICE, ownerName: 'Alice',
      messageDetail: 'FULL',
    },
  });
  const runnerId = randomUUID();
  const runnerToken = `runner-${randomUUID()}`;
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `runner-${RUN}`, tokenHash: createHash('sha256').update(runnerToken).digest('hex'),
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(Date.now() + 2 * 3_600_000),
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `workspace-${RUN}`, enabled: true } });
  const bearer = await new JwtService({ secret: JWT_SECRET }).signAsync({ sub: ownerId, email });

  server = await startApiserver(url, JWT_SECRET, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl });
  const connection: FakeConnection = await until('the app connected', () => fake.openConnections(X.appId)[0]).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${server!.output().slice(-4000)}`);
  });

  const runner = (method: string, path: string, body?: unknown) =>
    call(server!, method, `/api/runner${path}`, runnerToken, body, { 'x-orbit-runner-caller': 'mcp' });
  const session = async (title: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: 'the work', provider: 'claude',
        status: RunStatus.RUNNING, engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(),
        runtimeSessionId: randomUUID(),
      },
    });
    return id;
  };
  /** The runner files an approval in a new session; resolves with its id and the card Feishu received for it. */
  const ask = async (title: string, toolName = 'AskUserQuestion', input: unknown = QUESTIONS) => {
    const sessionId = await session(title);
    const sentBefore = fake.messages.length;
    const filed = await runner('POST', `/sessions/${sessionId}/approvals`, { toolName, input, toolUseId: `tu-${randomUUID()}` });
    assert.equal(filed.status, 201, filed.text);
    const sent = await until(`the card for ${filed.json.id}`, () =>
      fake.messages.slice(sentBefore).find((m) => m.method === 'POST' && m.path === '/open-apis/im/v1/messages'));
    await until('the card row SENT', async () =>
      (await db.feishuMessage.findFirst({ where: { messageId: sent.answeredWith!, status: 'SENT' } })) !== null);
    return {
      sessionId, approvalId: filed.json.id as string, messageId: sent.answeredWith!,
      card: JSON.parse((sent.body as { content: string }).content) as Json,
    };
  };
  const poll = (sessionId: string, approvalId: string) => runner('GET', `/sessions/${sessionId}/approvals/${approvalId}`);

  let seq = 0;
  const events: Record<string, unknown> = {};
  /** Push one form submission (or click) by Alice on `messageId`: the button's value and the form's values. */
  async function submit(messageId: string, value: Json, formValue?: Json, name?: string) {
    const eventId = `ev-card-question-${RUN}-${++seq}`;
    const envelope = {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'card.action.trigger', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        operator: { open_id: ALICE },
        token: fake.cardToken(),
        action: { tag: 'button', value, ...(formValue ? { form_value: formValue } : {}), ...(name ? { name } : {}) },
        context: { open_message_id: messageId, open_chat_id: `oc_p2p_${ALICE}` },
      },
    };
    events[eventId] = envelope;
    const started = Date.now();
    const ack = await fake.push(connection, envelope);
    assert.equal(ack.code, 200);
    return { eventId, answer: ack.data as Json, ms: Date.now() - started };
  }
  const approvalRow = (id: string) => db.approval.findUniqueOrThrow({ where: { id } });
  const decidedActivity = (approvalId: string) =>
    db.activity.findMany({ where: { type: 'feishu.approval.decided', payload: { path: ['approvalId'], equals: approvalId } } });

  /** Answer a fresh question card with `fill`; assert the runner gets exactly `expected` and return its decision. */
  async function answerOnCard(title: string, fill: (f: ReturnType<typeof formOf>) => Json, expected: Record<string, string[]>) {
    const asked = await ask(title);
    const form = formOf(asked.card);
    const waiting = poll(asked.sessionId, asked.approvalId);
    const c = await submit(asked.messageId, form.submit, fill(form), form.submitName);
    assert.ok(c.ms < 3_000, `answered in ${c.ms}ms`);
    assert.deepEqual(c.answer.toast, { type: 'success', content: 'Answer sent.' });
    assert.deepEqual(answerControls(c.answer.card.data), [], 'the card is drawn with no control');
    assert.match(JSON.stringify(c.answer.card.data), /Answered in Orbit · \d\d:\d\d UTC/);
    const decision = await waiting;
    assert.equal(decision.status, 200, decision.text);
    assert.equal(decision.json.status, 'ALLOWED');
    assert.equal(decision.json.behavior, 'allow');
    assert.deepEqual(decision.json.answers, expected, 'the runner gets the answers chosen on the card');
    const row = await approvalRow(asked.approvalId);
    assert.equal(row.decidedCredentialKind, 'FEISHU');
    assert.equal(row.decidedFeishuOpenId, ALICE);
    assert.equal(row.decidedFeishuMessageId, asked.messageId);
    assert.deepEqual(row.answers, expected);
    const activity = await decidedActivity(asked.approvalId);
    assert.equal(activity.length, 1, 'one Activity row');
    assert.equal(activity[0]!.credentialKind, 'FEISHU');
    assert.deepEqual(activity[0]!.payload, {
      sessionId: asked.sessionId, approvalId: asked.approvalId, behavior: 'allow', appId: X.appId, openId: ALICE, messageId: asked.messageId,
    });
    return { ...asked, decision, eventId: c.eventId };
  }

  await t.test('(1) single select: the runner gets the chosen label, as the web app would send it', async () => {
    const expected = { [DATABASE]: ['SQLite'], [CHECKS]: ['Lint'] };
    const done = await answerOnCard('Pick a database', (f) => {
      assert.equal(f.selectTag(0), 'select_static', 'a single-select question is a single select');
      return { [f.selectName(0)]: f.option(0, 'SQLite'), [f.selectName(1)]: [f.option(1, 'Lint')] };
    }, expected);
    events.answered = { eventId: done.eventId, approvalId: done.approvalId };

    // The web app's question form, for the same choice: the runner gets the same decision, id aside.
    const viaWeb = await ask('Pick a database on the web');
    const webWaiting = poll(viaWeb.sessionId, viaWeb.approvalId);
    const web = await call(server!, 'POST', `/api/sessions/${viaWeb.sessionId}/approvals/${viaWeb.approvalId}/decision`, bearer, { behavior: 'allow', answers: expected });
    assert.equal(web.status, 201, web.text);
    const webDecision = await webWaiting;
    assert.deepEqual(without(done.decision.json, 'id', 'publicId'), without(webDecision.json, 'id', 'publicId'), 'the same decision, whichever door it came in by');
  });

  await t.test('(2) multi select: the runner gets every chosen label', async () => {
    await answerOnCard('Choose the checks', (f) => {
      assert.equal(f.selectTag(1), 'multi_select_static', 'a multi-select question is a multi select');
      return { [f.selectName(0)]: f.option(0, 'Postgres'), [f.selectName(1)]: [f.option(1, 'Unit tests'), f.option(1, 'End-to-end')] };
    }, { [DATABASE]: ['Postgres'], [CHECKS]: ['Unit tests', 'End-to-end'] });
  });

  await t.test('(3) Other text: typed by hand, the answer itself on a single select, beside the picks on a multi select', async () => {
    await answerOnCard('Type an answer', (f) => ({
      [f.otherName(0)]: 'MySQL 8',
      [f.selectName(1)]: [f.option(1, 'Lint')],
      [f.otherName(1)]: 'Load test',
    }), { [DATABASE]: ['MySQL 8'], [CHECKS]: ['Lint', 'Load test'] });
  });

  // ── the write trap, for what a refused submission may write: the inbox's own record of it, and nothing else ──────
  await sql.query(WRITE_TRAP);
  const mark = async (): Promise<bigint> =>
    BigInt((await sql.query<{ seq: string }>(`SELECT coalesce(max("seq"), 0)::text AS "seq" FROM "tenant_census_write"`)).rows[0].seq);
  const appRow = async (): Promise<Row> => (await sql.query(`SELECT to_jsonb(a) AS r FROM feishu_app a WHERE app_id = $1`, [X.appId])).rows[0].r;
  const strayWrites = async (since: bigint, eventId: string, app: Row): Promise<string[]> => {
    const rows = (await sql.query<{ tbl: string; op: string; row: Row }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`, [since.toString()],
    )).rows;
    return rows.filter(({ tbl, op, row }) => {
      if (tbl === 'feishu_inbound_event' && (op === 'INSERT' || op === 'UPDATE') && row.event_id === eventId) return false;
      if (tbl === 'feishu_app' && op === 'UPDATE' && JSON.stringify(without(row, 'last_event_at')) === JSON.stringify(without(app, 'last_event_at'))) return false;
      if (tbl === 'feishu_link' && op === 'UPDATE') return false;
      return true;
    }).map(({ tbl, op, row }) => `${op} ${tbl} ${JSON.stringify(row).slice(0, 300)}`);
  };
  async function refused(messageId: string, value: Json, formValue?: Json) {
    const app = await appRow();
    const before = await mark();
    const c = await submit(messageId, value, formValue);
    await until(`${c.eventId} processed`, async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL`, [X.appId, c.eventId])).rowCount);
    await sleep(300);
    return { ...c, stray: await strayWrites(before, c.eventId, app) };
  }

  await t.test('(4) TITLES_ONLY: only Open in Orbit, no question shown, and a submission is refused', async () => {
    await db.feishuApp.update({ where: { appId: X.appId }, data: { messageDetail: 'TITLES_ONLY' } });
    try {
      const asked = await ask('A question, titles only');
      assert.deepEqual(answerControls(asked.card), [], 'no answer control');
      assert.equal(tagged(asked.card, 'button').length, 1, 'one button');
      assert.equal(tagged(asked.card, 'button')[0]!.text.content, 'Open in Orbit');
      const json = JSON.stringify(asked.card);
      for (const word of [DATABASE, CHECKS, 'Postgres', 'SQLite', 'Lint']) assert.ok(!json.includes(word), `the default card shows ${word}`);
      assert.ok(json.includes('The agent asked you a question'));
      // A submission crafted from a FULL card's shape is refused all the same.
      const r = await refused(asked.messageId, { action: 'question.answer', approvalId: asked.approvalId }, { a0_q0: '0', a0_q1: ['1'] });
      assert.deepEqual(r.answer, { toast: { type: 'info', content: 'This question is answered in Orbit. Open it in Orbit to answer.' } });
      assert.deepEqual(r.stray, []);
      assert.equal((await approvalRow(asked.approvalId)).status, 'PENDING');
      await db.approval.update({ where: { id: asked.approvalId }, data: { status: 'DENIED', decidedAt: new Date() } });
    } finally {
      await db.feishuApp.update({ where: { appId: X.appId }, data: { messageDetail: 'FULL' } });
    }
  });

  await t.test('(5) incomplete, mismatched and replayed submissions decide nothing more', async () => {
    const asked = await ask('Half an answer');
    const form = formOf(asked.card);
    // A question left with neither a pick nor typed text.
    const half = await refused(asked.messageId, form.submit, { [form.selectName(0)]: form.option(0, 'Postgres'), [form.otherName(1)]: '  ' });
    assert.deepEqual(half.answer, { toast: { type: 'error', content: 'Answer every question, then submit.' } });
    assert.deepEqual(half.stray, []);
    // Allow once naming the question: a question is answered with its form.
    const allow = await refused(asked.messageId, { action: 'approval.allow', approvalId: asked.approvalId });
    assert.deepEqual(allow.answer, { toast: { type: 'info', content: 'Answer this in Orbit.' } });
    assert.deepEqual(allow.stray, []);
    assert.equal((await approvalRow(asked.approvalId)).status, 'PENDING');
    // The form naming a tool approval.
    const tool = await ask('A tool', 'Bash', { command: 'ls' });
    const mismatched = await refused(tool.messageId, { action: 'question.answer', approvalId: tool.approvalId }, { a0_q0: '0' });
    assert.deepEqual(mismatched.answer, { toast: { type: 'info', content: 'Answer this in Orbit.' } });
    assert.deepEqual(mismatched.stray, []);
    assert.equal((await approvalRow(tool.approvalId)).status, 'PENDING');

    // The answered submission of (1) handled a second time.
    const { eventId, approvalId } = events.answered as { eventId: string; approvalId: string };
    const first = await approvalRow(approvalId);
    const app = await appRow();
    const before = await mark();
    await sql.query(`UPDATE feishu_inbound_event SET processed_at = NULL, attempts = 1, lease_until = NULL WHERE app_id = $1 AND event_id = $2`, [X.appId, eventId]);
    await until('handled again', async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts = 2`, [X.appId, eventId])).rowCount);
    await sleep(300);
    const again = await approvalRow(approvalId);
    assert.equal(again.decidedAt?.getTime(), first.decidedAt?.getTime(), 'one decision');
    assert.deepEqual(again.answers, first.answers);
    assert.equal((await decidedActivity(approvalId)).length, 1, 'one Activity row');
    assert.deepEqual(
      (await strayWrites(before, eventId, app)).filter((w) => !w.includes('UPDATE feishu_inbound_event')),
      [],
      'nothing written beyond the inbox row the spec reset',
    );
  });
});
