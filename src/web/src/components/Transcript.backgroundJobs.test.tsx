// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';
import { EN_RUNNING_AND_ENDED, ZH_KILLED } from '../lib/backgroundJobs.fixtures';

/**
 * The inventory a returning engine is handed, opened as rows.
 *
 * It stays what it has always been — a folded entry under the person's words, because the block is
 * context appended to their message rather than a turn of its own (Transcript.controlPlaneNote
 * covers that). This is about what the fold opens to: the block's `｜`-separated lines ran four
 * lines wide, and its last two sentences are written to the agent, not to the reader.
 */

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

async function mountNote(block: string) {
  const appended = `\n\n${block}`;
  const event: RunEvent = {
    seq: 7,
    type: 'user',
    turnId: 'turn-1',
    ts: '2026-09-17T12:26:47.307Z',
    payload: { text: `继续${appended}`, controlPlaneNote: appended },
  };
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Transcript events={[event]} />
      </MemoryRouter>,
    );
  });
  const toggle = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('⊕ Orbit attached:'),
  );
  if (!toggle) throw new Error(`no folded entry was rendered:\n${container.innerHTML}`);
  await act(async () => {
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return toggle;
}

const rows = () => [...container.querySelectorAll('.bgjobs-job')];

describe('a background-jobs note, opened', () => {
  it('is one row per job, under the section it was listed in, outcome and all', async () => {
    await mountNote(EN_RUNNING_AND_ENDED);

    expect(container.querySelectorAll('.bgjobs-group')).toHaveLength(2);
    expect([...container.querySelectorAll('.bgjobs-group')].map((el) => el.textContent)).toEqual([
      'Still running',
      'Ended while you were away',
    ]);
    expect(rows()).toHaveLength(2);
    // The command is the row, whole enough to tell two runs of the same script apart.
    expect(rows()[0].querySelector('.bgjobs-name')?.textContent).toContain('AFTER_EXIT');
    expect(rows()[1].querySelector('.bgjobs-name')?.textContent).toContain('BASELINE_EXIT');
    // A job still running has no outcome to report; the one that ended reports the exit code.
    expect(rows()[0].querySelector('.bgjobs-outcome')).toBeNull();
    expect(rows()[1].querySelector('.bgjobs-outcome')?.textContent).toBe('exit 0');
    expect(rows()[1].querySelector('.bgjobs-meta')?.textContent).toBe('bgj_e95780ddaf25 · job');
  });

  it('says how a job that was killed came out, in the runner’s own word for it', async () => {
    await mountNote(ZH_KILLED);

    expect(rows()[0].querySelector('.bgjobs-outcome')?.textContent).toBe('killed · drain_cap');
    expect(rows()[0].querySelector('.bgjobs-mark')?.className).toContain('is-failed');
  });

  it('keeps what was written to the agent, and the absolute paths, behind the verbatim fold', async () => {
    await mountNote(EN_RUNNING_AND_ENDED);

    const rowText = rows().map((row) => row.textContent ?? '').join('\n');
    expect(rowText).not.toContain('The control plane recorded this for you');
    expect(rowText).not.toContain('mcp__orbit__bg_output');
    expect(rowText).not.toContain('/root/.orbit/runs/');

    // Not dropped — the fold below the rows holds the block exactly as the agent received it, in a
    // native <details> so a static export can open it too.
    const raw = container.querySelector('details.bgjobs-raw');
    expect(raw?.querySelector('pre')?.textContent).toBe(EN_RUNNING_AND_ENDED);
  });

  it('names its count on the line that stays visible when it is folded again', async () => {
    const toggle = await mountNote(EN_RUNNING_AND_ENDED);

    expect(toggle.textContent).toBe('⊕ Orbit attached: background jobs · 1 running, 1 ended');

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(rows()).toHaveLength(0);
    expect(toggle.textContent).toBe('⊕ Orbit attached: background jobs · 1 running, 1 ended');
  });
});
