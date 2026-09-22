// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenItemDeliveryCard as Delivery } from '@orbit/shared';
import { Transcript, type RunEvent } from './Transcript';

/**
 * An exception item's delivery is drawn from the payload the control plane recorded beside the
 * turn's echo — NOT from the paragraph the coordinator was sent.
 *
 * The paragraph is written for the agent and is 30 lines long; drawn as a message it reads as
 * something the reader typed, and everything it says about the item (which files conflicted, which
 * check disagreed, whether the work has landed) is prose. The card is the same reading as fields.
 *
 * What holds this in place is the pair. With the payload the card is drawn and the paragraph is
 * folded behind it; without one the turn is exactly what it was before any of this existed — the
 * person's own bubble, holding the text — because the delivery that carries no card must never be
 * half-invented from the words. That is the negative control: the same text, the same session, the
 * only difference being what the apiserver happened to record.
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

/** The paragraph a delivery really carries (project-open-item.ts `openItemMessage`), Chinese
 *  because the agent reads it, with the three doors and the item's id in it. */
const TOLD = [
  '【例外待办】Merge conflict: 回填历史 user 事件的 controlPlaneNote',
  '',
  '项目 34ODoUKJGEsfbgcJDGS4q 的一次集成没有把工作放进集成线：',
  '合并冲突（LAND_TASK），目标分支 refs/heads/project/34ODoUKJGEsfbgcJDGS4q 没有动。',
  '冲突的文件（4 个）：',
  '- src/web/src/components/Transcript.tsx',
  '',
  '这条待办的负责人是你。平台不会自己重试一次没有落地的集成，所以不会有第二次作业自己出现；',
  '要判断的是下一步。先读这条任务（task_get，taskId 传 34SfQ6TdVFeGdcFpEQJyQ，评论与它的会话'
    + '都在上面），再决定是重新跑（task_start）、另起一个取代它的任务（task_create 带 '
    + 'supersedesTaskId），还是取消（task_update 置 CANCELLED）。',
  '',
  '待办编号 34SfQ6TdVFeGdcFpEQJyQ。这是一条通知，不是打断：你正在跑的那一轮不会被它中断，'
    + '你是在那一轮结束之后才读到它的，所以以你自己刚读到的库里状态为准。',
].join('\n');

const CARD: Delivery = {
  itemId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d',
  kind: 'INTEGRATION_CONFLICT',
  title: 'Merge conflict: 回填历史 user 事件的 controlPlaneNote',
  task: {
    id: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e',
    title: '回填历史 user 事件的 controlPlaneNote',
    sessionId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f',
  },
  files: [
    'src/web/src/components/Transcript.tsx',
    'src/apiserver/src/projects/coordinator-delivery.service.ts',
    'src/web/src/lib/deliveredMessage.ts',
    'docs/project-integration-line-contract.md',
    'src/web/src/index.css',
  ],
  targetRef: 'refs/heads/project/34ODoUKJGEsfbgcJDGS4q',
  check: null,
  errorCode: null,
  failure: null,
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  landing: { receipts: 0, state: 'NOT_KNOWN', upstream: 'main', integration: 'main' },
};

/** A `user` event as ingest stores one: the echo, and the payload when there was one. */
function delivered(card?: Delivery, text = TOLD): RunEvent {
  return {
    seq: 4,
    type: 'user',
    turnId: 'turn-1',
    ts: '2026-09-21T12:26:47.307Z',
    payload: card ? { text, openItemDelivery: card } : { text },
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
  return container.querySelector('.oic');
}

describe('an exception item delivered to the coordinator', () => {
  it('draws the item as a card: its kind, its title and the files it conflicted on', async () => {
    await mount([delivered(CARD)]);

    const el = card();
    expect(el, `no card was drawn:\n${container.innerHTML}`).not.toBeNull();
    // The kind, named the way the rest of the product names it, and the item's own title.
    expect(el!.querySelector('.oic-kind')?.textContent).toBe('Merge conflict');
    expect(el!.querySelector('.oic-title')?.textContent).toBe(CARD.title);
    // Every file, up to the fold.
    const files = [...el!.querySelectorAll('.oic-files li')].map((li) => li.textContent);
    expect(files).toEqual(CARD.files.slice(0, 3));
    // The change that made this worth a card: the platform's own reading of the landing, which
    // otherwise costs the coordinator a re-check of the merge receipts every time.
    expect(el!.querySelector('.oic-facts')?.textContent).toContain('No merge receipt');
    // The doors are the server's list, and the ones a reader can walk are links.
    const chips = [...el!.querySelectorAll('.oic-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Retry the task', 'Cancel the task']);
    const links = [...el!.querySelectorAll('.oic-links a')].map((a) => a.textContent);
    expect(links).toEqual(['Open the task ↗', 'Open the failed session ↗']);
    // The paragraph the agent read is still one disclosure away, verbatim.
    expect(el!.querySelector('details.oic-raw pre')?.textContent).toBe(TOLD);
  });

  /**
   * The pair the sticky bar at the top of the transcript reads off the card's root — and the guard
   * that keeps a title already carrying its kind from being prefixed with it again. A failed task's
   * title is built as `Task failed: <task>` while its kind label is `Task failed` too, so the bar
   * read "Task failed: Task failed: [WARC]…" (the account owner's screenshot, 2026-09-22).
   * `OpenItemDeliveryCard.stickyText` is the same rule on the native end.
   */
  it('stamps the kind once: a title that already says it is not prefixed again', async () => {
    await mount([delivered({ ...CARD, kind: 'TASK_FAILED',
                             title: 'Task failed: 回填历史 user 事件的 controlPlaneNote' })]);
    expect(card()!.getAttribute('data-sticky-label')).toBe('Exception item');
    expect(card()!.getAttribute('data-sticky-text'))
      .toBe('Task failed: 回填历史 user 事件的 controlPlaneNote');

    // And a title that does NOT say it still gets the kind, so the line names what this is.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await mount([delivered({ ...CARD, kind: 'TASK_FAILED', title: '[WARC] 000_00022 的 WARC 依赖' })]);
    expect(card()!.getAttribute('data-sticky-text')).toBe('Task failed: [WARC] 000_00022 的 WARC 依赖');
  });

  it('folds the file list past three, and unfolds it again', async () => {
    await mount([delivered(CARD)]);

    const toggle = card()!.querySelector<HTMLButtonElement>('.oic-more')!;
    expect(toggle.textContent).toBe('Show 2 more files');
    expect(card()!.querySelector('.oic-files')?.textContent).not.toContain(CARD.files[4]);

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const files = [...card()!.querySelectorAll('.oic-files li')].map((li) => li.textContent);
    expect(files).toEqual(CARD.files);
    expect(card()!.querySelector('.oic-more')?.textContent).toBe('Show fewer files');
  });

  it('says the work is already on main when a merge receipt records it', async () => {
    await mount([delivered({
      ...CARD,
      landing: { receipts: 1, state: 'ON_UPSTREAM', upstream: 'main', integration: 'main' },
    })]);

    const facts = card()!.querySelector('.oic-facts')!;
    expect(facts.className).toContain('is-landed');
    expect(facts.textContent).toContain('Already on main');
    expect(facts.textContent).toContain('a merge receipt records this work there');
  });

  // The negative control. Same conversation, same words, nothing recorded beside them: the turn is
  // the person's own bubble holding exactly that text, and there is no card anywhere on the page —
  // a delivery nobody recorded a card for is not guessed at from what it happens to say.
  it('leaves a delivery with no payload as the message it always was', async () => {
    await mount([delivered(undefined)]);

    expect(card()).toBeNull();
    expect(container.querySelector('.chat-user .md')?.textContent).toContain('【例外待办】');
    expect(container.textContent).toContain('待办编号');
  });
});
