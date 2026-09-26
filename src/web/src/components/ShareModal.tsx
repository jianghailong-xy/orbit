import { CheckOutlined, CopyOutlined, DownOutlined, GlobalOutlined, LinkOutlined, LockOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Button, Checkbox, Dropdown, Modal, Popconfirm, Select, Spin } from 'antd';
import { useEffect, useState } from 'react';
import {
  getShareLink,
  putShareLink,
  turnOffShareLink,
  type ShareCounts,
  type ShareLayer,
  type ShareLink,
  type ShareRootKind,
} from '../api';
import { copyText } from '../lib/clipboard';
import { encodeId } from '../lib/idCodec';
import { countOf, EXPIRY_CHOICES, previewUrl, publicLinkUrl, shortDate, viewsLine } from '../lib/shareLinks';
import { useToast } from '../lib/toast';

/** One row of Includes. `layer: null` is the root's own content, which a link always includes.
 *  `warn` marks the row whose detail is a risk, said in amber once the layer is on. `under` names
 *  the layer this one sits under: indented beneath it, and greyed out while it is off, since
 *  nothing below it is shared then. */
interface LayerRow {
  layer: ShareLayer | null;
  name: string;
  detail: string | ((counts: ShareCounts | undefined) => string);
  count: (counts: ShareCounts) => string;
  warn?: true;
  under?: ShareLayer;
}

/** The Conversations layer's risk, in the contract's fixed words (§8). */
export const CONVERSATIONS_RISK = 'Can include command output and file contents.';

/** What the dialog says and does for one kind of root (docs/share-links-design.md §1, §8). */
interface RootKindSpec {
  title: string;
  /** Under "Anyone with the link": what a visitor can and cannot do. */
  publicDetail: string;
  layers: readonly LayerRow[];
  /** The signed-in address "Copy link" hands out — the owner's own, never the public one. */
  appPath: (id: string) => string;
  /** The reads that show whether this root is shared, refreshed after every change here. */
  shows: readonly QueryKey[];
}

/** The kinds of root this dialog is wired for. */
const ROOT_KINDS: { readonly [K in ShareRootKind]?: RootKindSpec } = {
  SESSION: {
    title: 'Share session',
    publicDetail: 'Anyone with the link can view — no sign-in. They can’t reply or change anything.',
    layers: [
      {
        layer: null,
        name: 'Messages',
        detail: 'What you and the agent wrote',
        count: (counts) => countOf(counts.messages ?? 0, 'message'),
      },
      {
        layer: 'toolOutput',
        name: 'Tool calls and output',
        detail: 'Commands, file reads and what they returned. Off shows only which tools ran.',
        count: (counts) => countOf(counts.toolCalls ?? 0, 'call'),
      },
    ],
    appPath: (id) => `/sessions/${encodeId(id)}`,
    // The session's detail (header pill, menu) and every list it is a row of (the globe).
    shows: [['session'], ['sessions']],
  },
  TASK: {
    title: 'Share task',
    publicDetail: 'Anyone with the link can view — no sign-in. They can’t change anything.',
    layers: [
      {
        layer: null,
        name: 'Overview',
        detail: 'Description, acceptance, dependencies and runs',
        count: () => 'Always',
      },
      {
        layer: 'commentsAndFiles',
        name: 'Comments & files',
        detail: 'Written by agents and people',
        count: (counts) =>
          [countOf(counts.comments ?? 0, 'comment'), ...(counts.files ? [countOf(counts.files, 'file')] : [])].join(' · '),
      },
      {
        layer: 'conversations',
        name: 'Conversations',
        detail: CONVERSATIONS_RISK,
        count: (counts) => countOf(counts.transcripts ?? 0, 'transcript'),
        warn: true,
      },
    ],
    appPath: (id) => `/tasks/${encodeId(id)}`,
    // The task panel's ⋯ reads the link under this dialog's own key, which every write here updates.
    shows: [],
  },
  PROJECT: {
    title: 'Share project',
    publicDetail: 'Anyone with the link can view — no sign-in. They can’t change anything.',
    layers: [
      {
        layer: null,
        name: 'Overview',
        detail: 'Goal, work overview, acceptance criteria and task graph',
        count: () => 'Always',
      },
      {
        layer: 'taskPages',
        name: 'Task pages',
        detail: 'Description, acceptance and runs for each task',
        count: (counts) => countOf(counts.tasks ?? 0, 'task'),
      },
      {
        layer: 'commentsAndFiles',
        name: 'Comments & files',
        detail: 'Written by agents and people',
        count: (counts) =>
          [countOf(counts.comments ?? 0, 'comment'), ...(counts.files ? [countOf(counts.files, 'file')] : [])].join(' · '),
        under: 'taskPages',
      },
      {
        layer: 'conversations',
        name: 'Conversations',
        // What the transcripts are, then the fixed risk sentence (§8).
        detail: (counts) =>
          counts
            ? `${countOf(counts.runs ?? 0, 'run')}${(counts.transcripts ?? 0) > (counts.runs ?? 0) ? ' and the coordinator' : ''}. ${CONVERSATIONS_RISK}`
            : CONVERSATIONS_RISK,
        count: (counts) => countOf(counts.transcripts ?? 0, 'transcript'),
        warn: true,
        under: 'taskPages',
      },
    ],
    appPath: (id) => `/projects/${encodeId(id)}`,
    // The project header's pill reads the link under this dialog's own key, which every write here
    // updates.
    shows: [],
  },
};

/** Whether this dialog can be opened for a root of `kind`. */
export const canShareKind = (kind: ShareRootKind): boolean => ROOT_KINDS[kind] != null;

export const shareLinkQueryKey = (kind: ShareRootKind, id: string) => ['share-links', kind, id] as const;

// The contract's words for turning a link off (§8).
const TURN_OFF_TITLE = 'Turn off this link?';
const TURN_OFF_DETAIL = 'Anyone who has it loses access right away.';

/**
 * The one Share dialog: Access (Only you / Anyone with the link), the public link and Copy, the
 * layers it includes with how much each holds, the Live line, Expires, and how often it was opened
 * with Preview. Every change is saved as it is made — Done only closes. Turning a link off asks
 * first, since whoever has it loses it at once, and turning it on again makes a new one.
 * docs/share-links-design.md §2, §3, §8; docs/mocks/share-links/03-share-dialog.
 */
export function ShareModal({
  open,
  onClose,
  kind,
  rootId,
}: {
  open: boolean;
  onClose: () => void;
  kind: ShareRootKind;
  rootId: string;
}) {
  const spec = ROOT_KINDS[kind];
  const message = useToast();
  const qc = useQueryClient();
  const key = shareLinkQueryKey(kind, rootId);
  const shareQ = useQuery({ queryKey: key, queryFn: () => getShareLink(kind, rootId), enabled: open && !!spec });
  const [confirmOff, setConfirmOff] = useState(false);
  const [copied, setCopied] = useState(false);
  // The duration picked in this sitting, so Expires can say "7 days" rather than only the date.
  const [expiryChoice, setExpiryChoice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirmOff(false);
      setCopied(false);
      setExpiryChoice(null);
    }
  }, [open]);

  // Settings → Shared links (exactly that key: this dialog's own read is under the same prefix, and
  // the write just answered with what it would re-read), and wherever the root shows it is shared.
  const refreshShown = () => {
    void qc.invalidateQueries({ queryKey: ['share-links'], exact: true });
    for (const shown of spec?.shows ?? []) void qc.invalidateQueries({ queryKey: shown });
  };
  const putMut = useMutation({
    mutationFn: (body: Parameters<typeof putShareLink>[2]) => putShareLink(kind, rootId, body),
    onSuccess: (link) => {
      qc.setQueryData(key, (old: Awaited<ReturnType<typeof getShareLink>> | undefined) => ({ ...old, link }));
      refreshShown();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const offMut = useMutation({
    mutationFn: () => turnOffShareLink(kind, rootId),
    onSuccess: () => {
      qc.setQueryData(key, (old: Awaited<ReturnType<typeof getShareLink>> | undefined) => ({ ...old, link: null }));
      setConfirmOff(false);
      setCopied(false);
      setExpiryChoice(null);
      refreshShown();
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (!spec) return null;

  // A link past its expiry that nobody has settled yet reads as the ended link it is.
  const link: ShareLink | null = shareQ.data?.link && shareQ.data.link.state !== 'ENDED' ? shareQ.data.link : null;
  const counts = shareQ.data?.counts;
  const busy = putMut.isPending || offMut.isPending;

  const copy = (text: string, done: string) => {
    void copyText(text).then((ok) => {
      if (!ok) {
        message.error('Could not copy');
        return;
      }
      message.success(done);
      if (link && text === publicLinkUrl(link.token)) setCopied(true);
    });
  };

  const access = (
    <Popconfirm
      open={confirmOff}
      onOpenChange={(next) => {
        if (!next) setConfirmOff(false);
      }}
      title={TURN_OFF_TITLE}
      description={TURN_OFF_DETAIL}
      okText="Turn off"
      okButtonProps={{ danger: true, loading: offMut.isPending }}
      cancelText="Cancel"
      placement="bottomLeft"
      onConfirm={() => offMut.mutate()}
      onCancel={() => setConfirmOff(false)}
    >
      <div className="share-access">
        <span className={`share-access-icon${link ? ' is-public' : ''}`} aria-hidden>
          {link ? <GlobalOutlined /> : <LockOutlined />}
        </span>
        <div className="share-access-main">
          <Dropdown
            trigger={['click']}
            disabled={busy}
            menu={{
              className: 'share-access-menu',
              selectedKeys: [link ? 'public' : 'private'],
              items: [
                {
                  key: 'private',
                  icon: <LockOutlined />,
                  label: (
                    <AccessOption
                      title="Only you"
                      detail="Turns the link off. Turning it on again makes a new link."
                      chosen={!link}
                    />
                  ),
                },
                {
                  key: 'public',
                  icon: <GlobalOutlined />,
                  label: <AccessOption title="Anyone with the link" detail="No sign-in needed to view." chosen={!!link} />,
                },
              ],
              onClick: ({ key: choice }) => {
                if (choice === 'public' && !link) putMut.mutate({});
                if (choice === 'private' && link) setConfirmOff(true);
              },
            }}
          >
            <button type="button" className="share-access-select" aria-label="Access">
              {link ? 'Anyone with the link' : 'Only you'} <DownOutlined className="share-access-caret" />
            </button>
          </Dropdown>
          <div className="share-access-detail">
            {link
              ? spec.publicDetail
              : 'Only you can open it, signed in. Choose “Anyone with the link” to make a public link.'}
          </div>
        </div>
      </div>
    </Popconfirm>
  );

  const expiry = link?.expiresAt ?? null;
  const expiryValue = expiryChoice ?? (expiry ? 'until' : 'never');

  return (
    <Modal open={open} onCancel={onClose} title={spec.title} footer={null} width={520} className="share-dialog">
      {shareQ.isPending ? (
        <div className="share-dialog-state">
          <Spin />
        </div>
      ) : shareQ.isError ? (
        <div className="share-dialog-state">
          Couldn’t load this link: {shareQ.error.message}{' '}
          <Button size="small" onClick={() => void shareQ.refetch()}>
            Retry
          </Button>
        </div>
      ) : !link ? (
        <>
          {access}
          <div className="share-dialog-foot">
            <span className="share-dialog-stat">
              Copy link <span className="share-dialog-muted">— the signed-in link, for yourself</span>
            </span>
            <Button
              icon={<LinkOutlined />}
              onClick={() => copy(`${window.location.origin}${spec.appPath(rootId)}`, 'Link copied')}
            >
              Copy link
            </Button>
          </div>
        </>
      ) : (
        <>
          {access}
          <div className="share-dialog-url">
            <input
              className="share-dialog-url-input"
              readOnly
              aria-label="Public link"
              value={publicLinkUrl(link.token)}
              onFocus={(e) => e.target.select()}
            />
            <Button
              type="primary"
              icon={copied ? <CheckOutlined /> : <CopyOutlined />}
              onClick={() => copy(publicLinkUrl(link.token), 'Link copied')}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>

          <div className="share-dialog-label">Includes</div>
          <div className="share-layers">
            {spec.layers.map((row) => {
              const on = row.layer === null || link.include[row.layer] !== false;
              // Under a layer that is off, this one shares nothing whatever it says: greyed out.
              const idle = row.under !== undefined && link.include[row.under] === false;
              const detail = typeof row.detail === 'function' ? row.detail(counts) : row.detail;
              return (
                <div
                  key={row.name}
                  className={`share-layer${row.under ? ' is-nested' : ''}${idle ? ' is-idle' : ''}`}
                  data-layer={row.layer ?? 'overview'}
                >
                  <Checkbox
                    className="share-layer-check"
                    checked={on}
                    disabled={row.layer === null || busy || idle}
                    onChange={(e) => {
                      const layer = row.layer;
                      if (layer) putMut.mutate({ include: { [layer]: e.target.checked } });
                    }}
                  >
                    <span className="share-layer-name">{row.name}</span>
                    <span className={`share-layer-detail${row.warn && on && !idle ? ' is-warn' : ''}`}>{detail}</span>
                  </Checkbox>
                  <span className="share-layer-count">{counts ? row.count(counts) : ''}</span>
                </div>
              );
            })}
          </div>

          <div className="share-dialog-row">
            <span className="share-dialog-key">Updates</span>
            <span className="share-dialog-live">
              <i aria-hidden />
              Live — viewers see changes as they happen
            </span>
          </div>
          <div className="share-dialog-row">
            <span className="share-dialog-key">Expires</span>
            <Select
              size="small"
              aria-label="Expires"
              className="share-dialog-expiry"
              popupMatchSelectWidth={false}
              disabled={busy}
              value={expiryValue}
              options={EXPIRY_CHOICES.map(({ value, label }) => ({ value, label }))}
              // A link reopened with an expiry has no duration any more, only the day it stops.
              labelRender={({ value, label }) => (value === 'until' && expiry ? `Until ${shortDate(expiry)}` : label)}
              onChange={(value: string) => {
                const days = EXPIRY_CHOICES.find((choice) => choice.value === value)?.days ?? null;
                setExpiryChoice(value);
                putMut.mutate({
                  expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
                });
              }}
            />
            {expiry && expiryValue !== 'until' && (
              <span className="share-dialog-hint">Stops working {shortDate(expiry)}</span>
            )}
          </div>

          <div className="share-dialog-foot">
            <span className="share-dialog-stat">{viewsLine(link, Date.now())}</span>
            {/* The owner looking at their own link before handing it out is not a visit (?preview=1). */}
            <Button href={previewUrl(link.token)} target="_blank" rel="noopener noreferrer">
              Preview ↗
            </Button>
            <Button type="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function AccessOption({ title, detail, chosen }: { title: string; detail: string; chosen: boolean }) {
  return (
    <span className="share-access-option">
      <span className="share-access-option-text">
        <span className="share-access-option-title">{title}</span>
        <span className="share-access-option-detail">{detail}</span>
      </span>
      {chosen && <CheckOutlined className="share-access-option-check" />}
    </span>
  );
}
