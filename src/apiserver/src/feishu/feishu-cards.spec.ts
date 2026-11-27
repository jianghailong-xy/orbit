import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeishuMessageDetail } from '@orbit/shared';
import {
  ANSWER_IN_ORBIT,
  CUT_NOTE,
  DETAILS_HIDDEN,
  FEISHU_CARD_ACTIONS,
  FEISHU_CARD_MAX_BYTES,
  REPLY_HINT,
  approvalClass,
  renderFeishuCard,
  renderFeishuTerminalCard,
  startedByLine,
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
const ctx = (detail: FeishuMessageDetail, approvalsInFeishu = true, showOrbit = true): FeishuCardContext =>
  ({ detail, approvalsInFeishu, showOrbit, openUrl: URL });

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
      // A settled card waits on nothing, so it never says it does.
      assert.ok(!/needs? your reply/i.test(JSON.stringify(card)), `terminal ${detail} still asks for a reply`);
    }
  });

  if (c.alert.kind === 'approval' && c.alert.approvals.length === 1) {
    test(`${c.name}: the body does not repeat the subtitle, live or settled`, () => {
      for (const detail of ['TITLES_ONLY', 'FULL'] as const) {
        for (const card of [renderFeishuCard(c.alert, ctx(detail)), renderFeishuTerminalCard(c.alert, ctx(detail), 'Allowed in Feishu · 10:32 UTC')]) {
          const subtitle = card.header.subtitle.content;
          assert.ok(!strings(card.body).includes(subtitle), `${detail}: ${JSON.stringify(subtitle)} is in the body`);
        }
      }
    });
  }
}

test('a settled tool approval names the tool alone, one or several', () => {
  const one = renderFeishuTerminalCard(
    { kind: 'approval', sessionTitle: 'Fix', approvals: [{ id: 'a', toolName: 'Bash', input: { command: 'ls' } }] },
    ctx('TITLES_ONLY'), 'Denied in Feishu · 15:19 UTC',
  );
  assert.equal(one.header.subtitle.content, 'Bash');
  assert.equal(one.config.summary.content, 'Fix · Denied in Feishu · 15:19 UTC');
  const several = renderFeishuTerminalCard({
    kind: 'approval',
    sessionTitle: 'Refactor',
    approvals: [{ id: 'a', toolName: 'Bash', input: {} }, { id: 'b', toolName: 'Edit', input: {} }],
  }, ctx('TITLES_ONLY'), 'Allowed in Orbit · 10:32 UTC');
  assert.equal(several.header.subtitle.content, '2 approvals');
  for (const tool of ['Bash', 'Edit']) assert.ok(strings(several.body).includes(tool), `${tool} keeps its own line`);
  assert.ok(!/needs? your reply/i.test(JSON.stringify(several)));
});

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

test("a notify from outside any session (a script's `orbit notify`) does not offer a reply to a session", () => {
  const card = renderFeishuCard({ kind: 'agent-message', sessionTitle: 'orbit@austin', message: 'disk is 91% full', sessionless: true }, ctx('FULL'));
  assert.ok(holds(card, 'disk is 91% full'));
  assert.ok(!holds(card, REPLY_HINT), 'there is no session to reply to');
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

/** Every button, form or input on a card that does anything other than open Orbit. */
function actionControls(card: FeishuCard): string[] {
  const out: string[] = [];
  for (const tag of ['form', 'select_static', 'multi_select_static', 'input', 'checker']) {
    if (tagged(card, tag).length > 0) out.push(tag);
  }
  for (const button of tagged(card, 'button')) {
    const behaviors = (button.behaviors as { type: string }[] | undefined) ?? [];
    if (behaviors.length === 0 || behaviors.some((b) => b.type !== 'open_url')) out.push(JSON.stringify(button));
  }
  return out;
}

test("decision 1: Orbit's confirmation cards and owner items carry no action button, only Open in Orbit (F2-1)", () => {
  // The orchestration cards §7.2 keeps in the app: a task, a project, a workspace made or changed, a runner deleted,
  // the MCP orchestration grant, and the rest the server files as `orbit_<name>`.
  const orchestration = [
    'orbit_task_create', 'orbit_task_batch', 'orbit_project_create', 'orbit_agent_create', 'orbit_agent_update',
    'orbit_agent_delete', 'orbit_runner_delete', 'orbit_allow_orchestration', 'orbit_dag_change', 'orbit_blocker_resolve',
    'orbit_provider_create', 'orbit_integration_skip_merge_check',
  ];
  for (const toolName of orchestration) {
    for (const detail of ['TITLES_ONLY', 'FULL'] as const) {
      // Approvals in Feishu on: the switch that gives a tool approval its buttons gives these none.
      const card = renderFeishuCard({ kind: 'approval', sessionTitle: 'S', approvals: [{ id: 'o1', toolName, input: { title: 't' } }] }, ctx(detail));
      assert.deepEqual(actionControls(card), [], `${toolName} ${detail}`);
      assert.deepEqual(openUrls(card), [URL], `${toolName} ${detail}`);
    }
  }
  for (const c of CASES.filter((x) => x.alert.kind === 'owner-item')) {
    for (const detail of ['TITLES_ONLY', 'FULL'] as const) {
      const card = renderFeishuCard(c.alert, ctx(detail));
      assert.deepEqual(actionControls(card), [], `${c.name} ${detail}`);
      assert.deepEqual(openUrls(card), [URL], `${c.name} ${detail}`);
    }
  }
  // Beside a tool approval on the same card, an orchestration card still has none: only the tool's two buttons.
  const mixed = renderFeishuCard({
    kind: 'approval', sessionTitle: 'S',
    approvals: [{ id: 't1', toolName: 'Bash', input: { command: 'ls' } }, { id: 'o1', toolName: 'orbit_task_create', input: {} }],
  }, ctx('FULL'));
  const values = tagged(mixed, 'button').flatMap((b) => (b.behaviors as { type: string; value?: { approvalId: string; action: string } }[])
    .flatMap((x) => (x.value ? [`${x.value.action}:${x.value.approvalId}`] : [])));
  assert.deepEqual(values, [`${FEISHU_CARD_ACTIONS.allow}:t1`, `${FEISHU_CARD_ACTIONS.deny}:t1`]);
});

test('decision 1: a tool approval offers Allow once and Deny, never "always allow"', () => {
  const card = renderFeishuCard({ kind: 'approval', sessionTitle: 'S', approvals: [{ id: 't1', toolName: 'Bash', input: { command: 'ls' } }] }, ctx('FULL'));
  assert.deepEqual(callbacks(card), [FEISHU_CARD_ACTIONS.allow, FEISHU_CARD_ACTIONS.deny]);
  assert.ok(!strings(card).some((s) => /always/i.test(s)), 'no "always allow" anywhere on the card');
  assert.ok(!JSON.stringify(card).includes('remember'), 'no button value asks to remember');
});

test('who started a session the owner did not start: in a group or a direct message, in both modes, kept once settled', () => {
  assert.equal(startedByLine('Li Lei', { group: 'Release crew' }), 'Started by Li Lei in Release crew');
  assert.equal(startedByLine('Li Lei', 'direct-message'), 'Started by Li Lei in a direct message');
  assert.equal(startedByLine(null, { group: null }), 'Started by a Feishu user in a group', 'Feishu would not say the names');

  const approvals = [{ id: 'a', toolName: 'Bash', input: { command: 'ls' } }];
  const question = [{ id: 'q', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }] }] } }];
  for (const line of ['Started by Li Lei in Release crew', 'Started by Li Lei in a direct message']) {
    for (const items of [approvals, question]) {
      const alert: FeishuAlert = { kind: 'approval', sessionTitle: 'Fix the build', approvals: items, startedBy: line };
      for (const detail of ['TITLES_ONLY', 'FULL'] as const) {
        const live = renderFeishuCard(alert, ctx(detail));
        assert.ok(holds(live, line), `${detail}: the live card says who started it`);
        const settled = renderFeishuTerminalCard(alert, ctx(detail), 'Allowed in Orbit · 10:32 UTC');
        assert.ok(holds(settled, line), `${detail}: the settled card keeps it`);
      }
    }
  }

  // The owner's own session: no such line, on any card.
  for (const items of [approvals, question]) {
    for (const detail of ['TITLES_ONLY', 'FULL'] as const) {
      const card = renderFeishuCard({ kind: 'approval', sessionTitle: 'Fix the build', approvals: items }, ctx(detail));
      assert.ok(!holds(card, 'Started by'), `${detail}: the owner's own session says nothing of who started it`);
    }
  }
});

test('a settled approval of a session someone else started keeps who started it beside where it was answered', () => {
  const line = 'Started by Li Lei in Release crew';
  const alert: FeishuAlert = { kind: 'approval', sessionTitle: 'Fix the build', approvals: [{ id: 'a', toolName: 'Bash', input: { command: 'ls' } }], startedBy: line };
  for (const outcome of ['Allowed in Feishu · 10:32 UTC', 'Denied in Orbit · 10:40 UTC']) {
    for (const detail of ['TITLES_ONLY', 'FULL'] as const) {
      const card = renderFeishuTerminalCard(alert, ctx(detail), outcome);
      assert.ok(strings(card.body).includes(outcome), `${detail}: the outcome`);
      assert.ok(strings(card.body).includes(line), `${detail}: who started it`);
      assert.equal(card.header.subtitle.content, 'Bash');
      assert.ok(!strings(card.body).includes('Bash'), `${detail}: the subtitle is not repeated`);
      assert.ok(!/needs? your reply/i.test(JSON.stringify(card)), `${detail}: asks for nothing`);
      assert.equal(tagged(card, 'button').length, 0);
      // Show Orbit in Feishu off (§15.2): no link anywhere, and the outcome reads the same; `in Orbit` is plain text to the owner.
      const hidden = renderFeishuTerminalCard(alert, ctx(detail, true, false), outcome);
      assertNoOrbit(hidden, `${detail} off: ${outcome}`);
      assert.ok(strings(hidden.body).includes(outcome) && strings(hidden.body).includes(line), `${detail} off: outcome and who started it`);
      assert.ok(!/needs? your reply/i.test(JSON.stringify(hidden)), `${detail} off: asks for nothing`);
    }
  }
});

/** Neither the button nor anywhere Orbit lives: no Open in Orbit, no open_url, no Orbit URL in any string (§15.2). */
function assertNoOrbit(card: FeishuCard, what: string): void {
  const json = JSON.stringify(card);
  assert.ok(!json.includes('Open in Orbit'), `${what}: no Open in Orbit`);
  assert.ok(!json.includes('open_url'), `${what}: no link button`);
  assert.ok(!json.includes('orbit.example'), `${what}: no Orbit URL`);
  assert.deepEqual(openUrls(card), [], what);
}

for (const c of CASES) {
  test(`${c.name}: Show Orbit in Feishu on and off, live and settled, in both modes (§15.2)`, () => {
    for (const detail of ['TITLES_ONLY', 'FULL'] as const) {
      const on = renderFeishuCard(c.alert, ctx(detail, true, true));
      assert.deepEqual(openUrls(on), [URL], `${detail} on: Open in Orbit, as before`);
      assert.ok(!holds(on, ANSWER_IN_ORBIT), `${detail} on: the button says it`);
      assert.ok(holds(renderFeishuTerminalCard(c.alert, ctx(detail, true, true), 'Allowed in Orbit · 10:32'), URL), `${detail} on: settled links`);

      const off = renderFeishuCard(c.alert, ctx(detail, true, false));
      assertNoOrbit(off, `${detail} off`);
      // What can be answered on the card still is: Allow once and Deny, the question's form.
      assert.deepEqual(callbacks(off), c.actions[detail], `${detail} off: the same answers on the card`);
      for (const title of c.titles) {
        if (detail === 'FULL' && title === DETAILS_HIDDEN) continue;
        assert.ok(holds(off, title), `${detail} off: still has ${title}`);
      }
      // A card answered only in Orbit says so in one line instead of the button; the others say nothing more.
      const orbitOnly = (c.alert.kind === 'approval' || c.alert.kind === 'owner-item') && c.actions[detail].length === 0;
      assert.equal(holds(off, ANSWER_IN_ORBIT), orbitOnly, `${detail} off: ${orbitOnly ? 'one line' : 'no line'}`);
      const settled = renderFeishuTerminalCard(c.alert, ctx(detail, true, false), 'Allowed in Feishu · 10:32');
      assertNoOrbit(settled, `${detail} off, settled`);
      assert.ok(holds(settled, 'Allowed in Feishu · 10:32'));
      assert.ok(!holds(settled, ANSWER_IN_ORBIT), `${detail} off, settled: nothing left to answer`);
    }
  });
}

test('Show Orbit off: a tool approval still has Allow once and Deny; with approvals in Feishu off it says to answer in Orbit', () => {
  const alert = CASES[0].alert;
  const off = renderFeishuCard(alert, ctx('TITLES_ONLY', true, false));
  assert.deepEqual(tagged(off, 'button').map((b) => (b.text as { content: string }).content), ['Allow once', 'Deny']);
  assert.ok(holds(off, DETAILS_HIDDEN));
  const neither = renderFeishuCard(alert, ctx('TITLES_ONLY', false, false));
  assertNoOrbit(neither, 'approvals off');
  assert.deepEqual(tagged(neither, 'button'), []);
  assert.ok(holds(neither, ANSWER_IN_ORBIT));
});

test('Show Orbit off: a card too long for Feishu keeps its title and no button', () => {
  const alert: FeishuAlert = {
    kind: 'approval', sessionTitle: 's',
    approvals: Array.from({ length: 400 }, (_, i) => ({ id: `approval-${i}`, toolName: 'Bash', input: {} })),
  };
  const card = renderFeishuCard(alert, ctx('TITLES_ONLY', true, false));
  assert.ok(holds(card, 'too long for a Feishu card'));
  assertNoOrbit(card, 'too long');
});
