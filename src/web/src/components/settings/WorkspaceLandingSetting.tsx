import { useEffect, useRef } from 'react';
import type { WorkspaceLandingMode, WorkspaceLandingView } from '@orbit/shared';
import { Badge } from '../ui/Badge';
import { SettingsCard, SettingsSection } from './SettingsBlocks';

/**
 * The workspace's landing setting (docs/mocks/protected-branch-landing, option A, owner 2026-11-23): a
 * "Landing" section with both choices visible, so "faster" and "needs the right to push" sit side by side.
 * `landing` is the `landing` block of `GET /workspaces/:id`.
 */
export const LANDING_WORDS = {
  SECTION: 'Landing',
  LEAD: 'How finished work reaches main on GitHub.',
  PULL_REQUEST: 'Pull request',
  PULL_REQUEST_BODY:
    "Orbit pushes to main when GitHub allows it. When main requires a pull request, Orbit opens one and merges it once the branch's rules pass: required checks, and a review if one is required.",
  PUSH_AS_ME: 'Push as me',
  PUSH_AS_ME_BODY:
    "Orbit pushes to main with your GitHub account, so a landing doesn't wait for a pull request where you may push past main's rules. Needs the right to push to main. If GitHub refuses, Orbit opens a pull request instead.",
  NOT_CONNECTED: 'Connect GitHub to push as yourself.',
  CONNECT: 'Connect GitHub ›',
  NOT_GITHUB: "Landings push with this machine's Git credential.",
  REFUSED: 'Push refused.',
  CONNECT_AGAIN: 'Connect GitHub again ›',
  REVIEW: 'Review on GitHub ↗',
} as const;

export function permissionsText(account: string): string {
  return `Landing through pull requests starts once ${account} accepts Orbit's updated GitHub permissions.`;
}

export function refusalText(branch: string, repo: string | null, message: string): string {
  return `GitHub refused your last push to ${branch}${repo ? ` on ${repo}` : ''}: “${message}” Landings here open a pull request until GitHub accepts your push. Connect GitHub again if your rights have changed.`;
}

export function WorkspaceLandingSetting({
  landing,
  repo,
  saving,
  onChoose,
  connectHref = '/settings/integrations/github',
}: {
  landing: WorkspaceLandingView;
  /** `owner/repo`, for the refusal notice. */
  repo: string | null;
  saving?: boolean;
  onChoose: (mode: WorkspaceLandingMode) => void;
  connectHref?: string;
}) {
  // A link to #landing opens the page here.
  const section = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.location.hash === '#landing') section.current?.scrollIntoView?.({ block: 'start' });
  }, []);
  if (landing.mode === null) {
    return (
      <SettingsSection title={LANDING_WORDS.SECTION} className="workspace-section-landing">
        <SettingsCard>
          <p className="landing-setting-lead" data-landing-state="not-github">{LANDING_WORDS.NOT_GITHUB}</p>
        </SettingsCard>
      </SettingsSection>
    );
  }
  const pushDisabled = !landing.pushAsMe.available;
  const refusal = landing.mode === 'PUSH_AS_ME' ? landing.lastRefusal : null;
  return (
    <SettingsSection title={LANDING_WORDS.SECTION} className="workspace-section-landing">
      <SettingsCard>
        <div ref={section} id="landing" />
        <p className="landing-setting-lead">{LANDING_WORDS.LEAD}</p>
        <div role="radiogroup" aria-label={LANDING_WORDS.SECTION} className="landing-setting-choices">
          <label className="landing-setting-choice" data-checked={landing.mode === 'PULL_REQUEST'}>
            <input type="radio" name="landing-mode" value="PULL_REQUEST" checked={landing.mode === 'PULL_REQUEST'}
              disabled={saving} onChange={() => onChoose('PULL_REQUEST')} />
            <span>
              <span className="landing-setting-name">
                {LANDING_WORDS.PULL_REQUEST} <Badge tone="blue">Default</Badge>
              </span>
              <span className="landing-setting-body">{LANDING_WORDS.PULL_REQUEST_BODY}</span>
            </span>
          </label>
          <label className="landing-setting-choice" data-checked={landing.mode === 'PUSH_AS_ME'}
            data-disabled={pushDisabled || undefined}>
            <input type="radio" name="landing-mode" value="PUSH_AS_ME" checked={landing.mode === 'PUSH_AS_ME'}
              disabled={saving || pushDisabled} onChange={() => onChoose('PUSH_AS_ME')} />
            <span>
              <span className="landing-setting-name">
                {LANDING_WORDS.PUSH_AS_ME} <Badge>Faster</Badge>
              </span>
              <span className="landing-setting-body">{LANDING_WORDS.PUSH_AS_ME_BODY}</span>
              {landing.pushAsMe.reason === 'GITHUB_NOT_CONNECTED' ? (
                <span className="landing-setting-body">
                  {LANDING_WORDS.NOT_CONNECTED} <a href={connectHref}>{LANDING_WORDS.CONNECT}</a>
                </span>
              ) : null}
            </span>
          </label>
        </div>
        {landing.permissionsPending ? (
          <p className="landing-setting-notice" role="status" data-landing-state="permissions-pending">
            {permissionsText(landing.permissionsPending.account)}{' '}
            <a href={landing.permissionsPending.reviewUrl} target="_blank" rel="noreferrer">{LANDING_WORDS.REVIEW}</a>
          </p>
        ) : null}
        {refusal ? (
          <p className="landing-setting-notice" role="status" data-landing-state="refused">
            <strong>{LANDING_WORDS.REFUSED}</strong> {refusalText(refusal.branch, repo, refusal.message)}{' '}
            <a href={connectHref}>{LANDING_WORDS.CONNECT_AGAIN}</a>
          </p>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
