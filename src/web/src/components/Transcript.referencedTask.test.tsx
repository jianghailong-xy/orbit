// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';
import {
  EIGHT_TASKS,
  IN_ENGLISH,
  NEVER_RAN,
  ONE_TASK,
  TWO_TASKS,
  WITH_BACKGROUND_JOBS,
} from '../lib/referencedTask.fixtures';

const CONDITIONS = '<list-conditions list="3Hq9fVbYmP2kQhZ8aNcW4x" title="FineWeb">\n  Quota held dispatch\n</list-conditions>';

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

describe('a referenced task note', () => {
  it.each([
    ['one task', ONE_TASK], ['two tasks', TWO_TASKS], ['eight tasks', EIGHT_TASKS],
    ['a task never run', NEVER_RAN], ['tasks and background jobs', WITH_BACKGROUND_JOBS],
    ['English notes', IN_ENGLISH],
  ])('omits %s and the condition board appended beside it', async (_kind, note) => {
    const typed = 'What state are these tasks in?';
    await act(async () => root.render(
      <MemoryRouter><Transcript events={[userEvent(typed, `${note}\n\n${CONDITIONS}`)]} /></MemoryRouter>,
    ));
    expect(container.querySelector('.chat-user')?.textContent?.trim()).toBe(typed);
    expect(container.textContent).not.toContain('Orbit attached');
    expect(container.textContent).not.toContain('Quota held dispatch');
    expect(container.textContent).not.toContain('referenced-task');
    expect(container.querySelector('.reftask')).toBeNull();
    expect(container.querySelector('[class*="chat-injected"]')).toBeNull();
  });

  it('keeps the task link in the words the person typed', async () => {
    const typed = '[Check the runner](orbit-task:34OEE9MQXMEm0h0Ptm1GG) — what is its state?';
    await act(async () => root.render(
      <MemoryRouter><Transcript events={[userEvent(typed, ONE_TASK)]} /></MemoryRouter>,
    ));
    expect(container.querySelector('.chat-user a')?.getAttribute('href')).toBe('/tasks/34OEE9MQXMEm0h0Ptm1GG');
    expect(container.textContent).not.toContain('Orbit attached');
    expect(container.textContent).not.toContain('referenced-task');
  });
});
