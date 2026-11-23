import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import { workspacesQuery } from '../lib/queries';
import type { LandingPullRequestView } from '@orbit/shared';

/**
 * The landing's pull request states (docs/mocks/protected-branch-landing 02, owner 2026-11-23; design §11.2),
 * drawn from the `pullRequest` block the landing read models carry. One function reads the block into the
 * card's words so a test can pin every state; the component draws it.
 */
export type PullRequestStage =
  | 'OPENED' | 'WAITING_FOR_REVIEW' | 'CHECK_FAILED' | 'CATCHING_UP' | 'MERGED' | 'CLOSED' | 'FELL_BACK';

export interface PullRequestCardModel {
  stage: PullRequestStage;
  head: string;
  /** "2 of 6", "6 of 6 ✓", or null when the card keeps a time or nothing at the right. */
  right: string | null;
  detail: string;
  tone: 'blue' | 'green' | 'red' | 'amber';
  /** One segment per required check. */
  segments: Array<'passed' | 'failed' | 'pending'>;
  actions: Array<{ label: string; href: string }>;
}

export const PULL_REQUEST_WORDS = {
  VIEW: 'View on GitHub ↗',
  REVIEW: 'Review on GitHub ↗',
  LOG: 'View log ↗',
  SETTINGS: 'Landing settings',
  TIP: 'Faster next time: with Push as me, landings go straight to main when you may push there, without waiting for a pull request.',
  TIP_LINK: 'Landing settings ›',
  DISMISS: 'Hide this tip',
} as const;

export function pullRequestCard(pr: LandingPullRequestView, main: string, workspaceId: string | undefined = pr.workspaceId): PullRequestCardModel {
  const number = pr.number != null ? `#${pr.number}` : '';
  const url = pr.url;
  const view = url ? [{ label: PULL_REQUEST_WORDS.VIEW, href: url }] : [];
  const { passed, required, failed } = pr.checks;
  const segments: PullRequestCardModel['segments'] = Array.from({ length: Math.max(required, 0) }, (_, i) =>
    i < passed ? 'passed' : i < passed + failed.length ? 'failed' : 'pending');
  const count = `${passed} of ${required}`;
  const base = { segments, actions: view };

  if (pr.state === 'MERGED') {
    return {
      ...base, stage: 'MERGED', tone: 'green', head: `Landed by pull request ${number}`.trim(), right: null,
      detail: `Merged into ${main}${pr.mergedSha ? ` · ${pr.mergedSha.slice(0, 7)}` : ''}`,
    };
  }
  if (pr.state === 'CLOSED') {
    return {
      ...base, stage: 'CLOSED', tone: 'red', head: 'Pull request closed', right: null,
      detail: `Pull request ${number} was closed without merging it.`.replace('  ', ' '),
    };
  }
  if (pr.condition === 'CHECK_FAILED' && failed.length > 0) {
    const first = failed[0];
    return {
      stage: 'CHECK_FAILED', tone: 'red', segments, right: null,
      head: `Check failed: ${first.name}`,
      detail: 'Sent back to the session with the log. Fixes update this pull request.',
      actions: [...(first.url ? [{ label: PULL_REQUEST_WORDS.LOG, href: first.url }] : []), ...view],
    };
  }
  if (pr.refusal?.via === 'PUSH_AS_ME') {
    return {
      ...base, stage: 'FELL_BACK', tone: 'amber', head: 'Opened a pull request instead', right: 'Push refused',
      detail: `GitHub refused the push to ${main}: “${pr.refusal.message}” Landing through pull request ${number}.`,
      actions: [...view, { label: PULL_REQUEST_WORDS.SETTINGS, href: landingSettingsHref(workspaceId) }],
    };
  }
  if (pr.condition === 'BEHIND') {
    return {
      ...base, stage: 'CATCHING_UP', tone: 'blue', head: `Catching up with ${main}`, right: count,
      detail: `${main} moved since the pull request opened. Orbit is checking the branch again on the new ${main}.`,
    };
  }
  if (pr.condition === 'REVIEW_REQUIRED' || pr.condition === 'CHANGES_REQUESTED' || pr.condition === 'MERGEABLE') {
    return {
      stage: 'WAITING_FOR_REVIEW', tone: 'blue', segments, head: 'Waiting for review', right: `${count} ✓`,
      detail: `Checks passed. ${main} requires an approving review.`,
      actions: url ? [{ label: PULL_REQUEST_WORDS.REVIEW, href: url }] : [],
    };
  }
  return {
    ...base, stage: 'OPENED', tone: 'blue', head: 'Pull request open', right: count,
    detail: `${main} requires a pull request. Waiting for the required checks.`,
  };
}

const TIP_KEY = 'orbit.landing.fasterTipHidden';
const tipHidden = (): boolean => {
  try { return window.localStorage.getItem(TIP_KEY) === '1'; } catch { return false; }
};

/** Where the tip and the fallback card send the owner: that workspace's settings, at its Landing section. */
export const landingSettingsHref = (workspaceId: string | undefined): string =>
  workspaceId ? `/settings/workspaces/${encodeURIComponent(encodeId(workspaceId))}#landing` : '/settings/workspaces';

/** The tip, owner 2026-11-23: dismissible, and not shown once the workspace is on Push as me. */
function FasterTip({ workspaceId }: { workspaceId?: string }): JSX.Element | null {
  const [hidden, setHidden] = useState(tipHidden);
  // Mounted only for a card that names its workspace, so a bare card needs no query client.
  const mode = (useQuery({ ...workspacesQuery(), enabled: !!workspaceId }).data as
    Array<{ id: string; landingMode?: string | null }> | undefined)?.find((w) => w.id === workspaceId)?.landingMode;
  if (hidden || mode === 'PUSH_AS_ME') return null;
  return (
    <p className="landing-pr-tip" data-landing-tip="faster">
      <span>{PULL_REQUEST_WORDS.TIP} <Link to={landingSettingsHref(workspaceId)}>{PULL_REQUEST_WORDS.TIP_LINK}</Link></span>
      <button type="button" aria-label={PULL_REQUEST_WORDS.DISMISS} onClick={() => {
        try { window.localStorage.setItem(TIP_KEY, '1'); } catch { /* the tip hides for this view */ }
        setHidden(true);
      }}>×</button>
    </p>
  );
}

export function LandingPullRequest({
  pullRequest, main = 'main', pushAsMe = false, sessionHref,
}: {
  pullRequest: LandingPullRequestView;
  main?: string;
  /** Overrides the workspace's own setting, which the card reads by `pullRequest.workspaceId`. */
  pushAsMe?: boolean;
  /** Where "Open session" goes, on a failed check. */
  sessionHref?: string;
}): JSX.Element {
  const model = pullRequestCard(pullRequest, main, pullRequest.workspaceId);
  const tip = model.stage === 'WAITING_FOR_REVIEW' && !pushAsMe;
  return (
    <div className="landing-pr" data-pr-stage={model.stage} data-tone={model.tone}>
      <div className="landing-pr-head">
        <span className="landing-pr-title">{model.head}</span>
        {model.right ? <span className="landing-pr-right">{model.right}</span> : null}
      </div>
      {model.segments.length > 0 ? (
        <div className="landing-pr-bar" aria-hidden="true">
          {model.segments.map((s, i) => <span key={i} data-seg={s} />)}
        </div>
      ) : null}
      <p className="landing-pr-detail">{model.detail}</p>
      <div className="landing-pr-actions">
        {model.stage === 'CHECK_FAILED' && sessionHref ? <Link to={sessionHref}>Open session</Link> : null}
        {model.actions.map((a) => a.href.startsWith('/')
          ? <Link key={a.label} to={a.href}>{a.label}</Link>
          : <a key={a.label} href={a.href} target="_blank" rel="noreferrer">{a.label}</a>)}
      </div>
      {tip ? <FasterTip workspaceId={pullRequest.workspaceId} /> : null}
    </div>
  );
}
