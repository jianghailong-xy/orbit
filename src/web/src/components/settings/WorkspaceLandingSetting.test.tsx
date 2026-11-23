// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceLandingView } from '@orbit/shared';
import { WorkspaceLandingSetting } from './WorkspaceLandingSetting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const draw = (landing: WorkspaceLandingView, onChoose = vi.fn()) => {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(<WorkspaceLandingSetting landing={landing} repo="acme/api" onChoose={onChoose} />));
  return host;
};
const ok: WorkspaceLandingView = { mode: 'PULL_REQUEST', pushAsMe: { available: true }, lastRefusal: null };

describe('WorkspaceLandingSetting', () => {
  it('shows both choices with Default and Faster, and the right-to-push copy', () => {
    const text = draw(ok).textContent!;
    expect(text).toContain('Pull request');
    expect(text).toContain('Default');
    expect(text).toContain('Faster');
    expect(text).toContain('Needs the right to push to main.');
    expect(text).toContain("a landing doesn't wait for a pull request");
  });
  it('chooses Push as me', () => {
    const onChoose = vi.fn();
    const host = draw(ok, onChoose);
    act(() => host.querySelector<HTMLInputElement>('input[value="PUSH_AS_ME"]')!.click());
    expect(onChoose).toHaveBeenCalledWith('PUSH_AS_ME');
  });
  it('disables Push as me and offers to connect when GitHub is not connected', () => {
    const host = draw({ ...ok, pushAsMe: { available: false, reason: 'GITHUB_NOT_CONNECTED' } });
    expect(host.querySelector<HTMLInputElement>('input[value="PUSH_AS_ME"]')!.disabled).toBe(true);
    expect(host.textContent).toContain('Connect GitHub to push as yourself.');
  });
  it('says why after a refusal', () => {
    const host = draw({ mode: 'PUSH_AS_ME', pushAsMe: { available: true },
      lastRefusal: { at: '2026-11-24T00:00:00Z', branch: 'main', message: 'Changes must be made through a pull request.' } });
    expect(host.querySelector('[data-landing-state="refused"]')?.textContent)
      .toContain('GitHub refused your last push to main on acme/api');
  });
  it('a workspace not cloned from GitHub has no choice', () => {
    const host = draw({ mode: null, pushAsMe: { available: false, reason: 'WORKSPACE_NOT_FROM_GITHUB' }, lastRefusal: null });
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain("Landings push with this machine's Git credential.");
  });
});
