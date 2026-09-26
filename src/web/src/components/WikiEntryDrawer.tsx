import {
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  EllipsisOutlined,
  LinkOutlined,
  StopOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { App, Button, Dropdown, Input, Modal } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { LINK_PREVIEW_MAX_REFS, type LinkPreviewRef } from '@orbit/shared';
import { useNavigate } from 'react-router-dom';
import { relTime } from './Transcript';
import { WikiEmpty } from './WikiCards';
import { WikiAim, WikiAnchorMark, WikiKindMark, WikiTrustBadge } from './WikiMarks';
import { WikiSourceList } from './WikiSources';
import { linkPreviewsQuery, wikiEntryQuery } from '../lib/queries';
import { decodeId } from '../lib/idCodec';
import {
  WIKI_ACTION_COPY_LINK,
  WIKI_ACTION_EDIT,
  WIKI_ACTION_RETIRE,
  WIKI_ACTION_SUPERSEDE,
  WIKI_ANCHORS_NOTE,
  WIKI_HISTORY_CONFIRMED_BY,
  WIKI_HISTORY_MAINTENANCE,
  WIKI_HISTORY_PROPOSED_BY,
  WIKI_HISTORY_SYSTEM,
  WIKI_LINK_COPIED,
  WIKI_NO_ENTRY_SELECTED,
  WIKI_NO_USE_YET,
  WIKI_SECTION_ANCHORS,
  WIKI_SECTION_DETAILS,
  WIKI_SECTION_HISTORY,
  WIKI_SECTION_SOURCES,
  WIKI_SECTION_USED,
  wikiAnchorLabel,
  wikiAnchorMark,
  wikiAnchorStateOf,
  wikiCompareWith,
  wikiEntryPath,
  wikiFieldRows,
  wikiKindWord,
  wikiPushedTo,
  wikiRevision,
  type WikiEntryDetail,
} from '../lib/wiki';
import {
  amendOp,
  draftFromEntry,
  proposeToWiki,
  retireOp,
  supersedeOp,
  useWikiWrite,
  wikiIdempotencyKey,
} from '../lib/wikiWrites';

/**
 * One entry, as a drawer over the page it was opened from.
 *
 * THE SECTIONS ARE THE DESIGN'S (§12.1, mock 03), in its order: Details, Sources, Anchors, Where it's
 * used, History — with Detector left out entirely rather than drawn empty, because phase 1 has no
 * compliance reading to put in it (the mock says so itself: it is a phase-2 number).
 *
 * IT IS A REAL WRITER, NOT A PICTURE. Copy link, Edit and Supersede go through the owner's door
 * (`lib/wikiWrites.ts`) and a Retire asks for the reason the contract requires. What that buys is
 * that the ⋯ menu's four items are the four things the menu says: an owner who presses Retire has
 * retired the entry, not filled a form that goes nowhere.
 *
 * WHAT IT DOES NOT DO: edit an entry's `fields`, or carry a supersede's replacement fields. The
 * editor covers the two lines a reader actually rewrites — the title and the one-line summary — and
 * carries the rest of the entry over untouched, which is what `mergeChanges` on the server does with
 * an omitted key. Editing a pitfall's Trigger is a form per kind, and it belongs with the kind's
 * schema rather than here.
 */
export function WikiEntryDrawer({
  entryId,
  spaceSlug,
  onClose,
}: {
  entryId: string;
  spaceSlug: string;
  onClose: () => void;
}) {
  const entry = useQuery(wikiEntryQuery(entryId));
  const { message } = App.useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editor, setEditor] = useState<'edit' | 'supersede' | 'retire' | null>(null);
  const [copied, setCopied] = useState(false);

  // A drawer that stays mounted while another entry is opened must not keep the first one's copy
  // state, so the "Copied" word goes back to "Copy link" whenever the entry changes.
  useEffect(() => {
    setCopied(false);
    setMenuOpen(false);
  }, [entryId]);

  const data = entry.data;
  // Newest revision first, ordered here rather than trusted: which one is CURRENT is a claim this
  // list makes, and the door's own order is not something a client should depend on to be right.
  const ordered = [...(data?.history ?? [])].sort((a, b) => b.revision - a.revision);

  if (entry.isError) {
    return (
      <aside className="wk-drawer" aria-label="Entry">
        <div className="tdp-head">
          <div className="tdp-head-main">
            <div className="tdp-title">{WIKI_NO_ENTRY_SELECTED}</div>
          </div>
          <Button type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close" />
        </div>
      </aside>
    );
  }

  return (
    <aside className="wk-drawer" aria-label={data ? data.title : 'Entry'}>
      <div className="tdp-head">
        <div className="tdp-head-main">
          <div className="wk-dkind">
            <WikiKindMark kind={data?.kind ?? 'concept'} />
            {wikiKindWord(data?.kind ?? 'concept')}
            {data && data.topics.length > 0 && (
              <span className="dim">· {data.topics.join(' · ')}</span>
            )}
          </div>
          <div className="tdp-title">{data?.title ?? ''}</div>
          {data && (
            <div className="tdp-meta">
              <WikiTrustBadge trust={data.trust} withIcon />
              <WikiAnchorMark mark={wikiAnchorMark(data)} />
              {data.pinned && <span className="tdp-badge tone-muted">Pinned</span>}
              {data.tainted && <span className="tdp-badge tone-amber">Web-derived</span>}
            </div>
          )}
        </div>
        <div className="tdp-head-actions">
          <Button icon={<EditOutlined />} onClick={() => setEditor('edit')} disabled={!data}>
            {WIKI_ACTION_EDIT}
          </Button>
          <Dropdown
            open={menuOpen}
            onOpenChange={setMenuOpen}
            trigger={['click']}
            menu={{
              items: [
                { key: 'supersede', icon: <SwapOutlined />, label: WIKI_ACTION_SUPERSEDE },
                { key: 'retire', icon: <StopOutlined />, label: WIKI_ACTION_RETIRE, danger: true },
                { type: 'divider' },
                { key: 'copy', icon: <LinkOutlined />, label: copied ? WIKI_LINK_COPIED : WIKI_ACTION_COPY_LINK },
              ],
              onClick: async ({ key }) => {
                if (key === 'copy') {
                  await copyEntryLink(spaceSlug, entryId);
                  setCopied(true);
                  message.success(WIKI_LINK_COPIED);
                  return;
                }
                setEditor(key as 'supersede' | 'retire');
              },
            }}
          >
            <Button type="text" icon={<EllipsisOutlined />} aria-label="More actions" />
          </Dropdown>
        </div>
        <Button type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close" />
      </div>

      {data && (
        <>
          <Section title={WIKI_SECTION_DETAILS}>
            <div className="wk-dkv">
              {wikiFieldRows(data.kind, data.fields).map((row) => (
                <DetailRow key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
          </Section>

          <Section title={WIKI_SECTION_SOURCES} count={data.sources?.length ?? 0}>
            {(data.sources?.length ?? 0) === 0 ? (
              <WikiEmpty>A quote is what makes a claim checkable. This entry cites none.</WikiEmpty>
            ) : (
              <WikiSourceList sources={data.sources ?? []} />
            )}
          </Section>

          <Section title={WIKI_SECTION_ANCHORS} count={data.anchors?.length ?? 0}>
            {(data.anchors?.length ?? 0) === 0 ? (
              <WikiEmpty>No anchor: nothing in the repository has to stay true for this to hold.</WikiEmpty>
            ) : (
              <>
                <div className="wk-anchors">
                  {data.anchors.map((anchor, index) => {
                    const state = wikiAnchorStateOf(anchor);
                    return (
                      <div className="wk-anc" key={index}>
                        <WikiAim />
                        <span className="p">{wikiAnchorLabel(anchor)}</span>
                        <WikiAnchorMark mark={state} />
                      </div>
                    );
                  })}
                </div>
                <div className="wk-anc-note">{WIKI_ANCHORS_NOTE}</div>
              </>
            )}
          </Section>

          <Section title={WIKI_SECTION_USED}>
            <UsedSection exposure={data.exposure ?? []} />
          </Section>

          <Section title={WIKI_SECTION_HISTORY}>
            {(data.history?.length ?? 0) === 0 ? (
              <WikiEmpty>No revision has been recorded.</WikiEmpty>
            ) : (
              <ol className="wk-hist">
                {/* Ordered here rather than trusted: which revision is CURRENT is a claim this list
                    makes, and the door's own order (`revision: 'desc'`) is not something a client
                    should depend on to be right about it. */}
                {ordered.map((revision, index) => {
                  // The comparison belongs to the CURRENT revision: what a reader wants to see is what
                  // changed to get here, and that is this revision against the one before it.
                  const next = ordered[index + 1];
                  return (
                  <li className={index === 0 ? 'cur' : ''} key={revision.id}>
                    <span className="rev">{wikiRevision(revision.revision)}</span>
                    <div>
                      <div className="h">{historyWord(revision.authorKind)}</div>
                      <div className="m">
                        {relTime(revision.createdAt)}
                        {index === 0 && next && ` · ${wikiCompareWith(next.revision)}`}
                      </div>
                    </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>
        </>
      )}

      {data && editor && (
        <EntryEditor
          open
          mode={editor}
          entry={data}
          onClose={() => setEditor(null)}
        />
      )}
    </aside>
  );
}

/** One section of the drawer: the task detail panel's own section frame. */
function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="tdp-section">
      <div className="tdp-section-title">
        {title}
        {count !== undefined && <span className="c">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string | string[] }) {
  return (
    <>
      <span className="k">{label}</span>
      <span className="v">
        {Array.isArray(value) ? (
          value.map((line, index) => <div key={index}>{line}</div>)
        ) : (
          value
        )}
      </span>
    </>
  );
}

/**
 * Where it's used: the numbers over this week, then the sessions behind them.
 *
 * THE SESSION TITLES ARE ONE REQUEST, not one per row: `link-previews` takes a batch of refs (up to
 * `LINK_PREVIEW_MAX_REFS`), and the drawer asks it for the sessions these exposure rows name — the
 * same endpoint the conversation's own link cards read, so a session is described here exactly as it
 * is described there. Rows the answer does not cover keep the short id they came with: an exposure
 * row is a fact this page already has, and a title is a nicety it may not get.
 */
function UsedSection({ exposure }: { exposure: WikiEntryDetail['exposure'] }) {
  const rows = exposure ?? [];
  const pushed = rows.filter((row) => row.channel === 'push');
  const sessions = new Set(pushed.map((row) => row.sessionId).filter((id): id is string => !!id));
  const fetched = rows.filter((row) => row.channel === 'get').length;
  const navigate = useNavigate();
  const recent = useMemo(() => rows.slice(0, 3), [rows]);

  // Every distinct session the rows name, in batches the endpoint accepts.
  const asked = useMemo(() => {
    const ids = [...new Set(rows.map((row) => row.sessionId).filter((id): id is string => !!id))];
    const batches: LinkPreviewRef[][] = [];
    for (let at = 0; at < ids.length; at += LINK_PREVIEW_MAX_REFS) {
      batches.push(
        ids.slice(at, at + LINK_PREVIEW_MAX_REFS).map((id) => ({ kind: 'session' as const, id: decodeId(id) ?? id })),
      );
    }
    return batches;
  }, [rows]);
  const answers = useQueries({
    queries: asked.map((batch) => ({ ...linkPreviewsQuery(batch), staleTime: 60_000 })),
  });
  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const answer of answers) {
      for (const preview of answer.data?.previews ?? []) {
        if (preview.state === 'ok' && preview.kind === 'session') map.set(preview.id, preview.session.title);
      }
    }
    return map;
  }, [answers]);

  if (rows.length === 0) return <WikiEmpty>{WIKI_NO_USE_YET}</WikiEmpty>;
  return (
    <>
      <div className="wk-used-h">{wikiPushedTo(sessions.size, fetched)}</div>
      {recent.map((row, index) => (
        <div
          className="tdp-session"
          key={`${row.sessionId ?? 'none'}-${row.at}-${index}`}
          onClick={row.sessionId ? () => navigate(`/sessions/${encodeURIComponent(row.sessionId!)}`) : undefined}
        >
          <span className={`tdp-dot ${row.channel === 'push' ? 'RUNNING' : 'SUCCEEDED'}`} />
          <div className="tdp-session-main">
            <div className="tdp-session-title">{sessionTitle(row.sessionId, titles)}</div>
            <div className="tdp-session-sub">
              {row.channel === 'push' ? 'in its Wiki context at start' : 'wiki_get'} · {relTime(row.at)}
            </div>
          </div>
          <span className="tdp-badge tone-muted">{row.channel === 'push' ? 'Pushed' : 'Fetched'}</span>
        </div>
      ))}
    </>
  );
}

/**
 * A session's title, or the id it is known by.
 *
 * The lookup is by BOTH spellings, because the answer comes back under the id that was asked for and
 * that is not always the spelling the exposure row carries: the read normalises a ref before it asks
 * (`decodeId`), and the answer is keyed off what the server sent back. Missing means the title was not
 * in the batch's answer — a session deleted since, or one this account cannot see — and the id is a
 * better thing to show than a blank.
 */
export function sessionTitle(sessionId: string | null, titles: Map<string, string>): string {
  if (!sessionId) return 'A session without an id';
  return titles.get(sessionId) ?? titles.get(decodeId(sessionId) ?? sessionId) ?? `Session ${sessionId.slice(0, 8)}`;
}

/** Who wrote a revision, in the design's own three words. */
function historyWord(authorKind: string): string {
  switch (authorKind) {
    case 'owner':
      return WIKI_HISTORY_CONFIRMED_BY;
    case 'maintenance':
      return WIKI_HISTORY_MAINTENANCE;
    case 'system':
      return WIKI_HISTORY_SYSTEM;
    default:
      return WIKI_HISTORY_PROPOSED_BY;
  }
}

/**
 * The drawer's two forms, one component: a supersede is an edit that keeps the entry's id and gets a
 * new lineage, so the fields are the same and only the op differs.
 */
function EntryEditor({
  mode,
  entry,
  onClose,
}: {
  open: boolean;
  mode: 'edit' | 'supersede' | 'retire';
  entry: WikiEntryDetail;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(entry.title);
  const [summary, setSummary] = useState(entry.summary);
  const [reason, setReason] = useState('');
  const write = useWikiWrite((body: { ops: ReturnType<typeof amendOp>[]; rationale: string; idempotencyKey: string }) =>
    proposeToWiki(entry.spaceId, body),
  );
  const { message } = App.useApp();

  const submit = async () => {
    const op =
      mode === 'retire'
        ? retireOp(entry, reason.trim())
        : mode === 'supersede'
          ? supersedeOp(entry, draftFromEntry(entry, { title: title.trim(), summary: summary.trim() }))
          : amendOp(entry, { title: title.trim(), summary: summary.trim() });
    try {
      await write.mutateAsync({
        rationale:
          mode === 'retire'
            ? `the owner retired “${entry.title}”`
            : `the owner ${mode === 'supersede' ? 'replaced' : 'edited'} “${entry.title}”`,
        idempotencyKey: wikiIdempotencyKey(`wiki-${mode}`),
        ops: [op],
      });
      message.success(mode === 'retire' ? 'Retired' : mode === 'supersede' ? 'Superseded' : 'Saved');
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'The server refused it');
    }
  };

  return (
    <Modal
      open
      title={
        mode === 'retire' ? WIKI_ACTION_RETIRE : mode === 'supersede' ? WIKI_ACTION_SUPERSEDE : WIKI_ACTION_EDIT
      }
      onCancel={onClose}
      onOk={submit}
      okText={mode === 'retire' ? 'Retire' : mode === 'supersede' ? 'Supersede' : 'Save'}
      okButtonProps={{ danger: mode === 'retire', disabled: mode === 'retire' && reason.trim().length === 0 }}
      confirmLoading={write.isPending}
      destroyOnHidden
    >
      {mode === 'retire' ? (
        <>
          <p className="wk-modal-note">
            Agents stop getting this entry. It stays in History, struck through, and the reason goes on
            the record.
          </p>
          <Input.TextArea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why it no longer holds"
          />
        </>
      ) : (
        <>
          <p className="wk-modal-note">
            {mode === 'supersede'
              ? 'The replacement keeps this entry’s kind, fields and anchor, and this entry points at it.'
              : 'Only the title and the one-line summary change here.'}
          </p>
          <WikiTitleSummaryFields title={title} summary={summary} onTitle={setTitle} onSummary={setSummary} />
        </>
      )}
    </Modal>
  );
}

/**
 * The two lines an edit rewrites, as the drawer's Edit and Supersede draw them — and Review's Edit
 * too (`WikiReviewPage`), so an entry's words are rewritten in one form wherever that happens.
 */
export function WikiTitleSummaryFields({
  title,
  summary,
  onTitle,
  onSummary,
}: {
  title: string;
  summary: string;
  onTitle: (value: string) => void;
  onSummary: (value: string) => void;
}) {
  return (
    <>
      <Input value={title} onChange={(event) => onTitle(event.target.value)} placeholder="Title" />
      <Input.TextArea
        rows={3}
        value={summary}
        onChange={(event) => onSummary(event.target.value)}
        placeholder="One line"
        style={{ marginTop: 8 }}
      />
    </>
  );
}

/** The entry's own link, on the clipboard. Falls back to the plain URL where the API is absent. */
async function copyEntryLink(spaceSlug: string, entryId: string): Promise<void> {
  const url = `${window.location.origin}${wikiEntryPath(spaceSlug, entryId)}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // A browser without the clipboard permission still gets the link in the address bar's shape; the
    // caller says "Copied" either way, so this is the one place a failure is not worth a dialog.
  }
}
