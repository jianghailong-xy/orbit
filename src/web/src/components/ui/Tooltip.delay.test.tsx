// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEXT_TOOLTIP_DELAY_MS, Tooltip } from './Tooltip';
import { hoverTooltip } from '../../test/tooltipHover';

/**
 * A tip on plain text opens only once the pointer rests (TEXT_TOOLTIP_DELAY_MS), so moving across a list opens none;
 * a control's opens at once. A tip written on several lines keeps them (docs/mocks/web-tooltips-b-d, Q1 and Q4).
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
});

const mark = () => container!.querySelector<HTMLElement>('.mark')!;

describe('Tooltip delay', () => {
  it('opens a control’s tip at once, and a text tip only after the pointer rests', async () => {
    await act(async () => root!.render(<Tooltip content="Now"><button type="button" className="mark">Go</button></Tooltip>));
    expect(await hoverTooltip(mark(), 200)).toBe('Now');
  });

  it('keeps a text tip shut for a passing pointer', async () => {
    await act(async () => root!.render(
      <Tooltip content="This session coordinates a project" delay={TEXT_TOOLTIP_DELAY_MS}><span className="mark">Coordinator</span></Tooltip>,
    ));
    expect(await hoverTooltip(mark(), 200)).toBeNull();
    await act(async () => new Promise((resolve) => setTimeout(resolve, TEXT_TOOLTIP_DELAY_MS)));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('This session coordinates a project');
  });

  it('keeps the line breaks of a tip written on several lines', async () => {
    await act(async () => root!.render(
      <Tooltip content={'SMTP 550: mailbox unavailable\nLast attempt Nov 26, 14:02'}><span className="mark">Failed</span></Tooltip>,
    ));
    expect(await hoverTooltip(mark(), 200)).toBe('SMTP 550: mailbox unavailable\nLast attempt Nov 26, 14:02');
  });
});
