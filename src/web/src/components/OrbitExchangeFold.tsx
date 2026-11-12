import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import {
  EMPTY_TREE_LOOKUP,
  branchExchanges,
  buildExchangeTree,
  downstreamCount,
  exchangeKinds,
  type ExchangeBranch,
  type ExchangeTreeLookup,
  type OrbitExchangeSummary,
} from '../lib/orbitExchangeFold';

/**
 * The folds a conversation draws over the turns Orbit opened (lib/orbitExchangeFold; design:
 * docs/mocks/coordinator-exchange-fold/, approved 2026-11-11):
 *
 *   → Evidence revision 2 submitted: B1 — 我确认了 B1… · 5:14 PM ›          one exchange
 *   ⋯ 7 Orbit updates handled · 3 evidence, 2 watches · 5:14 PM – 6:49 PM ›   two or more in a row
 *       › B1 Targeted hints · 6 updates · 3 downstream · last: … · 6:44 PM    opened: by task
 *
 * Opening an exchange draws exactly what the conversation drew before the fold existed. A find that
 * lands inside one opens the way down to it (`REVEAL_EVENT` with the hit's seq, on the fold's root).
 */

/**
 * What the console knows that places an exchange under its task, and how to ask for the rest: the
 * project's dependency graph is read only once a group is opened (`want`), so a conversation nobody
 * opens a group in costs no request. The shared page and an export know nothing, and their groups
 * list exchanges by task with no prerequisites between them.
 */
export interface ExchangeTree {
  lookup: ExchangeTreeLookup;
  want: () => void;
}
export const ExchangeTreeCtx = createContext<ExchangeTree>({ lookup: EMPTY_TREE_LOOKUP, want: () => {} });

/** The event a find sends a fold's root, with `{ seq }` as its detail: open the way to that seq. */
export const EXCHANGE_REVEAL_EVENT = 'orbit:reveal-exchange';

export type ExchangeWithBody = OrbitExchangeSummary & { body: () => ReactNode };

export const exchangeClock = (ts?: string): string =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

const contains = (ex: OrbitExchangeSummary, seq: number | null) => seq != null && seq >= ex.seq && seq <= ex.lastSeq;

/** Listens on a fold's root for a find's reveal and hands back the seq it asked for. */
function useReveal(onReveal: (seq: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const handler = useRef(onReveal);
  handler.current = onReveal;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listen = (e: Event) => {
      const seq = Number((e as CustomEvent<{ seq?: number }>).detail?.seq);
      if (Number.isFinite(seq)) handler.current(seq);
    };
    el.addEventListener(EXCHANGE_REVEAL_EVENT, listen);
    return () => el.removeEventListener(EXCHANGE_REVEAL_EVENT, listen);
  }, []);
  return ref;
}

/** One exchange standing alone between two things the reader said. */
export function OrbitExchangeSolo({ ex }: { ex: ExchangeWithBody }) {
  const [reveal, setReveal] = useState<number | null>(null);
  const ref = useReveal(setReveal);
  return (
    <div ref={ref} className="orbit-exchange-root" data-seq={ex.seq} data-orbit-fold="">
      <ExchangeRow ex={ex} reveal={reveal} />
    </div>
  );
}

function ExchangeRow({ ex, reveal, inTask }: { ex: ExchangeWithBody; reveal: number | null; inTask?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (contains(ex, reveal)) setOpen(true);
  }, [ex, reveal]);
  const what = inTask && ex.whatInTask ? ex.whatInTask : ex.what;
  return (
    <div className={`orbit-exchange${open ? ' is-open' : ''}`} data-seq={ex.seq} data-exchange={ex.category}>
      <div
        className="orbit-exchange-line"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={ex.reply ? `${ex.what} — ${ex.reply}` : ex.what}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        <span className="orbit-exchange-mark" aria-hidden="true">→</span>
        <span className="orbit-exchange-what">{what}</span>
        {ex.reply && <span className="orbit-exchange-reply">{ex.reply}</span>}
        <span className="orbit-exchange-time">{exchangeClock(ex.ts)}</span>
        <span className="orbit-exchange-caret" aria-hidden="true">{open ? <DownOutlined /> : <RightOutlined />}</span>
      </div>
      {open && <div className="orbit-exchange-detail">{ex.body()}</div>}
    </div>
  );
}

/** Two or more exchanges in a row: one line, opening to them by task. */
export function OrbitExchangeGroup({ exchanges }: { exchanges: ExchangeWithBody[] }) {
  const { lookup, want } = useContext(ExchangeTreeCtx);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) want();
  }, [open, want]);
  const [reveal, setReveal] = useState<number | null>(null);
  const ref = useReveal((seq) => {
    setOpen(true);
    setReveal(seq);
  });
  const tree = useMemo(() => (open ? buildExchangeTree(exchanges, lookup) : null), [open, exchanges, lookup]);
  const first = exchanges[0];
  const last = exchanges[exchanges.length - 1];
  const kinds = exchangeKinds(exchanges);
  return (
    <div
      ref={ref}
      className={`orbit-exchanges${open ? ' is-open' : ''}`}
      data-seq={first.seq}
      data-orbit-fold=""
    >
      <div
        className="orbit-exchanges-line"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        <span className="orbit-exchange-mark" aria-hidden="true">⋯</span>
        <span className="orbit-exchanges-count">{`${exchanges.length} Orbit updates handled`}</span>
        {kinds && <span className="orbit-exchange-reply orbit-exchanges-kinds">{kinds}</span>}
        <span className="orbit-exchange-time">{`${exchangeClock(first.ts)} – ${exchangeClock(last.ts)}`}</span>
        <span className="orbit-exchange-caret" aria-hidden="true">{open ? <DownOutlined /> : <RightOutlined />}</span>
      </div>
      {open && (
        <div className="orbit-exchanges-body">
          {tree
            ? tree.map((branch) => (
                <TaskBranch key={branch.key} branch={branch} reveal={reveal} />
              ))
            : exchanges.map((ex) => <ExchangeRow key={ex.seq} ex={ex} reveal={reveal} />)}
        </div>
      )}
    </div>
  );
}

/** A task in a group's tree: shut, it sums up everything beneath it; open, its own exchanges, then the tasks after it. */
function TaskBranch({ branch, reveal }: { branch: ExchangeBranch<ExchangeWithBody>; reveal: number | null }) {
  const [open, setOpen] = useState(false);
  const every = useMemo(() => branchExchanges(branch), [branch]);
  useEffect(() => {
    if (every.some((ex) => contains(ex, reveal))) setOpen(true);
  }, [every, reveal]);
  const below = downstreamCount(branch);
  const own = branch.exchanges.length;
  const latest = open ? branch.exchanges[own - 1] : every[every.length - 1];
  const meta = open
    ? `${own} ${own === 1 ? 'update' : 'updates'}`
    : [
        `${every.length} ${every.length === 1 ? 'update' : 'updates'}`,
        below ? `${below} downstream` : null,
        latest.reply ? `last: ${latest.reply}` : null,
      ].filter(Boolean).join(' · ');
  return (
    <div className={`orbit-branch${open ? ' is-open' : ''}`} data-task={branch.taskId ?? undefined}>
      <div
        className="orbit-branch-line"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        <span className="orbit-branch-caret" aria-hidden="true">{open ? <DownOutlined /> : <RightOutlined />}</span>
        <span className="orbit-branch-title">{branch.title}</span>
        <span className="orbit-exchange-reply orbit-branch-meta">{meta}</span>
        <span className="orbit-exchange-time">{exchangeClock(latest.ts)}</span>
        {/* The slot the rows' caret takes, so a task's time lines up with its rows'. */}
        <span className="orbit-exchange-caret" aria-hidden="true" />
      </div>
      {open && (
        <div className="orbit-branch-body">
          {branch.exchanges.map((ex) => (
            <ExchangeRow key={ex.seq} ex={ex} reveal={reveal} inTask={branch.key !== 'other'} />
          ))}
          {branch.children.map((child) => (
            <TaskBranch key={child.key} branch={child} reveal={reveal} />
          ))}
        </div>
      )}
    </div>
  );
}
