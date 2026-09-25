import { FileMarkdownOutlined, GlobalOutlined, LinkOutlined, MoreOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Dropdown } from 'antd';
import { useState } from 'react';
import { getShareLink } from '../api';
import { copyText } from '../lib/clipboard';
import { encodeId } from '../lib/idCodec';
import { useToast } from '../lib/toast';
import { type ProjectPanoramaBuckets, projectPanoramaQuery } from './ProjectPanoramaHeader';
import { ShareModal, shareLinkQueryKey } from './ShareModal';
import { taskStatusLabel } from './TaskStatusPill';

/** The signed-in address of a project — what Copy link hands its owner, never the public one. */
export const projectAppUrl = (projectId: string): string =>
  `${window.location.origin}/projects/${encodeId(projectId)}`;

/** What the Markdown reads off the project document the page already holds. */
export interface ProjectMarkdownSource {
  title: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  goal?: string | null;
  _count: { tasks: number };
  acceptanceCriteriaItems?: { ordinal: number; text: string; satisfied?: boolean; landing?: string }[];
}

/** A task as the Markdown lists it: the project page's own task rows. */
export interface ProjectMarkdownTask {
  title: string;
  status: string;
  workState?: string;
}

const PROJECT_STATUS_WORD: Record<ProjectMarkdownSource['status'], string> = {
  OPEN: 'Open',
  DONE: 'Completed',
  CANCELLED: 'Cancelled',
};

/** Where a criterion's met work is, in the acceptance card's words. */
const LANDING_WORDS: Record<string, string> = {
  LANDED: 'on main',
  ON_INTEGRATION_LINE: 'on the project branch · not on main yet',
  UNKNOWN: 'no merge receipt either way',
};

/** How many of each lane the progress line names, in the Work overview's order and words. */
const PROGRESS_LANES: { key: keyof ProjectPanoramaBuckets; word: string }[] = [
  { key: 'done', word: 'done' },
  { key: 'running', word: 'running' },
  { key: 'ready', word: 'ready' },
  { key: 'blocked', word: 'waiting' },
  { key: 'awaitingVerification', word: 'awaiting verification' },
  { key: 'failed', word: 'failed' },
  { key: 'cancelled', word: 'cancelled' },
];

/**
 * The project as Markdown, for pasting into a chat or a PR (docs/share-links-design.md §8, Copy as
 * Markdown): its title, where it stands and how far its work has got, its goal, each stated
 * criterion with what its work has done, its tasks, and the signed-in link back to it — in the words
 * the project page uses. The owner's own read, for the owner's own use: nothing is made public by
 * copying it. `buckets` and `tasks` are what the page's Work overview and Tasks blocks have read,
 * when they have.
 */
export function projectMarkdown(
  project: ProjectMarkdownSource,
  link: string,
  extras: { buckets?: ProjectPanoramaBuckets; tasks?: ProjectMarkdownTask[] } = {},
): string {
  const tasks = project._count.tasks;
  const progress = extras.buckets
    ? PROGRESS_LANES.flatMap(({ key, word }) => {
        const value = extras.buckets?.[key] ?? 0;
        return typeof value === 'number' && value > 0 ? [`${value} ${word}`] : [];
      }).join(', ')
    : '';
  const status = [PROJECT_STATUS_WORD[project.status] ?? project.status, `${tasks} task${tasks === 1 ? '' : 's'}`]
    .concat(progress ? [progress] : [])
    .join(' · ');
  const out = [`# ${project.title}`, '', `**Status:** ${status}`, `**Link:** ${link}`];
  const goal = project.goal?.trim();
  out.push('', '## Goal', '', goal || 'No goal set');

  const criteria = project.acceptanceCriteriaItems ?? [];
  out.push('', '## Acceptance criteria', '');
  if (criteria.length === 0) out.push('No criteria are stated for this project.');
  for (const criterion of criteria) {
    const answer =
      criterion.satisfied === undefined
        ? ''
        : criterion.satisfied
          ? ` — Met by its work${criterion.landing ? ` · ${LANDING_WORDS[criterion.landing] ?? criterion.landing}` : ''}`
          : ' — Not met by its work';
    out.push(`${criterion.ordinal}. ${criterion.text.trim()}${answer}`);
  }

  if (extras.tasks) {
    out.push('', '## Tasks', '');
    if (extras.tasks.length === 0) out.push('No top-level tasks yet');
    for (const task of extras.tasks) {
      out.push(`- ${task.title} — ${taskStatusLabel(task.status, task.workState === 'RUNNING')}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * The project header's sharing controls (docs/share-links-design.md §8, mock 06 ④): a pill that says
 * the project is public — "Shared · Live", opening its Share dialog — or a Share button while it is
 * not; Copy link, the signed-in address for yourself; and the ⋯ menu with Copy link, Share… and Copy
 * as Markdown. Whether a public link is open is read under the dialog's own key, so the dialog opens
 * on it and every change made there shows here at once.
 */
export function ProjectShareControls({
  projectId,
  project,
}: {
  projectId: string;
  project: ProjectMarkdownSource;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [shareOpen, setShareOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const shareQ = useQuery({
    queryKey: shareLinkQueryKey('PROJECT', projectId),
    queryFn: () => getShareLink('PROJECT', projectId),
  });
  const live = shareQ.data?.link != null && shareQ.data.link.state !== 'ENDED';

  const copy = (text: string, done: string) =>
    void copyText(text).then((ok) => (ok ? toast.success(done) : toast.error('Could not copy')));
  const copyMarkdown = () => {
    // What the page's Work overview and Tasks blocks already read, under their own keys: nothing is
    // fetched for the copy.
    const buckets = qc.getQueryData<{ buckets: ProjectPanoramaBuckets }>(projectPanoramaQuery(projectId).queryKey)?.buckets;
    const tasks = qc.getQueryData<{ items: ProjectMarkdownTask[] }>(['project', projectId, 'tasks', 'root'])?.items;
    copy(projectMarkdown(project, projectAppUrl(projectId), { buckets, tasks }), 'Markdown copied');
  };

  return (
    <>
      {live ? (
        <button
          type="button"
          className="session-shared-pill"
          title="Anyone with the link can view this project — open its sharing settings"
          onClick={() => setShareOpen(true)}
        >
          <GlobalOutlined /> Shared · Live
        </button>
      ) : (
        <Button size="small" icon={<GlobalOutlined />} onClick={() => setShareOpen(true)}>
          Share
        </Button>
      )}
      <Button size="small" icon={<LinkOutlined />} onClick={() => copy(projectAppUrl(projectId), 'Link copied')}>
        Copy link
      </Button>
      {/* Two words for two links (§8): Copy link is the signed-in address, for yourself; Share… is
          the public one. Copy as Markdown needs neither. */}
      <Dropdown
        trigger={['click']}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        menu={{
          className: 'project-more-menu',
          items: [
            {
              key: 'copy-link',
              icon: <LinkOutlined />,
              label: 'Copy link',
              onClick: () => {
                setMenuOpen(false);
                copy(projectAppUrl(projectId), 'Link copied');
              },
            },
            {
              key: 'share',
              icon: <GlobalOutlined className={live ? 'session-share-icon-live' : undefined} />,
              label: live ? (
                <span className="scope-menu-row">
                  Share…<span className="scope-menu-value">Live link</span>
                </span>
              ) : (
                'Share…'
              ),
              onClick: () => {
                setMenuOpen(false);
                setShareOpen(true);
              },
            },
            {
              key: 'copy-markdown',
              icon: <FileMarkdownOutlined />,
              label: 'Copy as Markdown',
              onClick: () => {
                setMenuOpen(false);
                copyMarkdown();
              },
            },
          ],
        }}
      >
        <Button size="small" type="text" icon={<MoreOutlined />} aria-label="More project actions" />
      </Dropdown>
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} kind="PROJECT" rootId={projectId} />
    </>
  );
}
