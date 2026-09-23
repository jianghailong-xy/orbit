// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectStartedCard as Started } from '@orbit/shared';
import { acceptedUserTurnEvent } from '../lib/acceptedUserTurn';
import { Transcript, type RunEvent } from './Transcript';
import { queuedTurnFromActiveSnapshot } from './WorkspaceView';

/**
 * The message telling a coordinator its project was started is drawn from the payload the control
 * plane recorded beside the turn — NOT from the words the coordinator was sent.
 *
 * The words are for the agent (tool names, ids, `autoRunWhenReady`) and fill a phone screen as a
 * bubble the reader seems to have typed. What holds this in place is the pair, as for the exception
 * item's card: with the payload the card is drawn and the words fold behind it; without one — the
 * same words, the same session — the turn is the bubble it always was.
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

/** What project-started.ts sends, abridged — it is the agent's reading, not this file's subject. */
const TOLD = [
  'From Orbit · project started',
  '',
  'The account owner confirmed the 8 acceptance criteria of project “Codex 多账户：一台机器上登录多个 Codex” '
    + '(34Tcl0kralZrY8opuLJU4) and started it at 2026-09-23T05:06:07.072Z.',
  '',
  '8 of its open tasks are set to be started by hand (autoRunWhenReady=false), so nothing starts them '
    + 'unless you do:',
  '- runner：Codex 账户槽（解析、创建、列举） (34TcwNENwb4zkIbdpLF5S)',
].join('\n');

const TITLES = [
  'runner：Codex 账户槽（解析、创建、列举）',
  'runner + apiserver：登录中继按槽落地',
  'runner / shared / web：按账户上报状态，页面每账户一行',
  'runner + web：配额按账户归属',
  'web：单账户零回归守卫',
  'web：同一个账户被签进两个槽时说得出来',
  'apiserver + web + runner：工作区选账户，派活注入 CODEX_HOME',
  'apiserver：签入预检按这次会话真正要用的槽判断',
];

const CARD: Started = {
  by: 'CONFIRMATION',
  projectId: '01a0cca0-aeaa-7618-bd5a-caccc089108c',
  projectTitle: 'Codex 多账户：一台机器上登录多个 Codex',
  criteriaCount: 8,
  held: TITLES.map((title, index) => ({
    id: `01a0cca7-84ec-75cf-9b65-b94a4ce3bf7${index}`,
    title,
  })),
  heldCount: 8,
};

/** A `user` event as ingest stores one: the echo, and the payload when there was one. */
function told(card?: unknown, text = TOLD): RunEvent {
  return {
    seq: 7,
    type: 'user',
    turnId: 'turn-started',
    ts: '2026-09-23T05:06:08.000Z',
    payload: card ? { text, projectStarted: card } : { text },
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

const card = (): Element | null => container.querySelector('.psc');
const listed = (): string[] =>
  [...card()!.querySelectorAll('.psc-tasks li')].map((li) => li.textContent ?? '');

describe('a project start told to the coordinator', () => {
  it('draws the start as a card: how, which project, and the tasks that wait on the coordinator', async () => {
    await mount([told(CARD)]);

    const el = card();
    expect(el, `no card was drawn:\n${container.innerHTML}`).not.toBeNull();
    expect(el!.querySelector('.psc-head')?.textContent).toContain('Project started');
    expect(el!.querySelector('.psc-kind')?.textContent).toBe('Criteria confirmed');
    expect(el!.querySelector('.psc-title')?.textContent).toBe(CARD.projectTitle);
    expect(el!.querySelector('.psc-lead')?.textContent)
      .toBe('8 tasks are set to start by hand, so they wait for the coordinator:');
    // Three of them, each a way into its task.
    expect(listed()).toEqual(TITLES.slice(0, 3));
    const hrefs = [...el!.querySelectorAll('.psc-tasks a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toHaveLength(3);
    expect(hrefs.every((href) => href?.startsWith('/tasks/'))).toBe(true);
    expect(el!.querySelector('.psc-meta')?.textContent)
      .toContain('Started by you, confirming 8 criteria · a notification, not an interruption');
    // The words the agent read are one disclosure away, verbatim — and not a bubble in the reader's name.
    expect(el!.querySelector('details.psc-raw summary')?.textContent).toBe('What the coordinator was told');
    expect(el!.querySelector('details.psc-raw pre')?.textContent).toBe(TOLD);
    expect(container.querySelector('.chat-user')).toBeNull();
    // What the sticky bar at the top names this turn by.
    expect(el!.getAttribute('data-sticky-label')).toBe('Project started');
    expect(el!.getAttribute('data-sticky-text')).toBe(CARD.projectTitle);
  });

  // The negative control: the same conversation and the same words, with nothing recorded beside them.
  it('leaves a message with no payload as the bubble it always was', async () => {
    await mount([told(undefined)]);
    expect(card()).toBeNull();
    expect(container.querySelector('.chat-user .md')?.textContent).toContain('From Orbit · project started');
  });

  it('draws a payload that is not a card as the bubble too, never as half a card', async () => {
    for (const bad of [
      { ...CARD, by: 'SOMETHING_ELSE' },
      { ...CARD, projectId: '' },
      { ...CARD, projectTitle: 42 },
      'project started',
    ]) {
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      await mount([told(bad)]);
      expect(card(), `drew a card from ${JSON.stringify(bad)}`).toBeNull();
      expect(container.querySelector('.chat-user')).not.toBeNull();
    }
  });

  it('names the Automatic switch as its own kind of start, confirming nothing', async () => {
    await mount([told({ ...CARD, by: 'SWITCH', criteriaCount: null })]);
    const el = card()!;
    expect(el.querySelector('.psc-head')?.textContent).toContain('Project switched on');
    expect(el.querySelector('.psc-kind')?.textContent).toBe('Automatic on');
    expect(el.querySelector('.psc-meta')?.textContent).toContain('Switched on by you');
    expect(el.querySelector('.psc-meta')?.textContent).not.toContain('confirming');
    expect(el.getAttribute('data-sticky-label')).toBe('Project switched on');
  });

  it('says so in one line when no task waits on the coordinator', async () => {
    await mount([told({ ...CARD, held: [], heldCount: 0 })]);
    expect(card()!.querySelector('.psc-lead')?.textContent).toBe('Every open task starts on its own.');
    expect(card()!.querySelector('.psc-tasks')).toBeNull();
    expect(card()!.querySelector('.psc-more')).toBeNull();
  });

  it('speaks of one waiting task in the singular', async () => {
    await mount([told({ ...CARD, held: CARD.held.slice(0, 1), heldCount: 1, criteriaCount: 1 })]);
    expect(card()!.querySelector('.psc-lead')?.textContent)
      .toBe('1 task is set to start by hand, so it waits for the coordinator:');
    expect(card()!.querySelector('.psc-meta')?.textContent).toContain('confirming 1 criterion ·');
  });

  it('folds the list past three, unfolds it, and points at the project for what it did not list', async () => {
    // Twenty-three wait; the message listed eight of them.
    await mount([told({ ...CARD, heldCount: 23 })]);

    const toggle = card()!.querySelector<HTMLButtonElement>('.psc-more')!;
    expect(toggle.textContent).toBe('Show 5 more');
    expect(card()!.querySelector('.psc-unlisted')).toBeNull();

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(listed()).toEqual(TITLES);
    expect(card()!.querySelector('.psc-more')?.textContent).toBe('Show fewer');
    const unlisted = card()!.querySelector('.psc-unlisted a');
    expect(unlisted?.textContent).toBe('15 more in the project ↗');
    expect(unlisted?.getAttribute('href')).toMatch(/^\/projects\//);
  });

  it('is drawn the same while it waits on the queue as once a runner echoes it', () => {
    // The queue's head is drawn from the accepted-turn placeholder, and the tail from the queue
    // snapshot: both must carry the card, or the message reads as a bubble until the echo lands.
    const placeholder = acceptedUserTurnEvent({
      key: 'k',
      source: 'activeSnapshot',
      turnId: 'turn-started',
      text: TOLD,
      acceptedAt: '2026-09-23T05:06:08.000Z',
      attachments: [],
      projectStarted: CARD,
    } as Parameters<typeof acceptedUserTurnEvent>[0], 9);
    expect((placeholder.payload as { projectStarted?: unknown }).projectStarted).toEqual(CARD);

    const queued = queuedTurnFromActiveSnapshot({
      turnId: 'turn-started',
      kind: 'message',
      content: TOLD,
      placement: 'queued',
      createdAt: '2026-09-23T05:06:08.000Z',
      projectStarted: CARD,
    } as Parameters<typeof queuedTurnFromActiveSnapshot>[0]);
    expect(queued?.projectStarted).toEqual(CARD);
  });
});
