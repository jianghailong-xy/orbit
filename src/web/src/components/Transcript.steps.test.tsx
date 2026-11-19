// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVEAL_EVENT, type RunEvent, Transcript } from './Transcript';

/** The steps line in a page: a click opens it onto its cards, and ⌘F opens it to show a hit inside. */

const events: RunEvent[] = [
  { seq: 1, type: 'thinking', payload: { text: 'check the containers first', thinkingMs: 15_000 } },
  { seq: 2, type: 'tool_use', payload: { id: 't1', name: 'Bash', input: { command: 'docker compose ps', description: 'Show container status' } } },
  { seq: 3, type: 'tool_result', payload: { toolUseId: 't1', content: 'apiserver Up' } },
  { seq: 4, type: 'assistant', payload: { text: 'Containers are up.' } },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Transcript events={events} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const line = () => container.querySelector<HTMLElement>('.chat-steps-line')!;
const detail = () => container.querySelector('.chat-steps-detail');

describe('steps line', () => {
  it('opens onto the cards it stands for, and shuts again', () => {
    expect(line().textContent).toBe('Thought for 15s, ran 1 shell command');
    expect(detail()).toBeNull();

    act(() => line().click());
    expect(detail()!.textContent).toContain('Show container status');
    expect(detail()!.querySelector('.chat-think-head')).not.toBeNull();

    act(() => line().click());
    expect(detail()).toBeNull();
  });

  it('opens when asked to reveal what it holds', () => {
    act(() => {
      container.querySelector('.chat-steps')!.dispatchEvent(new Event(REVEAL_EVENT));
    });
    expect(container.querySelector('.chat-steps.is-open')).not.toBeNull();
    expect(detail()!.textContent).toContain('Show container status');
  });
});
