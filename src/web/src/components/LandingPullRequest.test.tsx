// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { LandingPullRequestView } from '@orbit/shared';
import { LandingPullRequest, pullRequestCard } from './LandingPullRequest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pr = (over: Partial<LandingPullRequestView>): LandingPullRequestView => ({
  number: 214, url: 'https://github.com/acme/api/pull/214', state: 'OPEN', condition: 'CHECKS_PENDING',
  checks: { passed: 2, required: 6, failed: [] }, mergeMethod: null, mergedSha: null, refusal: null, ...over,
});

describe('pullRequestCard (board 02 states)', () => {
  it('a: opened, checks running', () => {
    const m = pullRequestCard(pr({}), 'main');
    expect([m.stage, m.head, m.right]).toEqual(['OPENED', 'Pull request open', '2 of 6']);
    expect(m.detail).toBe('main requires a pull request. Waiting for the required checks.');
  });
  it('b: waiting for review', () => {
    const m = pullRequestCard(pr({ condition: 'REVIEW_REQUIRED', checks: { passed: 6, required: 6, failed: [] } }), 'main');
    expect([m.stage, m.head, m.right]).toEqual(['WAITING_FOR_REVIEW', 'Waiting for review', '6 of 6 ✓']);
    expect(m.actions[0].label).toBe('Review on GitHub ↗');
  });
  it('c: a required check failed, with the log link', () => {
    const m = pullRequestCard(pr({ condition: 'CHECK_FAILED', checks: { passed: 5, required: 6, failed: [{ name: 'PostgreSQL specs', url: 'https://x/log' }] } }), 'main');
    expect(m.head).toBe('Check failed: PostgreSQL specs');
    expect(m.segments.at(-1)).toBe('failed');
    expect(m.actions[0]).toEqual({ label: 'View log ↗', href: 'https://x/log' });
  });
  it('d: main moved', () => {
    expect(pullRequestCard(pr({ condition: 'BEHIND', checks: { passed: 0, required: 6, failed: [] } }), 'main').head).toBe('Catching up with main');
  });
  it('e: merged', () => {
    const m = pullRequestCard(pr({ state: 'MERGED', condition: null, mergedSha: '3a9f1c2deadbeef' }), 'main');
    expect([m.head, m.detail]).toEqual(['Landed by pull request #214', 'Merged into main · 3a9f1c2']);
  });
  it('f: Push as me refused, fell back', () => {
    const m = pullRequestCard(pr({ refusal: { via: 'PUSH_AS_ME', message: 'Changes must be made through a pull request.' } }), 'main');
    expect([m.head, m.right]).toEqual(['Opened a pull request instead', 'Push refused']);
    expect(m.detail).toContain('Landing through pull request #214.');
  });
  it('a refused push in Pull request mode is not a failure: it reads as an opened pull request', () => {
    expect(pullRequestCard(pr({ refusal: { via: 'PULL_REQUEST', message: 'protected' } }), 'main').stage).toBe('OPENED');
  });
  it('closed', () => {
    expect(pullRequestCard(pr({ state: 'CLOSED', condition: null }), 'main').head).toBe('Pull request closed');
  });
});

describe('LandingPullRequest tip', () => {
  const draw = (props: Parameters<typeof LandingPullRequest>[0]) => {
    const host = document.createElement('div');
    document.body.append(host);
    act(() => createRoot(host).render(<MemoryRouter><LandingPullRequest {...props} /></MemoryRouter>));
    return host;
  };
  const waiting = pr({ condition: 'REVIEW_REQUIRED', checks: { passed: 6, required: 6, failed: [] } });
  it('shows the Faster tip while waiting for review, hides it once dismissed or when Push as me is on', () => {
    window.localStorage.clear();
    expect(draw({ pullRequest: waiting }).querySelector('[data-landing-tip="faster"]')?.textContent).toContain('Faster next time');
    expect(draw({ pullRequest: waiting, pushAsMe: true }).querySelector('[data-landing-tip]')).toBeNull();
    expect(draw({ pullRequest: pr({}) }).querySelector('[data-landing-tip]')).toBeNull();
    const host = draw({ pullRequest: waiting });
    act(() => host.querySelector<HTMLButtonElement>('.landing-pr-tip button')!.click());
    expect(host.querySelector('[data-landing-tip]')).toBeNull();
  });
});
