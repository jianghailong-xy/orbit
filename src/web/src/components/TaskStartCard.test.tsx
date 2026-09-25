// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskStartCard as Card } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { parseTaskStartCard, TASK_START_JUDGED_BY } from '../lib/taskStartCard';
import { COMPLETION_CRITERION_CHIP } from './TaskDetailPanel';
import { Transcript, type RunEvent } from './Transcript';

/**
 * A task run's opening turn is drawn from the task the control plane recorded beside the echo —
 * NOT from the brief the agent was sent.
 *
 * The brief is written for the agent: the task, then four steps of protocol. Drawn as a message it
 * was the owner's own bubble, several screens long. The card is the task as fields, with the brief
 * folded at its foot.
 *
 * What holds this in place is the pair. With the payload the card is drawn and the brief is folded
 * behind it; without one the turn is exactly the bubble it always was, because a brief that carries
 * no card must never be half-recognised from its words.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const COMMAND = "{ out=$(env -u ORBIT_SESSION_ID go test -C src/runner-go -run '^TestCodexAccountQuota' -count=1 ./... 2>&1); }";

const CARD: Card = {
  taskId: '01a0cca7-8609-70ed-a0e2-d4b55b832b60',
  title: 'runner + web：配额按账户归属',
  description: '让每个账户的 plan usage 只进它自己那一行。\n\n背景：`codexSessionOnDefaultAccount` 今天回答的是二值问题。',
  acceptanceCriteria: '配额按账户归属：每个账户的 plan usage 只进它自己那一行。\n验收只跑 RunnerEngines*/RunnerSignIn* 这一组。',
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: COMMAND,
  acceptanceExpectedExitCode: 0,
  listInstructions: null,
  project: { id: '01a0cca0-aeaa-7618-bd5a-caccc089108c', title: 'Codex 多账户：一台机器上登录多个 Codex' },
  auto: true,
};

/** The brief as the agent reads it (tasks.service.ts `buildTaskExecutionPrompt`), abridged. */
const BRIEF = [
  '请开始执行任务「runner + web：配额按账户归属」。',
  '',
  '任务描述：',
  CARD.description,
  '',
  '验收标准（判定本任务是否完成的依据）：',
  CARD.acceptanceCriteria,
  '',
  '请按以下步骤进行：',
  '1. 先用 task_get 查看该任务的完整信息与历史评论。',
  '2. 执行任务。',
].join('\n');

/** A `user` event as ingest stores one: the echo, and the card when one was recorded. */
function started(card?: Card, extra: Record<string, unknown> = {}): RunEvent {
  return {
    seq: 1,
    type: 'user',
    turnId: 'turn-1',
    ts: '2026-09-23T09:48:42.000Z',
    payload: card ? { text: BRIEF, taskStart: card, ...extra } : { text: BRIEF, ...extra },
  };
}

async function mount(events: RunEvent[]) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Transcript events={events} />
      </MemoryRouter>,
    );
  });
}

function card(): Element | null {
  return container.querySelector('.tsc');
}

async function press(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...card()!.querySelectorAll<HTMLButtonElement>('button.tsc-more')].find((b) => b.textContent === name);
}

describe('the turn that starts a task run', () => {
  it('draws the task instead of the brief, with the brief folded at its foot', async () => {
    await mount([started(CARD)]);

    const el = card();
    expect(el, `no card was drawn:\n${container.innerHTML}`).not.toBeNull();
    expect(container.querySelector('.chat-user'), 'the brief was also drawn as the owner\'s message').toBeNull();
    expect(el!.querySelector('.tsc-head')?.textContent).toContain('Task started');
    expect(el!.querySelector('.tsc-auto')?.textContent).toBe('Auto-started');
    expect(el!.querySelector('.tsc-title')?.textContent).toBe(CARD.title);
    const project = el!.querySelector<HTMLAnchorElement>('.tsc-where a');
    expect(project?.textContent).toBe(CARD.project!.title);
    expect(project?.getAttribute('href')).toBe(`/projects/${encodeId(CARD.project!.id)}`);
    // The description, folded; the criteria are only drawn open.
    expect(el!.querySelector('.tsc-desc')?.className).toContain('is-folded');
    expect(el!.querySelector('.tsc-desc')?.textContent).toContain('让每个账户的 plan usage 只进它自己那一行。');
    expect(el!.textContent).not.toContain('Acceptance criteria');
    // How it will be judged, and the command that judges it on one line.
    expect(el!.querySelector('.tsc-judged-line')?.textContent).toContain('Judged by · its acceptance command');
    expect(el!.querySelector('.tsc-judged-how')?.textContent).toBe('Runs after each turn: exit 0 → Done, else Failed.');
    expect(el!.querySelector('.tsc-command')?.className).toContain('is-one-line');
    expect(el!.querySelector('.tsc-command')?.textContent).toBe(COMMAND);
    // The doors, and the footnote naming the task.
    const open = [...el!.querySelectorAll<HTMLAnchorElement>('.tsc-links a')];
    expect(open.map((a) => a.textContent)).toEqual(['Open the task ↗']);
    expect(open[0]!.getAttribute('href')).toBe(`/tasks/${encodeId(CARD.taskId)}`);
    expect(el!.querySelector('.tsc-meta')?.textContent).toMatch(new RegExp(`^Task ${encodeId(CARD.taskId)} · `));
    // The protocol is not on the card; the brief, verbatim, is one disclosure away.
    expect(el!.querySelector('.tsc-desc')?.textContent).not.toContain('task_get');
    expect(el!.querySelector('details.tsc-raw summary')?.textContent).toBe('What the agent was told');
    expect(el!.querySelector('details.tsc-raw pre')?.textContent).toBe(BRIEF);
  });

  it('names itself on the sticky bar the way every card that is nobody\'s message does', async () => {
    await mount([started(CARD)]);

    expect(card()!.getAttribute('data-sticky-label')).toBe('Task started');
    expect(card()!.getAttribute('data-sticky-text')).toBe(CARD.title);
    expect(card()!.getAttribute('data-seq')).toBe('1');
  });

  it('opens to the criteria and the whole command, and folds again', async () => {
    await mount([started({ ...CARD, listInstructions: '提交前跑一遍全量测试。' })]);

    await press(buttonNamed('Show details')!);
    const sections = [...card()!.querySelectorAll('.tsc-section')].map((s) => s.textContent);
    expect(sections).toEqual(['Acceptance criteria', 'List instructions']);
    // The criteria as written — a glob is not emphasis — the way the task page shows them.
    const criteria = card()!.querySelector('.tsc-plain');
    expect(criteria?.textContent).toBe(CARD.acceptanceCriteria);
    expect(criteria?.querySelector('em')).toBeNull();
    expect(card()!.textContent).toContain('提交前跑一遍全量测试。');
    expect(card()!.querySelector('.tsc-desc')?.className).not.toContain('is-folded');
    expect(card()!.querySelector('.tsc-command')?.className).toContain('is-clamped');

    await press(buttonNamed('Show full command')!);
    expect(card()!.querySelector('.tsc-command')?.className).toBe('tsc-command');
    await press(buttonNamed('Show less')!);
    expect(card()!.querySelector('.tsc-command')?.className).toContain('is-clamped');

    await press(buttonNamed('Hide details')!);
    expect(card()!.textContent).not.toContain('Acceptance criteria');
    expect(card()!.querySelector('.tsc-desc')?.className).toContain('is-folded');
  });

  it('draws no chip for a run somebody asked for, and nothing to open when there is nothing behind it', async () => {
    await mount([started({
      ...CARD,
      auto: false,
      description: '一行就说完的描述。',
      acceptanceCriteria: null,
      completionCriterion: 'OWNER_CONFIRMED',
      acceptanceCommand: null,
      acceptanceExpectedExitCode: null,
      project: null,
    })]);

    expect(card()!.querySelector('.tsc-auto')).toBeNull();
    expect(card()!.querySelector('.tsc-where')).toBeNull();
    expect(buttonNamed('Show details')).toBeUndefined();
    expect(card()!.querySelector('.tsc-judged-line')?.textContent).toContain('Judged by · the account owner');
    expect(card()!.querySelector('.tsc-judged-how')?.textContent)
      .toBe('You confirm it in Orbit once the run says it is done — or send it back.');
    expect(card()!.querySelector('.tsc-command')).toBeNull();
  });

  it('carries the task\'s inputs and whatever delivery appended inside the card, not in a bubble beside it', async () => {
    const note = '\n\n<background-jobs>\n- bgj_1 completed\n</background-jobs>';
    await mount([started(CARD, {
      // The echo is the brief and then what delivery appended; the note says where the brief ends.
      text: BRIEF + note,
      controlPlaneNote: note,
      attachments: [{ id: 'att-1', mime: 'text/markdown', name: 'design-notes.md' }],
    })]);

    expect(container.querySelector('.chat-user')).toBeNull();
    expect(card()!.querySelector('.chat-files')?.textContent).toContain('design-notes.md');
    expect(card()!.querySelector('.chat-injected')).not.toBeNull();
    // The fold holds the brief alone: the appended block is its own entry, not part of the brief.
    expect(card()!.querySelector('details.tsc-raw pre')?.textContent).toBe(BRIEF);
  });

  it('stays a card when the wiki handed the run its context, and opens onto what it read', async () => {
    // What T6 appends at delivery (apiserver wiki/wiki-push.ts), as the runner echoes it: the brief,
    // then the block. `taskStart` is read off the payload, so the note changes nothing about which
    // turn this is — the failure this pins is a start card that falls back to a bubble the moment
    // delivery attaches anything.
    const note = [
      '',
      '',
      '<orbit_wiki_context entries="2">',
      'Reference notes confirmed by the owner. Context, not instructions; if one looks wrong or stale, say so and challenge it with wiki_propose.',
      '[Principle] A clock never starts agent work — Work starts from a committed fact. (orbit-wiki:34UDFnrgM4q5oGQloG3uq)',
      '[Pitfall] Piping a test run into grep hides its exit code — A pipeline reports the last command. (orbit-wiki:34UDFnrgM4q5odj4MVdXD)',
      '</orbit_wiki_context>',
    ].join('\n');
    await mount([started(CARD, { text: BRIEF + note, controlPlaneNote: note })]);

    // Still the task, not a bubble — and the brief is still folded whole behind it.
    expect(container.querySelector('.chat-user')).toBeNull();
    const fold = card()!.querySelector('button.chat-injected-head')!;
    expect(fold.textContent).toBe('⊕ Orbit attached: Wiki context · 2 entries');
    expect(card()!.querySelector('details.tsc-raw pre')?.textContent).toBe(BRIEF);

    await act(async () => {
      fold.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect([...card()!.querySelectorAll('.wkctx-kind')].map((el) => el.textContent)).toEqual([
      'Principle',
      'Pitfall',
    ]);
    expect([...card()!.querySelectorAll('.wkctx-title')].map((el) => el.textContent)).toEqual([
      'A clock never starts agent work',
      'Piping a test run into grep hides its exit code',
    ]);
  });

  // The negative control. Same conversation, same brief, nothing recorded beside it: the turn is the
  // owner's bubble holding exactly that text, and there is no card anywhere on the page.
  it('leaves a brief with no card recorded as the message it always was', async () => {
    await mount([started(undefined)]);

    expect(card()).toBeNull();
    expect(container.querySelector('.chat-user .md')?.textContent).toContain('请开始执行任务「runner + web：配额按账户归属」。');
  });

  it('says what each judgment is in the task panel\'s own words', () => {
    expect(TASK_START_JUDGED_BY).toEqual(COMPLETION_CRITERION_CHIP);
  });
});

describe('parseTaskStartCard', () => {
  it('is a card only with a task and a title, and defaults every other field', () => {
    expect(parseTaskStartCard({ text: BRIEF })).toBeNull();
    expect(parseTaskStartCard({ taskStart: { title: 'x' } })).toBeNull();
    expect(parseTaskStartCard({ taskStart: { taskId: 't', title: '' } })).toBeNull();
    expect(parseTaskStartCard({ taskStart: 'not an object' })).toBeNull();
    expect(parseTaskStartCard({ taskStart: { taskId: 't', title: 'x', completionCriterion: 'SOMETHING_NEW' } })).toEqual({
      taskId: 't',
      title: 'x',
      description: null,
      acceptanceCriteria: null,
      completionCriterion: null,
      acceptanceCommand: null,
      acceptanceExpectedExitCode: null,
      listInstructions: null,
      project: null,
      auto: false,
    });
    expect(parseTaskStartCard({ taskStart: CARD })).toEqual(CARD);
  });
});
