import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CheckOutlined,
  DownOutlined,
  GlobalOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { App, Button, Dropdown } from 'antd';
import { relTime } from './Transcript';
import { WikiCard, WikiEmpty } from './WikiCards';
import { WikiAim } from './WikiMarks';
import { WikiSourceList } from './WikiSources';
import { wikiEntriesQuery, wikiEntryQuery, wikiReviewQuery, wikiSpacesQuery } from '../lib/queries';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import {
  WIKI_ACCEPT_NOTE,
  WIKI_AFTER_RETIRE,
  WIKI_ALWAYS_ASKS,
  WIKI_ALWAYS_ASKS_NOTE,
  WIKI_AUTO_ACCEPT,
  WIKI_AUTO_ACCEPT_HINT,
  WIKI_CHALLENGE,
  WIKI_CHALLENGE_NOTE,
  WIKI_NEXT,
  WIKI_NO_REVIEW,
  WIKI_PREVIOUS,
  WIKI_REINFORCE,
  WIKI_REINFORCE_NOTE,
  WIKI_REJECT_MENU,
  WIKI_REVIEW_ACCEPT,
  WIKI_REVIEW_EDIT,
  WIKI_REVIEW_KEEP,
  WIKI_REVIEW_REJECT,
  WIKI_REVIEW_RETIRE,
  WIKI_REVIEW_TITLE,
  WIKI_SHOW_THE_PAGES,
  WIKI_SIMILAR_ENTRIES,
  WIKI_SIMILAR_NONE,
  WIKI_TAB_ADD,
  WIKI_TAB_ALL,
  WIKI_TAB_AMEND,
  WIKI_TAB_RETIRE,
  WIKI_TITLE,
  WIKI_WEB_DERIVED,
  WIKI_WEB_DERIVED_NOTE,
  wikiComparedWith,
  wikiFieldRows,
  wikiKindWord,
  wikiOfCount,
  wikiOldest,
  wikiOpPayload,
  wikiProposalsFrom,
  wikiTabOf,
  wikiWebDerivedWarning,
  wikiChangesDiff,
  type WikiChangeset,
  type WikiChangesetOp,
  type WikiSource,
} from '../lib/wiki';
import { decideWikiChangeset, useWikiWrite, type WikiDecision } from '../lib/wikiWrites';

/**
 * Review: the one place an agent's proposal becomes knowledge.
 *
 * ONE CARD PER OP, not per changeset. A session may propose up to five ops in one turn and they are
 * decided one at a time, so a card that carried a batch would make "Accept" mean "accept everything
 * in it" — the opposite of what the owner is being asked.
 *
 * THE BUTTONS ARE THE OWNER'S OWN WORDS, primary first: `Accept · Edit · Reject▾`. Below 600px the
 * app's own `.card-actions` rule turns that row into a full-width column with Accept on top — the
 * same treatment `ApprovalPanel` gets, because at that width the two cards are the same card.
 *
 * A REJECT MUST NAME A REASON. The four are the contract's, the reason goes back to the session that
 * proposed the op, and a rejection nobody can learn from is a proposal silently dropped.
 *
 * THE RED SIDE OF AN AMEND'S DIFF IS REAL. It comes from the entry the op names, read here for the
 * cards that show a diff and for no others: the op payload holds what the proposal would WRITE, and
 * what it would remove is the current revision's own value — which is a fact about the entry, not
 * about the proposal.
 */
export function WikiReviewPage({ spaceSlug }: { spaceSlug: string | null }) {
  // Handed down to every card: how many entries the proposal was compared against. Null when the
  // queue spans every space, because then there is no one corpus to name.
  const spaces = useQuery(wikiSpacesQuery());
  const spaceId = spaceSlug ? (spaces.data?.find((row) => row.slug === spaceSlug)?.id ?? null) : null;
  // With a space in the URL the queue is that space's; Review's own route has none and asks across
  // every space, which is a different question (and a different cache entry — see `lib/queries.ts`).
  const review = useQuery({
    ...wikiReviewQuery(spaceSlug ? spaceId : null),
    enabled: !spaceSlug || spaceId !== null,
  });
  const entries = useQuery({ ...wikiEntriesQuery(spaceSlug ? spaceId : null), enabled: spaceId !== null });

  const changesets = useMemo(() => review.data ?? [], [review.data]);
  const [tab, setTab] = useState<'all' | 'add' | 'amend' | 'retire'>('all');

  const pending = useMemo(
    () =>
      changesets.flatMap((changeset) =>
        changeset.ops.filter((op) => op.decision === 'pending').map((op) => ({ changeset, op })),
      ),
    [changesets],
  );
  const counts = useMemo(
    () => ({
      all: pending.length,
      add: pending.filter((row) => wikiTabOf(row.op.op) === 'add').length,
      amend: pending.filter((row) => wikiTabOf(row.op.op) === 'amend').length,
      retire: pending.filter((row) => wikiTabOf(row.op.op) === 'retire').length,
    }),
    [pending],
  );
  const shown = tab === 'all' ? pending : pending.filter((row) => wikiTabOf(row.op.op) === tab);
  // The phone shows one card at a time (design §12.1, mock 09): the same cards, the same words, one
  // per screen, with Previous / Next to move between them — because a phone has no hover, no room
  // for a queue, and iOS pages the same way, so the two clients read as one product.
  const phone = useMediaQuery(PHONE_QUERY);
  const [at, setAt] = useState(0);
  // Clamped rather than reset: deciding a card shortens the queue under the reader, and landing on
  // the next one is better than being thrown back to the first.
  const current = shown.length === 0 ? 0 : Math.min(at, shown.length - 1);
  const visible = phone ? shown.slice(current, current + 1) : shown;
  const sessions = new Set(changesets.map((changeset) => changeset.sessionId).filter(Boolean));
  const oldest = [...changesets].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]?.createdAt;

  return (
    <div className="rv-page">
      <div className="wk-crumb">
        <Link to={spaceSlug ? `/wiki/${spaceSlug}` : '/wiki'}>{WIKI_TITLE}</Link>
        <RightOutlined className="ic" />
        <span>{WIKI_REVIEW_TITLE}</span>
      </div>
      <div className="rv-head">
        <div>
          <h1 className="page-title">{WIKI_REVIEW_TITLE}</h1>
          <div className="rv-sub">
            {counts.all === 0
              ? WIKI_NO_REVIEW
              : `${wikiProposalsFrom(counts.all, sessions.size)}${
                  oldest ? ` · ${wikiOldest(relTime(oldest))}` : ''
                }`}
          </div>
        </div>
        <div className="wk-seg" role="tablist">
          {(
            [
              ['all', WIKI_TAB_ALL, counts.all],
              ['add', WIKI_TAB_ADD, counts.add],
              ['amend', WIKI_TAB_AMEND, counts.amend],
              ['retire', WIKI_TAB_RETIRE, counts.retire],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'on' : ''}
              onClick={() => setTab(key)}
            >
              {label}
              <b>{count}</b>
            </button>
          ))}
        </div>
      </div>

      <div className="rv-cols">
        <div className="rv-list">
          {phone && shown.length > 1 && (
            <div className="wk-pager">
              <Button disabled={current === 0} onClick={() => setAt(current - 1)} icon={<LeftOutlined />}>
                {WIKI_PREVIOUS}
              </Button>
              <span className="pos">
                {wikiOfCount(current + 1, shown.length)}
              </span>
              <Button disabled={current >= shown.length - 1} onClick={() => setAt(current + 1)}>
                {WIKI_NEXT}
                <RightOutlined />
              </Button>
            </div>
          )}
          {shown.length === 0 ? (
            <WikiCard title={WIKI_REVIEW_TITLE}>
              <WikiEmpty>{WIKI_NO_REVIEW}</WikiEmpty>
            </WikiCard>
          ) : (
            visible.map(({ changeset, op }) => (
              <ReviewCard
                key={op.id}
                changeset={changeset}
                op={op}
                comparedTo={entries.data ? entries.data.length : null}
              />
            ))
          )}
        </div>
        <div className="rv-rail">
          <WikiCard title={WIKI_AUTO_ACCEPT}>
            <div className="project-open-items-hint wk-review-sub">{WIKI_AUTO_ACCEPT_HINT}</div>
            <div className="aa-row first">
              <CheckOutlined className="ic" />
              <div>
                <b>{WIKI_REINFORCE}</b>
                <div className="d">{WIKI_REINFORCE_NOTE}</div>
              </div>
            </div>
            <div className="aa-row">
              <CheckOutlined className="ic" />
              <div>
                <b>{WIKI_CHALLENGE}</b>
                <div className="d">{WIKI_CHALLENGE_NOTE}</div>
              </div>
            </div>
            <div className="aa-ask">
              <b>{WIKI_ALWAYS_ASKS}</b> · {WIKI_ALWAYS_ASKS_NOTE}
            </div>
          </WikiCard>
        </div>
      </div>
    </div>
  );
}

/** One op, as a card the owner answers. */
function ReviewCard({
  changeset,
  op,
  comparedTo,
}: {
  changeset: WikiChangeset;
  op: WikiChangesetOp;
  /** How many entries `similar[]` was computed against, or null when the corpus is not known. */
  comparedTo: number | null;
}) {
  const payload = wikiOpPayload(op);
  const draft = (payload.entry ?? {}) as Record<string, unknown>;
  const changes = (payload.changes ?? {}) as Record<string, unknown>;
  const retire = op.op === 'retire';
  const diffed = !retire && Object.keys(changes).length > 0;
  // The entry this op is about, read for two reasons: what a proposal would REMOVE is a fact about
  // the entry rather than about the proposal (which is what makes the red lines real rather than
  // invented), and a retirement's own payload names nothing but a reason — the title it retires and
  // the kind it retires are the entry's.
  const target = useQuery({ ...wikiEntryQuery(op.entryId ?? null) });
  const kind = (draft.kind as string) ?? (target.data?.kind ?? null);
  const title =
    typeof draft.title === 'string' ? draft.title : (target.data?.title ?? null);
  const kindWord = kind ? wikiKindWord(kind) : WIKI_ENTRY_WORD;

  const write = useWikiWrite((decisions: WikiDecision[]) => decideWikiChangeset(changeset.id, decisions));
  const { message } = App.useApp();

  const decide = async (decision: WikiDecision) => {
    try {
      await write.mutateAsync([decision]);
      message.success(decision.action === 'reject' ? 'Rejected' : 'Decided');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'The server refused it');
    }
  };

  const sources = sourcesOf(op);
  const hunks = diffed
    ? wikiChangesDiff((target.data ?? {}) as Record<string, unknown>, changes)
    : [];

  return (
    <div className="approval-card wk-prop">
      <div className="approval-head">
        <WikiOpChip op={op.op} />
        <span className="kind">{kindWord}</span>
        <span className="by">
          · Proposed by{' '}
          {changeset.sessionId ? (
            <Link to={`/sessions/${encodeURIComponent(changeset.sessionId)}`}>
              {changeset.rationale ? shortRationale(changeset.rationale) : 'a session'}
            </Link>
          ) : (
            <span>{changeset.origin === 'owner' ? 'you' : WIKI_MAINTENANCE_WORD}</span>
          )}
        </span>
        <span className="age">{relTime(changeset.createdAt)}</span>
      </div>
      <div className="approval-body">
        {op.tainted && (
          <div className="wk-warn">
            <GlobalOutlined className="ic" />
            <span>
              <b>{WIKI_WEB_DERIVED}</b> · {wikiWebDerivedWarning()}
              <a href="#sources">{WIKI_SHOW_THE_PAGES}</a>
            </span>
          </div>
        )}
        <div className="wk-prop-t">
          {retire ? (
            <>
              {WIKI_REVIEW_RETIRE} <span className="q">“{title ?? WIKI_ENTRY_WORD}”</span>
            </>
          ) : (
            (title ?? WIKI_ENTRY_WORD)
          )}
        </div>

        <div className="wk-pkv">
          {retire ? (
            <>
              <span className="k">Reason</span>
              <span className="v">{typeof payload.reason === 'string' ? payload.reason : WIKI_ENTRY_WORD}</span>
              <span className="k">Evidence</span>
              <span className="v">{sources.length === 0 ? DASH : <WikiSourceList sources={sources} />}</span>
              <span className="k">After</span>
              <span className="v">{WIKI_AFTER_RETIRE}</span>
            </>
          ) : (
            <>
              {hunks.length > 0 ? (
                <span className="v wk-diff-cell">
                  <div className="chat-diff">
                    {hunks.map((hunk) => (
                      <div key={hunk.label}>
                        <div className="diff-hunk">{hunk.label}</div>
                        {hunk.lines.map((line, index) => (
                          <div
                            className={`diff-line ${line.sign === '+' ? 'diff-add' : 'diff-del'}`}
                            key={`${hunk.label}-${index}`}
                          >
                            <span className="diff-ln">{index + 1}</span>
                            <span className="diff-sign">{line.sign}</span>
                            <span className="diff-text">{line.text}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </span>
              ) : (
                kind &&
                wikiFieldRows(kind as never, draft.fields ?? target.data?.fields).map((row) => (
                  <Fragment key={row.label}>
                    <span className="k">{row.label}</span>
                    <span className="v">
                      {Array.isArray(row.value)
                        ? row.value.map((line, index) => <div key={index}>{line}</div>)
                        : row.value}
                    </span>
                  </Fragment>
                ))
              )}
              <span className="k">Sources</span>
              <span className="v">{sources.length === 0 ? DASH : <WikiSourceList sources={sources} />}</span>
              <span className="k">Anchors</span>
              <span className="v">
                {anchorsOf(draft, target.data?.anchors).length === 0 ? (
                  DASH
                ) : (
                  <div className="wk-anchors">
                    {anchorsOf(draft, target.data?.anchors).map((anchor, index) => (
                      <div className="wk-anc" key={index}>
                        <WikiAim />
                        <span className="p">{anchor}</span>
                      </div>
                    ))}
                  </div>
                )}
              </span>
              <span className="k">{WIKI_SIMILAR_ENTRIES}</span>
              <span className="v wk-none">
                {op.similar.length === 0 ? (
                  <>
                    {WIKI_SIMILAR_NONE}
                    {comparedTo !== null && <span className="dim"> · {wikiComparedWith(comparedTo)}</span>}
                  </>
                ) : (
                  op.similar.map((similar) => (
                    <div key={similar.id}>
                      {similar.title} <span className="dim">· {wikiKindWord(similar.kind)}</span>
                    </div>
                  ))
                )}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="card-actions approval-actions">
        {retire ? (
          <>
            <button
              type="button"
              className="card-action card-action--primary"
              onClick={() => decide({ opId: op.id, action: 'accept' })}
            >
              {WIKI_REVIEW_RETIRE}
            </button>
            <button
              type="button"
              className="card-action card-action--secondary"
              onClick={() => decide({ opId: op.id, action: 'reject', reason: 'not_true' })}
            >
              {WIKI_REVIEW_KEEP}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="card-action card-action--primary"
              onClick={() => decide({ opId: op.id, action: 'accept' })}
            >
              {WIKI_REVIEW_ACCEPT}
            </button>
            <button
              type="button"
              className="card-action card-action--secondary"
              onClick={() => decide({ opId: op.id, action: 'edit' })}
            >
              {WIKI_REVIEW_EDIT}
            </button>
            <Dropdown
              trigger={['click']}
              menu={{
                items: WIKI_REJECT_MENU.map(({ reason, label }) => ({ key: reason, label })),
                onClick: ({ key }) =>
                  decide({ opId: op.id, action: 'reject', reason: key as WikiDecision['reason'] }),
              }}
            >
              <button type="button" className="card-action card-action--secondary">
                {WIKI_REVIEW_REJECT}
                <DownOutlined className="ic" />
              </button>
            </Dropdown>
            <span className="grow" />
            <span className="note">{op.tainted ? WIKI_WEB_DERIVED_NOTE : WIKI_ACCEPT_NOTE}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** The op's chip, in the contract's own words. A supersede is the card's AMEND. */
function WikiOpChip({ op }: { op: string }) {
  const tone = op === 'add' ? 'add' : op === 'amend' || op === 'supersede' ? 'amend' : 'retire';
  return <span className={`wk-op ${tone}`}>{op === 'supersede' ? 'AMEND' : op.toUpperCase()}</span>;
}

/** The sources an op cites. A proposal stores them as they were submitted, before they were resolved. */
function sourcesOf(op: WikiChangesetOp): WikiSource[] {
  const payload = wikiOpPayload(op);
  const raw = Array.isArray(payload.sources) ? payload.sources : [];
  return raw.map((source, index) => {
    const row = (source ?? {}) as Record<string, unknown>;
    return {
      id: `${op.id}-${index}`,
      kind: (typeof row.kind === 'string' ? row.kind : 'note') as WikiSource['kind'],
      ref: typeof row.ref === 'string' ? row.ref : '',
      locator: (row.locator ?? {}) as Record<string, unknown>,
      quote: typeof row.quote === 'string' ? row.quote : null,
      quoteVerified: false,
      state: 'live',
      tainted: false,
      createdAt: '',
    } as WikiSource;
  });
}

/** The anchor lines a draft would carry, or the ones the entry already has. */
function anchorsOf(draft: Record<string, unknown>, fallback: unknown): string[] {
  const raw = Array.isArray(draft.anchors) ? draft.anchors : Array.isArray(fallback) ? fallback : [];
  return raw.flatMap((anchor) => {
    const row = (anchor ?? {}) as Record<string, unknown>;
    const path = typeof row.path === 'string' ? row.path : null;
    if (path) return [typeof row.symbol === 'string' ? `${path} · ${row.symbol}` : path];
    if (typeof row.sha === 'string') return [row.sha];
    if (typeof row.command === 'string') return [row.command];
    if (typeof row.ref === 'string') return [row.ref];
    return [];
  });
}

function shortRationale(rationale: string): string {
  const trimmed = rationale.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
}

const WIKI_ENTRY_WORD = 'entry';
const WIKI_MAINTENANCE_WORD = 'Wiki maintenance';
const DASH = '—';
