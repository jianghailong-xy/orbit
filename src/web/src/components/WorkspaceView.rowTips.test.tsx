// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinatorBadge, SESSION_GUESTS_TIP, SessionTitleRow } from './WorkspaceView';
import { hoverTooltip } from '../test/tooltipHover';

/** The tips of a session row's marks, on the app Tooltip (docs/mocks/web-tooltips-b-d, group D). */

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

describe('session row tips', () => {
  it('says what the Coordinator badge means', async () => {
    await act(async () => root!.render(<CoordinatorBadge projectId="project-1" />));
    expect(await hoverTooltip(container!.querySelector('.coordinator-badge')!)).toBe('This session coordinates a project');
  });

  it('says what the guests mark means', async () => {
    await act(async () => root!.render(<SessionTitleRow session={{ title: 'Retry budget', hasGuests: true }} />));
    expect(await hoverTooltip(container!.querySelector('.session-guests')!)).toBe(SESSION_GUESTS_TIP);
  });
});
