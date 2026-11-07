import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeishuMessageDetail } from '@orbit/shared';
import {
  CUT_NOTE,
  DETAILS_HIDDEN,
  FEISHU_CARD_ACTIONS,
  FEISHU_CARD_MAX_BYTES,
  REPLY_HINT,
  approvalClass,
  renderFeishuCard,
  renderFeishuTerminalCard,
  type FeishuAlert,
  type FeishuCard,
  type FeishuCardContext,
} from './cards/feishu-cards';

/**
 * docs/feishu-bot-design.md §6.1, §6.4: every kind of alert card in both detail modes. TITLES_ONLY (the default)
 * carries the session's or project's title, the kind of event and a tool's name; each piece of detail below is
 * a sentinel that must appear in no string anywhere in the default card, and in the FULL one.
 *
 * Specs run from build/<dir>/, one level deep, so this one sits beside cards/ rather than in it.
 */

const URL = 'https://orbit.example/sessions/s1';
const ctx = (detail: FeishuMessageDetail, approvalsInFeishu = true): FeishuCardContext => ({ detail, approvalsInFeishu, openUrl: URL });

/** Every string the card holds, keys aside: what Feishu would store. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
const holds = (card: FeishuCard, needle: string) => strings(card).some((s) => s.includes(needle));

/** Every element of `tag`, at any depth. */
function tagged(value: unknown, tag: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((v) => tagged(v, tag));
  if (!value || typeof value !== 'object') return [];
  const self = (value as { tag?: unknown }).tag === tag ? [value as Record<string, unknown>] : [];
  return [...self, ...Object.values(value).flatMap((v) => tagged(v, tag))];
}
const callbacks = (card: FeishuCard): string[] =>
  tagged(card, 'button').flatMap((b) => ((b.behaviors as { type: string; value?: { action: string } }[]) ?? [])
    .filter((x) => x.type === 'callback').map((x) => x.value!.action));
const openUrls = (card: FeishuCard): string[] =>
  tagged(card, 'button').flatMap((b) => ((b.behaviors as { type: string; default_url?: string }[]) ?? [])
    .filter((x) => x.type === 'open_url').map((x) => x.default_url!));

interface Case {
  name: string;
  alert: FeishuAlert;
  /** Always on the card. */
  titles: string[];
  /** Only on the FULL card. */
  details: string[];
  /** The callback actions the live card offers in each mode (approvals in Feishu on). */
  actions: { TITLES_ONLY: string[]; FULL: string[] };
}

const CASES: Case[] = [
  {
    name: 'approval: tool permission',
    alert: {
      kind: 'approval',
      sessionTitle: 'Fix the login redirect',
      approvals: [{ id: 'ap1', toolName: 'Bash', input: { command: 'rm -rf SENTINEL_TOOL_INPUT' } }],
    },
    titles: ['Fix the login redirect', 'Bash', DETAILS_HIDDEN],
    details: ['SENTINEL_TOOL_INPUT'],
    actions: { TITLES_ONLY: [FEISHU_CARD_ACTIONS.allow, FEISHU_CARD_ACTIONS.deny], FULL: [FEISHU_CARD_ACTIONS.allow, FEISHU_CARD_ACTIONS.deny] },
  },
  {
    name: "approval: the agent's question",
    alert: {
      kind: 'approval',
      sessionTitle: 'Pick a database',
      approvals: [{
        id: 'ap2',
        toolName: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'SENTINEL_QUESTION which one?',
            header: 'SENTINEL_HEADER',
            multiSelect: false,
            options: [{ label: 'SENTINEL_OPTION_A', description: 'SENTINEL_OPTION_WHY' }, { label: 'SENTINEL_OPTION_B' }],
          }],
        },
      }],
    },
    titles: ['Pick a database', 'The agent asked you a question'],
    details: ['SENTINEL_QUESTION', 'SENTINEL_HEADER', 'SENTINEL_OPTION_A', 'SENTINEL_OPTION_WHY', 'SENTINEL_OPTION_B'],
    actions: { TITLES_ONLY: [], FULL: [FEISHU_CARD_ACTIONS.answer] },
  },
  {
    name: "approval: Orbit's own confirmation card",
    alert: {
      kind: 'approval',
      sessionTitle: 'Plan the migration',
      approvals: [{ id: 'ap3', toolName: 'orbit_task_create', input: { title: 'SENTINEL_CARD_SUMMARY' } }],
    },
    titles: ['Plan the migration', 'Confirm: Create a task'],
    details: ['SENTINEL_CARD_SUMMARY'],
    actions: { TITLES_ONLY: [], FULL: [] },
  },
  {
    name: 'finished',
    alert: { kind: 'finished', sessionTitle: 'Ship the release', body: 'SENTINEL_RECAP: tagged v1.2.3' },
    titles: ['Ship the release', 'Finished', REPLY_HINT],
    details: ['SENTINEL_RECAP'],
    actions: { TITLES_ONLY: [], FULL: [] },
  },
  {
    name: 'failed',
    alert: { kind: 'failed', sessionTitle: 'Run the backfill', body: 'Failed: SENTINEL_FAILURE_REASON' },
    titles: ['Run the backfill', 'Failed', REPLY_HINT],
    details: ['SENTINEL_FAILURE_REASON'],
    actions: { TITLES_ONLY: [], FULL: [] },
  },
  {
    name: 'agent-message',
    alert: { kind: 'agent-message', sessionTitle: 'Watch the deploy', message: 'SENTINEL_NOTIFY deploy is green' },
    titles: ['Watch the deploy', 'The agent sent you a message', REPLY_HINT],
    details: ['SENTINEL_NOTIFY'],
    actions: { TITLES_ONLY: [], FULL: [] },
  },
  ...([
    ['approve-merge-to-main', 'Merge to main needs your approval'],
    ['coordinator-question', 'The coordinator has a question'],
    ['escalated-to-you', 'Escalated to you'],
    ['fuse-paused', 'The coordinator paused itself'],
    ['landed-without-confirmation', 'Landed without your confirmation'],
  ] as const).map(([kind, word]): Case => ({
    name: `owner item: ${kind}`,
    alert: {
      kind: 'owner-item',
      projectTitle: 'Feishu bot',
      alert: { kind, title: `SENTINEL_ITEM_TITLE ${kind}`, body: `SENTINEL_ITEM_BODY ${kind}` },
    },
    titles: ['Feishu bot', word],
    details: [`SENTINEL_ITEM_TITLE ${kind}`, `SENTINEL_ITEM_BODY ${kind}`],
    actions: { TITLES_ONLY: [], FULL: [] },
  })),
  {
    name: 'any other kind',
    alert: { kind: 'other', eventKind: 'Engine signed out', title: 'runner-1', body: 'SENTINEL_PUSH_BODY sign in again' },
    titles: ['Engine signed out', 'runner-1'],
    details: ['SENTINEL_PUSH_BODY'],
    actions: { TITLES_ONLY: [], FULL: [] },
  },
];

for (const c of CASES) {
  test(`${c.name}: TITLES_ONLY carries titles only, FULL adds the details`, () => {
    const hidden = renderFeishuCard(c.alert, ctx('TITLES_ONLY'));
    const shown = renderFeishuCard(c.alert, ctx('FULL'));
    assert.equal(hidden.schema, '2.0');
    for (const title of c.titles) {
      assert.ok(holds(hidden, title), `TITLES_ONLY has ${title}`);
      assert.ok(holds(shown, title.replace(DETAILS_HIDDEN, '')), `FULL has ${title}`);
    }
    for (const detail of c.details) {
      // Field by field: no string anywhere in the default card, the summary and header included.
      for (const s of strings(hidden)) assert.ok(!s.includes(detail), `TITLES_ONLY leaks ${detail} in ${JSON.stringify(s)}`);
      assert.ok(!JSON.stringify(hidden).includes(detail), `TITLES_ONLY JSON holds ${detail}`);
      assert.ok(holds(shown, detail), `FULL has ${detail}`);
    }
    assert.ok(!holds(shown, DETAILS_HIDDEN), 'FULL does not say the details are hidden');
    // The chat list's preview is the header's own line.
    assert.equal(hidden.config.summary.content, `${hidden.header.title.content} · ${hidden.header.subtitle.content}`);
    assert.equal(hidden.config.update_multi, true);
    // Buttons per §6.1's last column, and Open in Orbit on every live card.
    assert.deepEqual(callbacks(hidden), c.actions.TITLES_ONLY);
    assert.deepEqual(callbacks(shown), c.actions.FULL);
    assert.deepEqual(openUrls(hidden), [URL]);
    assert.deepEqual(openUrls(shown), [URL]);
  });

  test(`${c.name}: the terminal card has no button or form, in either mode`, () => {
    for (const detail of ['TITLES_ONLY', 'FULL'] as const) {
      const card = renderFeishuTerminalCard(c.alert, ctx(detail), 'Allowed in Orbit · 10:32');
      assert.equal(tagged(card, 'button').length, 0, detail);
      assert.equal(tagged(card, 'form').length, 0, detail);
      assert.ok(holds(card, 'Allowed in Orbit · 10:32'));
      assert.ok(holds(card, URL), 'still links to Orbit');
      assert.equal(card.header.template, 'grey');
      if (detail === 'TITLES_ONLY') for (const d of c.details) assert.ok(!JSON.stringify(card).includes(d), `terminal leaks ${d}`);
    }
  });
}

test('approvals in Feishu off: no Allow, Deny or answer form, only Open in Orbit', () => {
  for (const c of CASES.slice(0, 2)) {
    const card = renderFeishuCard(c.alert, ctx('FULL', false));
    assert.deepEqual(callbacks(card), []);
    assert.equal(tagged(card, 'form').length, 0);
    assert.deepEqual(openUrls(card), [URL]);
  }
});

test('one stretch of approvals is one card, each with its own buttons', () => {
  const card = renderFeishuCard({
    kind: 'approval',
    sessionTitle: 'Refactor',
    approvals: [
      { id: 'a', toolName: 'Bash', input: { command: 'ls' } },
      { id: 'b', toolName: 'Edit', input: { file_path: 'x.ts' } },
      { id: 'c', toolName: 'Write', input: { file_path: 'y.ts' } },
    ],
  }, ctx('TITLES_ONLY'));
  assert.equal(card.header.subtitle.content, '3 approvals need your reply');
  const ids = tagged(card, 'button').flatMap((b) => (b.behaviors as { value?: { approvalId: string } }[]).flatMap((x) => (x.value ? [x.value.approvalId] : [])));
  assert.deepEqual(ids, ['a', 'a', 'b', 'b', 'c', 'c']);
  for (const tool of ['Bash', 'Edit', 'Write']) assert.ok(holds(card, `Needs your reply · ${tool}`));
});

test('the tool input preview is the Web card JSON, scrubbed of credentials and workspace variable values', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  const tool = renderFeishuCard({
    kind: 'approval', sessionTitle: 's', approvals: [{ id: 'a', toolName: 'Bash', input: { command: `curl -H "Authorization: ${token}"` } }],
  }, ctx('FULL'));
  assert.ok(!JSON.stringify(tool).includes(token));
  assert.ok(holds(tool, '[redacted]'));
  assert.ok(holds(tool, JSON.stringify({ command: 'x' }, null, 2).split('"x"')[0]), 'pretty-printed like the Web card');

  const write = renderFeishuCard({
    kind: 'approval', sessionTitle: 's', approvals: [{ id: 'a', toolName: 'orbit_agent_update', input: { changes: { env: { API_KEY: 'value-that-is-secret' } } } }],
  }, ctx('FULL'));
  assert.ok(!JSON.stringify(write).includes('value-that-is-secret'));
  assert.ok(holds(write, 'API_KEY'), 'the names stay');
});

test('a card stays within 30 KB: long details are cut and say so', () => {
  for (const alert of [
    { kind: 'agent-message', sessionTitle: 's', message: '字'.repeat(40_000) },
    { kind: 'approval', sessionTitle: 's', approvals: [{ id: 'a', toolName: 'Bash', input: { command: 'x'.repeat(100_000) } }] },
    { kind: 'approval', sessionTitle: 's', approvals: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, toolName: 'Bash', input: { command: 'y'.repeat(5_000) } })) },
  ] as FeishuAlert[]) {
    const card = renderFeishuCard(alert, ctx('FULL'));
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8');
    assert.ok(bytes <= FEISHU_CARD_MAX_BYTES, `${bytes} bytes`);
    assert.ok(holds(card, CUT_NOTE), 'says it was cut');
    assert.deepEqual(openUrls(card), [URL]);
  }
  const short = renderFeishuCard({ kind: 'agent-message', sessionTitle: 's', message: 'short' }, ctx('FULL'));
  assert.ok(!holds(short, CUT_NOTE));
});

test("a card too long even with its details cut keeps its title and says it's too long", () => {
  const card = renderFeishuCard({
    kind: 'approval', sessionTitle: 's',
    approvals: Array.from({ length: 400 }, (_, i) => ({ id: `approval-${i}`, toolName: 'Bash', input: {} })),
  }, ctx('TITLES_ONLY'));
  assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') <= FEISHU_CARD_MAX_BYTES);
  assert.ok(holds(card, 'too long for a Feishu card'));
  assert.deepEqual(openUrls(card), [URL]);
});

test("which of §6.1's approval rows an approval is", () => {
  assert.equal(approvalClass('AskUserQuestion'), 'question');
  assert.equal(approvalClass('orbit_project_create'), 'orbit');
  assert.equal(approvalClass('orbit_runner_delete'), 'orbit');
  // An engine's own prompt for an MCP call is a tool permission, answered with Allow once.
  assert.equal(approvalClass('mcp__orbit__agent_update'), 'tool');
  assert.equal(approvalClass('orbit__agent_update'), 'tool');
  assert.equal(approvalClass('Bash'), 'tool');
});
