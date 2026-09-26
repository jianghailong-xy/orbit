import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Popconfirm, Spin } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { putShareLink, turnOffShareLinks, type ShareLink, type ShareLinkState } from '../api';
import { canShareKind, ShareModal } from '../components/ShareModal';
import { taskStatusLabel } from '../components/TaskStatusPill';
import { copyText } from '../lib/clipboard';
import { shareLinksQuery } from '../lib/queries';
import { includeChips, publicLinkUrl, shortDate, staleSessionLinks } from '../lib/shareLinks';
import { sessionLifecycleLabel, sessionLifecycleStateOf } from '../lib/sessionState';
import { useToast } from '../lib/toast';
import { ago } from '../lib/watches';

type Tab = 'active' | 'paused' | 'ended';

const TABS: readonly { key: Tab; state: ShareLinkState; label: string; empty: string }[] = [
  {
    key: 'active',
    state: 'ACTIVE',
    label: 'Active',
    empty: 'Nothing is shared right now. Share a session from its ⋯ menu.',
  },
  {
    key: 'paused',
    state: 'PAUSED',
    label: 'Paused',
    empty: 'No link is paused. A session’s link pauses while the session is in Trash.',
  },
  { key: 'ended', state: 'ENDED', label: 'Ended', empty: 'No link has ended yet.' },
];

const isTab = (value: string | null): value is Tab => TABS.some((tab) => tab.key === value);

const KIND_WORD: Record<ShareLink['kind'], string> = { SESSION: 'Session', TASK: 'Task', PROJECT: 'Project' };
const KIND_LETTER: Record<ShareLink['kind'], string> = { SESSION: 'S', TASK: 'T', PROJECT: 'P' };
/** A project's status in the words the projects pages use (ProjectsPage STATUS_LABEL). */
const PROJECT_WORD: Record<string, string> = { OPEN: 'Open', DONE: 'Completed', CANCELLED: 'Cancelled' };

// The contract's words for turning a link off (§8).
const TURN_OFF_TITLE = 'Turn off this link?';
const TURN_OFF_DETAIL = 'Anyone who has it loses access right away.';

/** Where the root stands, after what it is: "Session · Completed Sep 22", "Task · Done". */
function rootWhere(link: ShareLink): string {
  const kind = KIND_WORD[link.kind];
  if (link.kind === 'TASK') return `${kind} · ${taskStatusLabel(link.root.status)}`;
  if (link.kind === 'PROJECT') return `${kind} · ${PROJECT_WORD[link.root.status] ?? link.root.status}`;
  const lifecycle = sessionLifecycleStateOf(link.root);
  const label = sessionLifecycleLabel(lifecycle);
  return lifecycle === 'COMPLETED' && link.root.completedAt
    ? `${kind} · ${label} ${shortDate(link.root.completedAt)}`
    : `${kind} · ${label}`;
}

/** Why an ended link ended, and when. */
function endedWhy(link: ShareLink): string {
  const at = link.revokedAt ?? link.expiresAt;
  const word = link.stateReason === 'EXPIRED' ? 'Expired' : 'Turned off';
  return at ? `${word} ${shortDate(at)}` : word;
}

/**
 * Settings → Shared links: every public link this account has made, filed by where it stands —
 * Active (anyone with it can open it), Paused (its session is in Trash; restoring the session turns
 * it back on) and Ended (turned off or expired, for good). The page Following is, for links: a title,
 * a line on what it lists, counted tabs, one card per link. Links for sessions completed more than
 * 30 days ago are named above the list with a way to turn them all off, since nobody is watching
 * those. docs/share-links-design.md §3, §8; docs/mocks/share-links/06-manage-and-entry.
 */
export function SharedLinksPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const message = useToast();
  const linksQ = useQuery(shareLinksQuery());
  const links = linksQ.data?.links ?? [];
  const now = Date.now();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'active';
  const current = TABS.find((t) => t.key === tab)!;
  const byState = (state: ShareLinkState) => links.filter((link) => link.state === state);
  const shown = byState(current.state);
  const stale = staleSessionLinks(links, now);
  // A root with a link that has not ended: ending one of its older links again, or sharing it
  // again, would be about a different link than the row's.
  const openRoots = new Set(links.filter((link) => link.state !== 'ENDED').map((link) => link.root.id));
  const [settingsFor, setSettingsFor] = useState<ShareLink | null>(null);

  // What a link's state changes: this list, and the session list's globe and header.
  const refresh = () => {
    for (const key of [['share-links'], ['sessions'], ['session']]) void qc.invalidateQueries({ queryKey: key });
  };
  const turnOff = useMutation({
    mutationFn: (ids: string[]) => turnOffShareLinks(ids),
    onSuccess: ({ count }) => {
      refresh();
      message.success(count === 1 ? 'Link turned off' : `${count} links turned off`);
    },
    onError: (e: Error) => message.error(e.message),
  });
  const shareAgain = useMutation({
    mutationFn: (link: ShareLink) => putShareLink(link.kind, link.root.id, { include: link.include }),
    onSuccess: () => {
      refresh();
      message.success('Shared again — with a new link');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const copy = (link: ShareLink) => {
    void copyText(publicLinkUrl(link.token)).then((ok) =>
      ok ? message.success('Link copied') : message.error('Could not copy'),
    );
  };

  return (
    <div className="following-page shared-links-page">
      <header className="following-head">
        <h1 className="page-title">Shared links</h1>
        <p className="following-sub">
          Everything you’ve made viewable by link. Anyone who has one of these links can open what it
          includes — no sign-in.
        </p>
      </header>
      <div className="following-tabs" role="tablist" aria-label="Shared links">
        {TABS.map(({ key, state, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`following-tab${tab === key ? ' is-on' : ''}`}
            onClick={() => setParams({ tab: key }, { replace: true })}
          >
            {label}
            <span className="following-count">{byState(state).length}</span>
          </button>
        ))}
      </div>
      {tab === 'active' && stale.length > 0 && (
        <div className="shared-links-banner" role="status">
          <WarningOutlined className="shared-links-banner-icon" />
          <span className="shared-links-banner-text">
            <b>
              {stale.length === 1
                ? '1 link is for a session completed more than 30 days ago.'
                : `${stale.length} links are for sessions completed more than 30 days ago.`}
            </b>{' '}
            {stale.length === 1 ? 'It still opens for anyone who has it.' : 'They still open for anyone who has them.'}
          </span>
          <Popconfirm
            title={stale.length === 1 ? TURN_OFF_TITLE : `Turn off these ${stale.length} links?`}
            description={stale.length === 1 ? TURN_OFF_DETAIL : 'Anyone who has them loses access right away.'}
            okText="Turn off"
            okButtonProps={{ danger: true }}
            cancelText="Cancel"
            onConfirm={() => turnOff.mutate(stale.map((link) => link.id))}
          >
            <Button size="small" loading={turnOff.isPending}>
              {stale.length === 1 ? 'Turn off this link' : `Turn off these ${stale.length}`}
            </Button>
          </Popconfirm>
        </div>
      )}
      <div role="tabpanel" className="following-panel">
        {linksQ.isPending ? (
          <div className="following-empty">
            <Spin />
          </div>
        ) : linksQ.isError ? (
          <div className="following-empty">
            Couldn’t load your links: {linksQ.error.message}{' '}
            <Button size="small" onClick={() => void linksQ.refetch()}>
              Retry
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <div className="following-empty">{current.empty}</div>
        ) : (
          <div className="shared-links-list">
            <div className="shared-link-row is-head" aria-hidden>
              <span />
              <span>Shared item</span>
              <span>Includes</span>
              <span>Updates</span>
              <span>Views</span>
              <span />
            </div>
            {shown.map((link) => (
              <div key={link.id} className="shared-link-row" data-state={link.state} data-kind={link.kind}>
                <span className={`shared-link-kind kind-${link.kind.toLowerCase()}`} aria-hidden>
                  {KIND_LETTER[link.kind]}
                </span>
                <div className="shared-link-item">
                  <div className="shared-link-title">{link.root.title}</div>
                  <div className="shared-link-where">
                    {link.state === 'PAUSED' ? (
                      <>
                        <span className="shared-link-paused">Paused · in Trash</span> — restoring the session
                        turns this link back on
                      </>
                    ) : link.state === 'ENDED' ? (
                      `${KIND_WORD[link.kind]} · ${endedWhy(link)}`
                    ) : (
                      rootWhere(link)
                    )}
                  </div>
                </div>
                <div className="shared-link-includes">
                  {includeChips(link).map((chip) => (
                    <span key={chip.label} className={`shared-link-chip${chip.warn ? ' is-warn' : ''}`}>
                      {chip.label}
                    </span>
                  ))}
                </div>
                <div className="shared-link-updates">
                  {link.expiresAt && link.state !== 'ENDED' ? `Live · until ${shortDate(link.expiresAt)}` : 'Live'}
                </div>
                <div className="shared-link-views">
                  {link.viewCount > 0
                    ? `${link.viewCount}${link.lastViewedAt ? ` · ${ago(link.lastViewedAt, now)}` : ''}`
                    : '—'}
                  <div className="shared-link-since">since {shortDate(link.createdAt)}</div>
                </div>
                <div className="shared-link-actions">
                  {link.state === 'ACTIVE' && (
                    <>
                      <Button size="small" icon={<CopyOutlined />} onClick={() => copy(link)}>
                        Copy
                      </Button>
                      {canShareKind(link.kind) && (
                        <Button size="small" onClick={() => setSettingsFor(link)}>
                          Settings
                        </Button>
                      )}
                    </>
                  )}
                  {link.state !== 'ENDED' && (
                    <Popconfirm
                      title={TURN_OFF_TITLE}
                      description={TURN_OFF_DETAIL}
                      okText="Turn off"
                      okButtonProps={{ danger: true }}
                      cancelText="Cancel"
                      onConfirm={() => turnOff.mutate([link.id])}
                    >
                      <Button size="small" type="text" danger>
                        Turn off
                      </Button>
                    </Popconfirm>
                  )}
                  {link.state === 'ENDED' && link.stateReason === 'EXPIRED' && !openRoots.has(link.root.id) && (
                    <Button size="small" loading={shareAgain.isPending} onClick={() => shareAgain.mutate(link)}>
                      Share again
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {settingsFor && (
        <ShareModal
          open
          onClose={() => setSettingsFor(null)}
          kind={settingsFor.kind}
          rootId={settingsFor.root.id}
        />
      )}
    </div>
  );
}
