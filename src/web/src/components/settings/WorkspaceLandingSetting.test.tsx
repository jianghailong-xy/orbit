// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceLandingView } from '@orbit/shared';
import views from '../../lib/landingBoardServerViews.json';
import { WorkspaceLandingSetting } from './WorkspaceLandingSetting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The `landing` block of GET /workspaces/:id, as the real apiserver answered it for each workspace the board draws. */
const server = (key: keyof typeof views.workspaceLanding) => views.workspaceLanding[key] as unknown as WorkspaceLandingView;
const draw = (landing: WorkspaceLandingView, onChoose = vi.fn()) => {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(<WorkspaceLandingSetting landing={landing} repo="acme/api" onChoose={onChoose} />));
  return host;
};

describe('WorkspaceLandingSetting, on the server\'s own landing blocks', () => {
  it('shows both choices with Default and Faster, and the right-to-push copy', () => {
    const text = draw(server('pullRequest')).textContent!;
    expect(text).toContain('Pull request');
    expect(text).toContain('Default');
    expect(text).toContain('Faster');
    expect(text).toContain('Needs the right to push to main.');
    expect(text).toContain("a landing doesn't wait for a pull request");
  });
  it('Pull request is selected by default and Push as me when chosen', () => {
    expect(draw(server('pullRequest')).querySelector<HTMLInputElement>('input[value="PULL_REQUEST"]')!.checked).toBe(true);
    expect(draw(server('pushAsMe')).querySelector<HTMLInputElement>('input[value="PUSH_AS_ME"]')!.checked).toBe(true);
  });
  it('chooses Push as me', () => {
    const onChoose = vi.fn();
    const host = draw(server('pullRequest'), onChoose);
    act(() => host.querySelector<HTMLInputElement>('input[value="PUSH_AS_ME"]')!.click());
    expect(onChoose).toHaveBeenCalledWith('PUSH_AS_ME');
  });
  it('disables Push as me and offers to connect when GitHub is not connected', () => {
    const host = draw(server('notConnected'));
    expect(host.querySelector<HTMLInputElement>('input[value="PUSH_AS_ME"]')!.disabled).toBe(true);
    expect(host.textContent).toContain('Connect GitHub to push as yourself.');
  });
  it('says why after a refusal', () => {
    const text = draw(server('refused')).querySelector('[data-landing-state="refused"]')!.textContent!;
    expect(text).toContain('GitHub refused your last push to main on acme/api');
    expect(text).toContain('Changes must be made through a pull request.');
  });
  it('a workspace not cloned from GitHub has no choice', () => {
    const host = draw(server('notFromGithub'));
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain("Landings push with this machine's Git credential.");
  });
  it('says when the installation has not accepted the new permissions, with the review link', () => {
    const host = draw(server('permissionsPending'));
    const notice = host.querySelector('[data-landing-state="permissions-pending"]')!;
    expect(notice.textContent).toContain("Landing through pull requests starts once owner accepts Orbit's updated GitHub permissions.");
    expect(notice.querySelector('a')?.getAttribute('href')).toMatch(/^https:\/\/github\.com\/settings\/installations\/\d+$/);
    expect(draw(server('pullRequest')).querySelector('[data-landing-state="permissions-pending"]')).toBeNull();
  });
});
