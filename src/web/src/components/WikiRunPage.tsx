import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CloseOutlined, DownOutlined, MessageOutlined, RollbackOutlined, SyncOutlined } from '@ant-design/icons';
import { App, Button, Dropdown } from 'antd';
import type { WikiRejectReason } from '@orbit/shared';
import { relTime } from './Transcript';
import { WikiDot, WikiTrustBadge } from './WikiMarks';
import { wikiChangesetQuery } from '../lib/queries';
import {
  WIKI_REJECT_MENU,
  WIKI_REVIEW_REJECT,
  wikiEntryPath,
  wikiShowMore,
  WIKI_SHOW_LESS,
  type WikiEntry,
} from '../lib/wiki';
import {
  WIKI_CANCEL,
  WIKI_OPEN_SESSION,
  WIKI_ORIGIN_WORDS,
  WIKI_REJECTED,
  WIKI_REJECT_ON_RECORD,
  WIKI_REVERTED,
  WIKI_REVERT_KEEPS,
  WIKI_REVERT_RUN,
  WIKI_REVERT_RUN_CONFIRM,
  WIKI_REVERT_TITLE,
  WIKI_RUN_ADDED,
  WIKI_RUN_AMENDED,
  WIKI_RUN_REINFORCED,
  WIKI_VIEW_RUN,
  wikiAppliedChanges,
  wikiEntryAnswerable,
  wikiRevertBody,
  wikiRunCounts,
  wikiRunKicker,
  wikiRunPath,
  wikiRunSummary,
  wikiRunWhen,
  type WikiRunRow,
  type WikiRunSummary,
} from '../lib/wikiReviewMode';
import { useToast } from '../lib/toast';
import { rejectWikiEntry, revertWikiChangeset, useWikiWrite } from '../lib/wikiWrites';

/**
 * One run (mock 17 ⑧, 18 ④): what a maintenance run, an import or a session's proposal applied at
 * once, as a drawer over the Wiki home — who it was and when, Revert run… and the session behind it,
 * what it counted, and its entries grouped Added / Amended / Reinforced.
 *
 * READ BY ITS OWN ID (`GET /api/wiki/changesets/:id`), whether or not anything of it still waits in
 * Review: the read carries the entries its ops name, what it did counted, and whether Revert run…
 * would take anything back — which the server works out by the revert's own rules.
 */
export function WikiRunDrawer({
  spaceSlug,
  changesetId,
  onClose,
}: {
  spaceSlug: string;
  changesetId: string;
  onClose: () => void;
}) {
  const read = useQuery(wikiChangesetQuery(changesetId));
  const changeset = read.data ?? null;
  const byId = useMemo(() => new Map((changeset?.entries ?? []).map((entry) => [entry.id, entry])), [changeset]);
  const summary = useMemo(() => (changeset ? wikiRunSummary(changeset) : null), [changeset]);
  const navigate = useNavigate();
  const revert = useRevertRun(spaceSlug);

  if (!changeset || !summary) {
    return (
      <aside className="wk-drawer" aria-label={WIKI_VIEW_RUN} aria-busy={read.isPending}>
        <div className="tdp-head">
          <div className="tdp-head-main" />
          <Button type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close" />
        </div>
      </aside>
    );
  }

  return (
    <aside className="wk-drawer wk-run" aria-label={wikiAppliedChanges(summary.applied)}>
      <div className="tdp-head">
        <div className="tdp-head-main">
          <div className="wk-dkind">
            <SyncOutlined />
            {wikiRunKicker(changeset.origin)}
          </div>
          <div className="tdp-title">{wikiAppliedChanges(summary.applied)}</div>
          <div className="wk-run-meta">{wikiRunWhen(changeset.createdAt)}</div>
        </div>
        <Button type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close" />
      </div>
      <div className="wk-run-actions">
        <Button
          danger
          icon={<RollbackOutlined />}
          disabled={!summary.revertible}
          onClick={() => revert(changeset.id, summary)}
        >
          {WIKI_REVERT_RUN}
        </Button>
        {changeset.sessionId && (
          <Button
            icon={<MessageOutlined />}
            onClick={() => navigate(`/sessions/${encodeURIComponent(changeset.sessionId!)}`)}
          >
            {WIKI_OPEN_SESSION}
          </Button>
        )}
      </div>
      <div className="wk-run-counts">
        {wikiRunCounts(summary).map((part) => (
          <span key={part}>{part}</span>
        ))}
      </div>
      <RunGroup title={WIKI_RUN_ADDED} rows={summary.added} spaceSlug={spaceSlug} entries={byId} />
      <RunGroup title={WIKI_RUN_AMENDED} rows={summary.amended} spaceSlug={spaceSlug} entries={byId} />
      <RunGroup title={WIKI_RUN_REINFORCED} rows={summary.reinforced} spaceSlug={spaceSlug} entries={byId} />
    </aside>
  );
}

/** How many rows a group shows before `Show N more`. */
const RUN_GROUP_SHOWN = 4;

/** One of the run's three groups: its title and count, and a row per entry. Empty groups are left out. */
function RunGroup({
  title,
  rows,
  spaceSlug,
  entries,
}: {
  title: string;
  rows: WikiRunRow[];
  spaceSlug: string;
  entries: ReadonlyMap<string, WikiEntry>;
}) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, RUN_GROUP_SHOWN);
  return (
    <section className="tdp-section">
      <div className="tdp-section-title">
        {title}
        <span className="c">{rows.length}</span>
      </div>
      <div className="wk-run-rows">
        {shown.map((row) => (
          <RunRow key={row.op.id} row={row} spaceSlug={spaceSlug} entry={row.entryId ? entries.get(row.entryId) : undefined} />
        ))}
      </div>
      {rows.length > RUN_GROUP_SHOWN && (
        <button type="button" className="wk-more" onClick={() => setAll(!all)}>
          {all ? WIKI_SHOW_LESS : wikiShowMore(rows.length - RUN_GROUP_SHOWN)}
        </button>
      )}
    </section>
  );
}

/** One entry of the run: its title and one line, its mark — and, on a pointer, Reject on hover. */
function RunRow({ row, spaceSlug, entry }: { row: WikiRunRow; spaceSlug: string; entry: WikiEntry | undefined }) {
  const reject = useRejectEntry();
  const answerable = entry ? wikiEntryAnswerable(entry) : false;
  return (
    <div className="wk-run-row">
      <div className="main">
        <div className="t">
          {row.entryId ? <Link to={wikiEntryPath(spaceSlug, row.entryId)}>{row.title}</Link> : row.title}
        </div>
        {row.summary && <div className="d">{row.summary}</div>}
      </div>
      {row.trust && <WikiTrustBadge trust={row.trust} />}
      {answerable && row.entryId && (
        <WikiRejectMenu onReject={(reason) => reject(row.entryId!, reason)}>
          <button type="button" className="wk-run-reject">
            {WIKI_REVIEW_REJECT}
          </button>
        </WikiRejectMenu>
      )}
    </div>
  );
}

/**
 * Reject's reason menu: the four reasons Review's cards offer, and under them where the reason goes.
 * An entry has no session to send it back to, so it goes on the record.
 */
export function WikiRejectMenu({
  onReject,
  children,
}: {
  onReject: (reason: WikiRejectReason) => void;
  children: React.ReactElement;
}) {
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: [
          ...WIKI_REJECT_MENU.map(({ reason, label }) => ({ key: reason, label })),
          { type: 'divider' as const },
          { key: 'foot', label: <span className="wk-menu-foot">{WIKI_REJECT_ON_RECORD}</span>, disabled: true },
        ],
        onClick: ({ key }) => {
          if (key !== 'foot') onReject(key as WikiRejectReason);
        },
      }}
    >
      {children}
    </Dropdown>
  );
}

/** Reject an entry a review mode applied, with a reason, and say what happened. */
export function useRejectEntry() {
  const write = useWikiWrite((body: { entryId: string; reason: WikiRejectReason }) =>
    rejectWikiEntry(body.entryId, body.reason),
  );
  const toast = useToast();
  return async (entryId: string, reason: WikiRejectReason) => {
    try {
      await write.mutateAsync({ entryId, reason });
      toast.success(WIKI_REJECTED);
    } catch (error) {
      toast.error("Couldn't reject the entry", error instanceof Error ? error.message : undefined);
    }
  };
}

/**
 * Revert run…: the confirm that says what will happen — the server's own count of what the revert
 * undoes — then the revert, and back to the space the run was opened from.
 */
export function useRevertRun(spaceSlug: string) {
  const { modal } = App.useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const write = useWikiWrite((changesetId: string) => revertWikiChangeset(changesetId));
  return (changesetId: string, summary: Pick<WikiRunSummary, 'revertAdds' | 'revertAmends'>) => {
    modal.confirm({
      title: WIKI_REVERT_TITLE,
      content: (
        <div className="wk-revert-body">
          <p>{wikiRevertBody(summary)}</p>
          <p>{WIKI_REVERT_KEEPS}</p>
        </div>
      ),
      okText: WIKI_REVERT_RUN_CONFIRM,
      okButtonProps: { danger: true },
      cancelText: WIKI_CANCEL,
      onOk: async () => {
        try {
          await write.mutateAsync(changesetId);
          toast.success(WIKI_REVERTED);
          navigate(`/wiki/${spaceSlug}`);
        } catch (error) {
          toast.error("Couldn't revert the run", error instanceof Error ? error.message : undefined);
        }
      },
    });
  };
}

/**
 * A run in Recently changed: who it was, then what it applied and with which marks, then — with a
 * pointer — View run and Revert run… under it. On a phone the row itself is the way in (mock 12 ②).
 *
 * The row names the run by the changeset its items came in and reads it by that id, the read its page
 * shares; until the read answers, the title counts the changes the feed holds of it.
 */
export function WikiRunTimelineRow({
  changesetId,
  origin,
  at,
  changes,
  spaceSlug,
}: {
  changesetId: string;
  origin: string;
  at: string;
  /** How many of the run's changes the feed holds, for the title before the run's read answers. */
  changes: number;
  spaceSlug: string;
}) {
  const read = useQuery(wikiChangesetQuery(changesetId));
  const summary = useMemo(() => (read.data ? wikiRunSummary(read.data) : null), [read.data]);
  const revert = useRevertRun(spaceSlug);
  const counts = summary ? wikiRunCounts(summary) : [];
  return (
    <li className="wk-tl-run">
      <WikiDot tone="green" />
      <div>
        <div className="wk-tl-h">
          <b>{WIKI_ORIGIN_WORDS[origin] ?? origin}</b>
          <span className="when">{relTime(at)}</span>
        </div>
        <div className="wk-tl-t">
          <Link to={wikiRunPath(spaceSlug, changesetId)}>{wikiAppliedChanges(summary?.applied ?? changes)}</Link>
        </div>
        {counts.length > 0 && <div className="wk-tl-n">{counts.join(' · ')}</div>}
        <div className="wk-tl-acts">
          <Link to={wikiRunPath(spaceSlug, changesetId)}>{WIKI_VIEW_RUN}</Link>
          {summary?.revertible && (
            <button type="button" className="danger" onClick={() => revert(changesetId, summary)}>
              {WIKI_REVERT_RUN}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** A reject button that opens the reason menu — the drawer's and the run rows' one control. */
export function WikiRejectButton({ onReject, size }: { onReject: (reason: WikiRejectReason) => void; size?: 'small' }) {
  return (
    <WikiRejectMenu onReject={onReject}>
      <Button danger size={size}>
        {WIKI_REVIEW_REJECT}
        <DownOutlined />
      </Button>
    </WikiRejectMenu>
  );
}
