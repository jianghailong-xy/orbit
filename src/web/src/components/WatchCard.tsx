import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Popconfirm } from 'antd';
import type { WatchDeliveryView, WatchSnapshot, WatchView } from '@orbit/shared';
import { watchesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import {
  SHOWN_TARGETS,
  ago,
  cancelWatch,
  deliveriesOf,
  describeCondition,
  describeProgress,
  describeReason,
  endedAt,
  expiryLabel,
  isLiveWatch,
  lastChangedAt,
  linkId,
  pauseWatch,
  progressOf,
  resumeWatch,
  thresholdOf,
  wakeWithdrawn,
  watchErrorMessage,
  watchProblem,
} from '../lib/watches';
import { ObserverLink, WatchStatePill, WatchTargetLink, useNow, useTargetName } from './WatchParts';

/** A deadline as a moment rather than a span, in the reader's own locale: the strip's Expires row
 *  says it beside the card's, so both read the one clock. */
export const absTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/**
 * One watch, answering the four questions it exists for with nothing opened: what it watches, what it
 * waits for (the heading), how stale that reading is, and what happens when the condition holds —
 * with its deadline and anything that went wrong. Details holds the rest: every target, the snapshot
 * a trigger recorded and each delivery.
 */
export function WatchCard({ watch, focused = false }: { watch: WatchView; focused?: boolean }) {
  const now = useNow();
  const [open, setOpen] = useState(focused);
  const problem = watchProblem(watch);
  const live = isLiveWatch(watch);
  const progress = progressOf(watch);
  // What the condition asks for, which is not the target count: one target settles an ANY watch.
  const needed = thresholdOf(watch.predicate, watch.targets).needed;
  const expiry = expiryLabel(watch, now);
  const lastMatch = watch.matches.at(-1);
  const shown = open ? watch.targets : watch.targets.slice(0, SHOWN_TARGETS);
  const hidden = watch.targets.length - shown.length;
  const age = live
    ? `created ${ago(watch.createdAt, now)}`
    : lastMatch && watch.state === 'MATCHED'
      ? `triggered ${ago(lastMatch.matchedAt, now)}`
      : `ended ${ago(endedAt(watch), now)}`;
  return (
    <article
      className={`watch-card${problem ? ` tone-${problem.tone}` : ''}${focused ? ' is-focused' : ''}`}
      data-watch-id={watch.id}
    >
      <header className="watch-card-head">
        <WatchStatePill state={watch.state} />
        <h3 className="watch-condition">{describeCondition(watch.predicate, watch.targets)}</h3>
        <span className="watch-age">{age}</span>
      </header>
      {problem && (
        <div className={`watch-problem tone-${problem.tone}`}>
          <strong>{problem.title}</strong>
          {problem.detail && <span>{problem.detail}</span>}
        </div>
      )}
      <dl className="watch-facts">
        <dt>Watching</dt>
        <dd className="watch-targets">
          {shown.map((t) => (
            <WatchTargetLink
              key={`${t.targetKind}:${t.targetResourceId}`}
              kind={t.targetKind}
              id={t.targetResourceId}
              title={t.targetTitle}
              state={t.state}
            />
          ))}
          {hidden > 0 && (
            <button type="button" className="watch-more" onClick={() => setOpen(true)}>
              +{hidden} more
            </button>
          )}
        </dd>
        <dt>{live ? 'Progress' : 'Result'}</dt>
        <dd>
          {live || !lastMatch ? (
            <>
              {/* Clamped: an AT_LEAST's count can lag the targets that have met it, and a bar past the
                  whole of its track spills out of the card. */}
              <span className="watch-bar" aria-hidden="true">
                <span style={{ width: `${needed ? Math.min(100, Math.round((progress.met / needed) * 100)) : 0}%` }} />
              </span>
              {describeProgress(progress)}
            </>
          ) : (
            describeReason(lastMatch.reason)
          )}
        </dd>
        <dt>Updated</dt>
        <dd>
          Last change {ago(lastChangedAt(watch), now)}
          <span className="watch-muted">
            {' '}
            · checked {ago(watch.lastEvaluatedAt, now)}
            {watch.state === 'PAUSED' ? ' (paused)' : ''}
          </span>
        </dd>
        <dt>Then</dt>
        <dd>
          <ThenLine watch={watch} now={now} />
        </dd>
        {expiry && (
          <>
            <dt>{watch.state === 'EXPIRED' ? 'Expired' : 'Expires'}</dt>
            <dd>
              <span className={expiry.soon ? 'watch-soon' : undefined}>{expiry.text}</span>
              <span className="watch-muted"> · {absTime(watch.expiresAt)}</span>
            </dd>
          </>
        )}
      </dl>
      <footer className="watch-actions">
        {live && <WatchControls watch={watch} />}
        <span className="watch-spacer" />
        <button
          type="button"
          className="watch-details-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide details' : 'Details'}
        </button>
      </footer>
      {open && <WatchDetails watch={watch} now={now} />}
    </article>
  );
}

/** What the watch does when its condition holds, and how its latest delivery went. */
function ThenLine({ watch, now }: { watch: WatchView; now: number }) {
  const latest = deliveriesOf(watch)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .at(-1);
  return (
    <>
      {watch.action === 'NOTIFY_USER' ? (
        'Notify you'
      ) : (
        <>
          Resume{' '}
          {watch.observerSessionId ? (
            <ObserverLink sessionId={watch.observerSessionId} />
          ) : (
            'the waiting session'
          )}
        </>
      )}
      {latest && (
        <span className={`watch-delivery-state is-${deliveryMark(latest)}`}>
          {' '}
          · {deliveryWords(latest, now)}
        </span>
      )}
    </>
  );
}

function deliveryWords(d: WatchDeliveryView, now: number): string {
  if (d.state === 'DELIVERED') {
    return `${d.action === 'NOTIFY_USER' ? 'sent' : 'turn queued'} ${ago(d.deliveredAt, now)}`;
  }
  if (d.state === 'DEAD_LETTER') return wakeWithdrawn(d) ? 'wake withdrawn' : 'not delivered';
  return d.attempts > 0 ? 'retrying' : 'delivering';
}

/** The class a delivery reads in. A withdrawn wake has its own, so it never takes a dead letter's error color. */
function deliveryMark(d: WatchDeliveryView): string {
  return wakeWithdrawn(d) ? 'withdrawn' : d.state.toLowerCase();
}

type ControlVerb = 'pause' | 'resume' | 'cancel';

const CONTROL: Record<ControlVerb, { call: (id: string) => Promise<WatchView>; done: string }> = {
  pause: { call: pauseWatch, done: 'Watch paused. Its deadline keeps running.' },
  resume: { call: resumeWatch, done: 'Watch resumed' },
  cancel: { call: cancelWatch, done: 'Stopped watching' },
};

/**
 * What Stop costs, said before it happens — the macOS client's `WatchProjection.stopWarning`, held
 * to these words by `WatchStripCopyParityTests`. CANCELLED is the one end nobody is told about, so
 * the consequence is named for whoever the watch would have woken (contract §3).
 */
export const STOP_WARNING_RESUME =
  "The waiting session won't be resumed, and it isn't told the watch stopped.";
export const STOP_WARNING_NOTIFY = "You won't be notified when the condition holds.";

/** Pause or Resume, and Stop — the controls a live watch has (contract §3). Edit is gone until the
 *  server tells the agent when its wait's condition changed (docs/watch-contract.md). */
export function WatchControls({ watch }: { watch: WatchView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const control = useMutation({
    mutationFn: (verb: ControlVerb) => CONTROL[verb].call(watch.id),
    onSuccess: (next, verb) => {
      if (next?.id) {
        qc.setQueryData<WatchView[]>(watchesQuery().queryKey, (rows) =>
          rows?.map((row) => (row.id === next.id ? next : row)),
        );
      }
      void qc.invalidateQueries({ queryKey: watchesQuery().queryKey });
      toast.success(CONTROL[verb].done);
    },
    onError: (err) => toast.error(watchErrorMessage(err)),
  });
  const pending = control.isPending ? control.variables : undefined;
  return (
    <>
      {watch.state === 'PAUSED' ? (
        <Button
          size="small"
          type="primary"
          loading={pending === 'resume'}
          disabled={control.isPending && pending !== 'resume'}
          onClick={() => control.mutate('resume')}
        >
          Resume
        </Button>
      ) : (
        <Button
          size="small"
          loading={pending === 'pause'}
          disabled={control.isPending && pending !== 'pause'}
          onClick={() => control.mutate('pause')}
        >
          Pause
        </Button>
      )}
      <Popconfirm
        title="Stop this watch?"
        description={watch.action === 'NOTIFY_USER' ? STOP_WARNING_NOTIFY : STOP_WARNING_RESUME}
        okText="Stop watching"
        okButtonProps={{ danger: true }}
        cancelText="Keep watching"
        onConfirm={() => control.mutate('cancel')}
      >
        <Button
          size="small"
          danger
          loading={pending === 'cancel'}
          disabled={control.isPending && pending !== 'cancel'}
        >
          Stop
        </Button>
      </Popconfirm>
    </>
  );
}

const END_DELIVERY: Record<string, string> = {
  EXPIRY: 'Tell the session the watch expired',
  REVOKED: 'Tell the session the watch lost access',
  UNRESOLVABLE: 'Tell the session every target is gone',
};

function WatchDetails({ watch, now }: { watch: WatchView; now: number }) {
  const deliveries = deliveriesOf(watch);
  return (
    <div className="watch-details">
      <section className="watch-details-section">
        <h4>Targets</h4>
        <ul className="watch-details-list">
          {watch.targets.map((t) => (
            <li key={`${t.targetKind}:${t.targetResourceId}`}>
              <WatchTargetLink kind={t.targetKind} id={t.targetResourceId} state={t.state} />
              <TargetStatus kind={t.targetKind} id={t.targetResourceId} />
              <span className="watch-muted"> · changed {ago(t.lastEvaluatedAt, now)}</span>
            </li>
          ))}
        </ul>
      </section>
      {watch.matches.map((m) => (
        <section key={m.id} className="watch-details-section">
          <h4>
            Triggered {absTime(m.matchedAt)} · generation {m.generation}
          </h4>
          <div>{describeReason(m.reason)}</div>
          <SnapshotList snapshot={m.perTargetSnapshot} />
        </section>
      ))}
      {deliveries.length > 0 && (
        <section className="watch-details-section">
          <h4>Deliveries</h4>
          <ul className="watch-details-list">
            {deliveries.map((d) => (
              <li key={d.id} className={`watch-delivery is-${deliveryMark(d)}`}>
                {'kind' in d && typeof d.kind === 'string'
                  ? (END_DELIVERY[d.kind] ?? d.kind)
                  : d.action === 'NOTIFY_USER'
                    ? 'Notify you'
                    : 'Resume the session'}
                {` · ${wakeWithdrawn(d) ? 'withdrawn' : d.state.replace('_', ' ').toLowerCase()}`}
                {d.attempts > 0 ? ` · ${d.attempts} failed attempt${d.attempts === 1 ? '' : 's'}` : ''}
                {d.deliveredAt ? ` · ${absTime(d.deliveredAt)}` : ''}
                {d.lastError && (
                  <div className={wakeWithdrawn(d) ? 'watch-muted' : 'watch-delivery-error'}>{d.lastError}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="watch-details-id">
        watch {linkId(watch.id)} · {watch.mode === 'ONE_SHOT' ? 'one-shot' : 'continuous'} · generation{' '}
        {watch.generation}
        {isLiveWatch(watch) && watch.nextEvaluateAt ? ` · next check ${absTime(watch.nextEvaluateAt)}` : ''}
      </div>
    </div>
  );
}

/** What the target itself says now, next to what the watch last recorded. */
function TargetStatus({ kind, id }: { kind: string; id: string }) {
  const { status } = useTargetName(kind, id);
  return status ? <span className="watch-muted"> · now {status.toLowerCase().replace(/_/g, ' ')}</span> : null;
}

type ObservedTarget = NonNullable<WatchSnapshot['targets'][number]['observed']>;

const observedWords = (observed: ObservedTarget): string => {
  const words = [`status ${observed.status}`];
  if ('runState' in observed) {
    words.push(`run ${observed.runState}`, `filed ${observed.lifecycleState}`);
    if (observed.pendingApproval) words.push('approval pending');
  }
  return words.join(' · ');
};

/** The per-target snapshot a Match recorded: what the evaluation that triggered it saw. */
function SnapshotList({ snapshot }: { snapshot: WatchSnapshot | null | undefined }) {
  const targets = snapshot && Array.isArray(snapshot.targets) ? snapshot.targets : [];
  if (targets.length === 0) return null;
  return (
    <ul className="watch-details-list">
      {targets.map((t) => (
        <li key={`${t.kind}:${t.id}`}>
          <WatchTargetLink kind={t.kind} id={t.id} />
          <span className="watch-muted">
            {' '}
            · {t.state.toLowerCase()}
            {t.observed ? ` · ${observedWords(t.observed)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
