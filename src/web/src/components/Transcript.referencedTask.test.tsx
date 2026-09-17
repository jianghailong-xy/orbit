// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';
import {
  EIGHT_TASKS,
  NEVER_RAN,
  ONE_TASK,
  TWO_TASKS,
  WITH_BACKGROUND_JOBS,
} from '../lib/referencedTask.fixtures';

/**
 * The tasks a person named with `#`, opened as cards inside their own bubble.
 *
 * What a reader met before was the block's plain-text table — five labelled lines per task, eight of
 * them in one note — and on it, in the opening tag, the id: the one thing worth clicking, and dead
 * text. Every note here is one this deployment actually sent (lib/referencedTask.fixtures).
 *
 * The reading itself is proved in lib/referencedTask.test.ts; this is about what reaches the page.
 */

const LABEL = '⊕ Orbit attached:';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A `user` event as ingest stores it: the runner's echo, and the note recorded beside it. */
function userEvent(typed: string, note: string): RunEvent {
  const appended = `\n\n${note}`;
  return {
    seq: 7,
    type: 'user',
    turnId: 'turn-1',
    ts: '2026-09-14T01:32:07.000Z',
    payload: { text: `${typed}${appended}`, controlPlaneNote: appended },
  };
}

/** Mounts the turn and opens the folded entry, which is where all of this is drawn. */
async function open(note: string, typed = '这几个任务现在什么状态？') {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Transcript events={[userEvent(typed, note)]} />
      </MemoryRouter>,
    );
  });
  const toggle = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith(LABEL),
  );
  expect(toggle, `no entry signed ${LABEL}:\n${container.innerHTML}`).toBeTruthy();
  await act(async () => {
    toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return toggle!;
}

const cards = () => [...container.querySelectorAll('.reftask-task')];
const text = (el: Element | null | undefined) => el?.textContent ?? '';

describe('a `#`-referenced task in a bubble', () => {
  it('is a card: the status, the title, how the last run came out, and the ids under it', async () => {
    await open(ONE_TASK);

    expect(cards()).toHaveLength(1);
    const [card] = cards();
    expect(text(card.querySelector('.status-pill'))).toBe('Failed');
    expect(text(card.querySelector('.reftask-title'))).toBe('runner 从项目集成线的 tip 创建 worktree');
    // The outcome in the block's own words, the classified cause included.
    expect(text(card.querySelector('.reftask-outcome'))).toBe('FAILED (unattributed), 31 turns');
    expect(text(card.querySelector('.reftask-meta'))).toBe(
      '34OEE9MQXMEm0h0Ptm1GG · (无列表) · orbit · 1 run',
    );
    // The table it replaced is gone, the sentence addressed to the agent with it.
    expect(container.textContent).not.toContain('详情请用 task_get 自取');
    expect(container.querySelector('.chat-injected-body')).toBeNull();
  });

  it('links the title to the task, which is the id the block could only show', async () => {
    await open(ONE_TASK);

    const link = cards()[0].querySelector('a.reftask-title');
    expect(link?.getAttribute('href')).toBe('/tasks/34OEE9MQXMEm0h0Ptm1GG');
  });

  it('names what the status line said after the status, and says a run nobody took in words', async () => {
    await open(TWO_TASKS);

    const [verification, queued] = cards();
    expect(text(verification.querySelector('.reftask-suffix'))).toBe('验收任务');
    expect(text(verification.querySelector('.status-pill'))).toBe('Done');
    // A session that exists and has never taken a turn: the evidence question, on the card.
    expect(text(queued.querySelector('.reftask-meta'))).toContain('1 run, 0 with turns');
  });

  it('says so on the shut line: the state of a lone task, the count of several', async () => {
    const one = await open(ONE_TASK);
    expect(one.textContent).toBe(`${LABEL} referenced task · FAILED`);

    const eight = await open(EIGHT_TASKS);
    expect(eight.textContent).toBe(`${LABEL} referenced task ×8 · 7 DONE, 1 OPEN`);
  });

  it('draws all eight of the most anyone has referenced at once, in the order named', async () => {
    await open(EIGHT_TASKS);

    expect(cards()).toHaveLength(8);
    expect(cards().map((card) => card.querySelector('a')?.getAttribute('href'))).toEqual([
      '/tasks/34ONkD7V6aKjyLdHXyimz',
      '/tasks/34OAsTIS8JuGm5H2j95qO',
      '/tasks/34NcCcju6ItuCcHBoeaqd',
      '/tasks/34NaYaztogra0gaMFo4mY',
      '/tasks/34NaebW9aR15Mr8WrYyV5',
      '/tasks/34Nb44UnFuiGKvXwWfxFY',
      '/tasks/34NJZsv3am8LrTpZ4jc09',
      '/tasks/34DH29mTc7OQ6AwxAFIJu',
    ]);
    // Nothing of the note is left over to draw as text under them.
    expect(container.querySelector('.chat-injected-body')).toBeNull();
  });

  it('says a task nothing has run in this end’s own words, and shows no outcome it does not have', async () => {
    await open(NEVER_RAN);

    expect(text(cards()[0].querySelector('.reftask-meta'))).toBe(
      '349vy0HknpSjHwdwJ31O1 · (无列表) · (未指派) · never run',
    );
    expect(cards()[0].querySelector('.reftask-outcome')).toBeNull();
  });

  it('shares a note with the background-jobs inventory without either swallowing the other', async () => {
    const toggle = await open(WITH_BACKGROUND_JOBS, '复验过了吗？');

    expect(cards()).toHaveLength(1);
    expect(container.querySelectorAll('.bgjobs-job')).toHaveLength(1);
    expect(toggle.textContent).toBe(
      `${LABEL} referenced task, background jobs · DONE · 1 ended, exit 1`,
    );
    // The job's own row is the block's, not a line of the card's.
    expect(text(container.querySelector('.bgjobs-name'))).toContain('run-pg-spec.sh');
    expect(text(cards()[0])).not.toContain('bgj_0c8d57e95552');
    // Both blocks were taken, so there is nothing left to draw as text.
    expect(container.querySelector('.chat-injected-body')).toBeNull();
  });

  it('leaves a block it cannot read as the text it always was, rather than half a card', async () => {
    const reworded = ONE_TASK.replace('  状态   FAILED', '  当前状态   FAILED');

    await open(reworded);

    expect(cards()).toHaveLength(0);
    expect(text(container.querySelector('.chat-injected-body'))).toBe(reworded);
  });
});
