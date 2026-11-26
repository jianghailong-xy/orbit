// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LandingPullRequestView, ProjectIntegrationView, SessionLandingView } from '@orbit/shared';
import views from '../lib/landingBoardServerViews.json';
import { LandingPullRequest, pullRequestCard } from './LandingPullRequest';
import { landingCard } from './ProjectPanoramaHeader';
import { landingAttemptCard } from '../lib/landingSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every state of the board (docs/mocks/protected-branch-landing 02) read from what the real apiserver answered:
 * `landingBoardServerViews.json` was captured from GET /projects/:id/integration and GET /sessions/:id on a stack seeded
 * by the pg spec's case (16) (pull-request-landing.pg.spec.ts), ids in the public base62 spelling the web gets.
 */
const landing = (key: string) => views.landing[key as keyof typeof views.landing] as unknown as SessionLandingView;
const pr = (key: string) => landing(key).pullRequest as LandingPullRequestView;
const integration = (key: string) => views.integration[key as keyof typeof views.integration] as unknown as ProjectIntegrationView;

describe('pullRequestCard, from the server\'s own pull request blocks (board 02)', () => {
  it('a: opened, checks running', () => {
    const m = pullRequestCard(pr('a'), 'main');
    expect([m.stage, m.head, m.right]).toEqual(['OPENED', 'Pull request open', '2 of 6']);
    expect(m.detail).toBe('main requires a pull request. Waiting for the required checks.');
    expect(m.segments).toEqual(['passed', 'passed', 'pending', 'pending', 'pending', 'pending']);
  });
  it('b: waiting for review', () => {
    const m = pullRequestCard(pr('b'), 'main');
    expect([m.stage, m.head, m.right]).toEqual(['WAITING_FOR_REVIEW', 'Waiting for review', '6 of 6 ✓']);
    expect(m.actions[0].label).toBe('Review on GitHub ↗');
  });
  it('a review wait read before any required check was reported counts nothing, and claims no pass', () => {
    const m = pullRequestCard({ ...pr('b'), checks: { passed: 0, required: 0, failed: [] } }, 'main');
    expect([m.head, m.right, m.detail]).toEqual(['Waiting for review', null, 'main requires an approving review.']);
    expect(m.segments).toEqual([]);
  });
  it('c: a required check failed, with the log link and GitHub\'s check name', () => {
    const m = pullRequestCard(pr('c'), 'main');
    expect(m.head).toBe('Check failed: PostgreSQL specs');
    expect(m.segments.at(-1)).toBe('failed');
    expect(m.actions.map((a) => a.label)).toEqual(['View log ↗', 'View on GitHub ↗']);
  });
  it('d: main moved', () => {
    expect(pullRequestCard(pr('d'), 'main').head).toBe('Catching up with main');
  });
  it('e: merged', () => {
    const m = pullRequestCard(pr('e'), 'main');
    expect(m.head).toMatch(/^Landed by pull request #\d+$/);
    expect(m.detail).toMatch(/^Merged into main · [0-9a-f]{7}$/);
  });
  it('f: Push as me refused, fell back to a pull request', () => {
    const m = pullRequestCard(pr('f'), 'main');
    expect([m.head, m.right]).toEqual(['Opened a pull request instead', 'Push refused']);
    expect(m.detail).toContain('Changes must be made through a pull request.');
    expect(m.actions.at(-1)?.href).toBe(`/settings/workspaces/${pr('f').workspaceId}#landing`);
  });
  it('closed on GitHub', () => {
    expect(pullRequestCard(pr('closed'), 'main').head).toBe('Pull request closed');
  });
  it('the server names the pull request\'s workspace in the public spelling', () => {
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'closed']) expect(pr(key).workspaceId).toMatch(/^[0-9A-Za-z]{20,24}$/);
  });
});

describe('the cards read the same block', () => {
  it('the project landing card carries the in-flight pull request (a, b, d, f)', () => {
    for (const key of ['a', 'b', 'd', 'f']) {
      const card = landingCard(integration(key), Date.now());
      expect(card?.pullRequest?.number, key).toBe(pr(key).number);
      expect(card?.state, key).toBe('waiting for GitHub');
    }
  });
  it('an attempt held on its pull request is not drawn as a stopped one', () => {
    const attempt = landing('b').currentAttempt!;
    const card = landingAttemptCard(landing('b'), Date.now(), {}, { stepStartedAt: null, typicalMs: null, main: 'main' });
    expect(attempt.state).toBe('PULL_REQUEST');
    expect(card.failure).toBeNull();
    expect(card.state).toBe('Waiting for GitHub');
  });
  it('a failed GitHub check is labelled with its name on the landing card', () => {
    const card = landingAttemptCard(landing('c'), Date.now(), {}, { stepStartedAt: null, typicalMs: null, main: 'main' });
    expect(card.failure).toContain('Check failed: PostgreSQL specs');
  });
});

describe('the Faster tip (owner 2026-11-23)', () => {
  beforeEach(() => window.localStorage.clear());
  const draw = (pullRequest: LandingPullRequestView, workspaces: Array<{ id: string; landingMode?: string | null }> = []) => {
    const host = document.createElement('div');
    document.body.append(host);
    const client = new QueryClient();
    client.setQueryData(['workspaces'], workspaces);
    act(() => createRoot(host).render(
      <QueryClientProvider client={client}><MemoryRouter><LandingPullRequest pullRequest={pullRequest} /></MemoryRouter></QueryClientProvider>));
    return host;
  };
  it('shows while waiting for review, linking to that workspace\'s Landing section', () => {
    const host = draw(pr('b'), [{ id: pr('b').workspaceId!, landingMode: null }]);
    expect(host.querySelector('[data-landing-tip="faster"]')?.textContent).toContain('Faster next time');
    expect(host.querySelector('.landing-pr-tip a')?.getAttribute('href')).toBe(`/settings/workspaces/${pr('b').workspaceId}#landing`);
  });
  it('is hidden when the workspace is on Push as me, and in the other states', () => {
    expect(draw(pr('b'), [{ id: pr('b').workspaceId!, landingMode: 'PUSH_AS_ME' }]).querySelector('[data-landing-tip]')).toBeNull();
    expect(draw(pr('a')).querySelector('[data-landing-tip]')).toBeNull();
  });
  it('is dismissed for good', () => {
    const host = draw(pr('b'));
    act(() => host.querySelector<HTMLButtonElement>('.landing-pr-tip button')!.click());
    expect(host.querySelector('[data-landing-tip]')).toBeNull();
    expect(draw(pr('b')).querySelector('[data-landing-tip]')).toBeNull();
  });
});
