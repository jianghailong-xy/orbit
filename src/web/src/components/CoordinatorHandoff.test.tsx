// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionCoordinatorHandoff } from '@orbit/shared';
import {
  ContextActions,
  CoordinatorHandoffFailure,
  CoordinatorHandoffProgress,
  handoffNoteSections,
  isCoordinatorHandoffPrompt,
} from './CoordinatorHandoff';
import { Transcript, type RunEvent } from './Transcript';

/** The pieces of boards 01 and 02 the page-level spec (WorkspaceView.coordinatorHandoff) does not reach. */

const noop = () => {};
const handoff = (over: Partial<SessionCoordinatorHandoff>): SessionCoordinatorHandoff => ({
  state: 'WRITING',
  startedAt: new Date().toISOString(),
  failureCode: null,
  failureReason: null,
  handedOverToSessionId: null,
  ...over,
});

const html = (el: JSX.Element) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(el);
  return host;
};

describe('Context popover actions (board 01)', () => {
  it('leads with Compact from 75% while idle, and not below it or while a turn runs', () => {
    const lead = (pct: number, running = false) =>
      html(<ContextActions compact={{ onCompact: noop }} running={running} pct={pct} />).querySelector('.ctx-act')!.classList.contains('lead');
    expect(lead(82)).toBe(true);
    expect(lead(75)).toBe(true);
    expect(lead(74)).toBe(false);
    expect(lead(7)).toBe(false);
    expect(lead(82, true)).toBe(false);
  });

  it('draws nothing where neither action applies', () => {
    expect(html(<ContextActions running={false} pct={50} />).innerHTML).toBe('');
  });
});

describe('handoff rows (board 02)', () => {
  it('says Compacting… while the engine compacts mid-note, the clock still running', () => {
    const row = html(<CoordinatorHandoffProgress handoff={handoff({})} compacting onSkip={noop} onCancel={noop} />);
    expect(row.textContent).toMatch(/^Compacting…0:0\d/);
  });

  it('offers only Hand over without a note when the new coordinator could not be opened', () => {
    const row = html(
      <CoordinatorHandoffFailure
        handoff={handoff({ state: 'FAILED', failureCode: 'REPLACE_FAILED', failureReason: "The handoff note wasn't written: the new coordinator could not be opened." })}
        onRetry={noop}
        onSkip={noop}
        onKeep={noop}
      />,
    );
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Hand over without a note']);
  });
});

describe('the handoff note', () => {
  it('reads the four sections, headings in markdown or inline', () => {
    expect(handoffNoteSections('## Where things stand\n- 4 of 6 done.\n**Agreed with the owner**\n* No merge before Friday.\nWaiting on: Evidence.\nNext\nNothing.')).toEqual([
      { title: 'Where things stand', items: ['4 of 6 done.'] },
      { title: 'Agreed with the owner', items: ['No merge before Friday.'] },
      { title: 'Waiting on', items: ['Evidence.'] },
      { title: 'Next', items: ['Nothing.'] },
    ]);
  });

  it('leaves a note without the sections to be shown as written', () => {
    expect(handoffNoteSections('Everything is done.')).toBeNull();
  });
});

describe('the note turn in the transcript', () => {
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  it('leaves out the platform’s ask for the note, and keeps the note itself', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const prompt = 'From Orbit · handoff note\n\nThe owner is handing this project over to a new coordinator conversation.';
    expect(isCoordinatorHandoffPrompt(prompt)).toBe(true);
    const events: RunEvent[] = [
      { seq: 1, type: 'user', turnId: 't1', ts: '2026-11-14T07:40:00Z', payload: { text: prompt } },
      { seq: 2, type: 'assistant', turnId: 't1', ts: '2026-11-14T07:41:00Z', payload: { text: 'Where things stand\n4 of 6 tasks done.' } },
      { seq: 3, type: 'turn_end', turnId: 't1', ts: '2026-11-14T07:41:00Z', payload: {} },
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<MemoryRouter><Transcript events={events} /></MemoryRouter>);
    });
    expect(host.textContent).not.toContain('From Orbit · handoff note');
    expect(host.textContent).toContain('4 of 6 tasks done.');
  });
});
