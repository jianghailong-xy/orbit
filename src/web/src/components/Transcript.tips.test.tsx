// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';
import { hoverTooltip } from '../test/tooltipHover';

/** What a conversation's rows say on hover, beyond the words they draw. */

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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function tipOn(events: RunEvent[], selector: string): Promise<string | null> {
  await act(async () => root.render(<MemoryRouter><Transcript events={events} /></MemoryRouter>));
  return hoverTooltip(container.querySelector(selector)!);
}

describe('a conversation row’s tooltip', () => {
  it('gives the reason a message was not delivered', async () => {
    const tip = await tipOn([
      { seq: 1, type: 'user', turnId: 't1', payload: { text: 'rename the widget', delivery: 'enqueued' } },
      { seq: 2, type: 'user_delivery', payload: { turnId: 't1', delivery: 'failed', reason: 'claude stdin is closed', retryable: true } },
    ], '.chat-undelivered');
    expect(tip).toBe('claude stdin is closed');
  });

  it('keeps an engine log line’s preamble', async () => {
    const line = '2026-08-12T15:31:40.112363Z ERROR codex_core::util: Custom tool call output is missing';
    expect(await tipOn([{ seq: 1, type: 'system', payload: { stderr: `${line}\n` } }], '.chat-error')).toBe(line);
  });
});
