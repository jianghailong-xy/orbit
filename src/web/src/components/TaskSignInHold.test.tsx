// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSignInWait, TaskSignInHold } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { heldReason, signInHref, TaskSignInHoldNote } from './TaskSignInHold';
import { SignInWaitRowView } from './ProjectProgressStatus';

/**
 * A task the auto-run sweep holds because Claude Code is signed out on its runner: the row says Held,
 * why, and offers Sign in into the machine's sign-in; the project's Needs you says how many wait.
 */

const RUNNER = '0195f3a0-1111-7aaa-8bbb-000000000001';
const HOLD: TaskSignInHold = {
  kind: 'ENGINE_SIGNED_OUT',
  engine: 'claude',
  engineLabel: 'Claude Code',
  runnerId: RUNNER,
  runnerName: 'longdeMac-mini.local',
};

const inRouter = (node: JSX.Element) => <MemoryRouter>{node}</MemoryRouter>;

describe('TaskSignInHoldNote', () => {
  it('draws the Held pill, the reason and Sign in into the machine’s sign-in for that engine', () => {
    const html = renderToStaticMarkup(inRouter(<TaskSignInHoldNote hold={HOLD} />));
    expect(heldReason(HOLD)).toBe('Held: Claude Code is signed out on longdeMac-mini.local');
    expect(html).toContain('>Held</span>');
    expect(html).toContain('Held: Claude Code is signed out on longdeMac-mini.local');
    expect(signInHref(HOLD)).toBe(`/settings/machines/${encodeId(RUNNER)}?engine=claude`);
    expect(html).toContain(`href="/settings/machines/${encodeId(RUNNER)}?engine=claude"`);
    expect(html).toContain('>Sign in</a>');
  });

  it('keeps a press on Sign in from opening the row it sits in', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const rowClick = vi.fn();
    const root = createRoot(host);
    act(() => {
      root.render(
        inRouter(
          <div onClick={rowClick}>
            <TaskSignInHoldNote hold={HOLD} />
          </div>,
        ),
      );
    });
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Sign in')!;
    act(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(rowClick).not.toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
  });
});

describe('SignInWaitRowView', () => {
  it('draws one Needs you row per runner and engine with its count and Sign in', () => {
    const wait: ProjectSignInWait = {
      engine: 'claude',
      engineLabel: 'Claude Code',
      runnerId: RUNNER,
      runnerName: 'longdeMac-mini.local',
      taskIds: ['a', 'b'],
      title: '2 tasks wait for a sign-in',
      detailLine: 'Claude Code is signed out on longdeMac-mini.local',
    };
    const html = renderToStaticMarkup(inRouter(<SignInWaitRowView wait={wait} />));
    expect(html).toContain('data-kind="SIGN_IN_WAIT"');
    expect(html).toContain('2 tasks wait for a sign-in');
    expect(html).toContain('Claude Code is signed out on longdeMac-mini.local');
    expect(html).toContain(`href="/settings/machines/${encodeId(RUNNER)}?engine=claude"`);
    expect(html).toContain('>Sign in</a>');
  });
});
