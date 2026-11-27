import { Fragment, useRef, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { OwnerRequest } from '../lib/ownerRequests';
import { meQuery, type Me } from '../lib/queries';
import {
  SETTINGS_CHANGE_COPY as COPY,
  keyPathLabel,
  settingValueLabel,
  settingsChangesOf,
  type SettingsChangeEntry,
} from '../lib/settingsChange';
import { SETTING_ROWS } from '@orbit/shared';
import { sameResourceId } from '../lib/watches';
import { CardActionButton, CardActions } from './CardAction';
import { ENTER_HINT, useDecisionCardKeys } from './CardHotkey';
import { Alert } from './ui/Alert';
import { Textarea } from './ui/Textarea';
import './SettingsChange.css';

/**
 * A SETTINGS_CHANGE owner request (docs/settings-from-conversation-design.md §8.1, board 1 frame ②): the
 * confirmation-card look (`approval-card`), one row per setting with its value now struck through and the value it
 * would become, the agent's reason in grey, and two buttons — Save changes (Enter), which is the owner's
 * `POST /owner-requests/:id/apply-settings`, and Chat about this, which declines it with the reason typed. There is no
 * Always allow: every change to Settings asks (§2, Q3).
 */
export function SettingsChangeCard({ request }: { request: OwnerRequest }): JSX.Element {
  const qc = useQueryClient();
  const anchor = useRef<HTMLDivElement>(null);
  const changes = settingsChangesOf(request.payload);
  const [stale, setStale] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const settle = () => void qc.invalidateQueries({ queryKey: ['owner-requests'] });
  const apply = useMutation({
    mutationFn: () =>
      api<OwnerRequest>(`/owner-requests/${encodeURIComponent(request.id)}/apply-settings`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: meQuery().queryKey }),
    onError: (error) => {
      // The server's machine code (ApiError.code), read off the error so a test's api double need not build one.
      if ((error as { code?: string }).code === 'SETTINGS_STALE') setStale(true);
    },
    onSettled: settle,
  });
  const decline = useMutation({
    mutationFn: (why: string) =>
      api<OwnerRequest>(`/owner-requests/${encodeURIComponent(request.id)}/decline`, { method: 'POST', body: { reason: why } }),
    onSettled: settle,
  });
  const answerable = !stale && !apply.isPending && !decline.isPending && !declining;
  const keys = useDecisionCardKeys({ confirmEnabled: answerable, onConfirm: () => apply.mutate(), anchor });

  if (apply.data) return <SettingsChangeFolded request={apply.data} />;
  if (decline.data) return <SettingsChangeFolded request={decline.data} />;
  if (stale) {
    return (
      <div className="settings-change-folded is-stale" id={`owner-request-${request.id}`} data-kind="SETTINGS_CHANGE">
        <span>{COPY.stale}</span>
        <span className="settings-change-sep" aria-hidden="true">·</span>
        <button
          type="button"
          className="owner-request-link"
          disabled={decline.isPending}
          onClick={() => decline.mutate(COPY.stale)}
        >
          {COPY.decline}
        </button>
      </div>
    );
  }

  const failure = (apply.error ?? decline.error) as Error | null;
  return (
    <div ref={anchor} className="approval-card settings-change-card" id={`owner-request-${request.id}`} data-kind="SETTINGS_CHANGE">
      <div className="approval-head">{COPY.heading(changes.length)}</div>
      <div className="approval-body is-plan settings-change-body">
        {groups(changes).map(({ path, entries }, index) => (
          <Fragment key={`${path ?? ''}-${index}`}>
            {path ? <div className="settings-change-path">{path}</div> : null}
            {entries.map((entry) => <ChangeRow key={entry.key} entry={entry} />)}
          </Fragment>
        ))}
        {request.why ? <p className="settings-change-why">{COPY.agentSays(request.why)}</p> : null}
        <p className="settings-change-foot">{COPY.foot}</p>
      </div>
      {failure ? <Alert type="error" title="That was not recorded" description={failure.message} /> : null}
      {declining ? (
        <div className="settings-change-decline">
          <Textarea
            value={reason}
            maxLength={2000}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={COPY.declinePlaceholder}
            aria-label="Reason for declining"
            onChange={(event) => setReason(event.target.value)}
          />
          <CardActions className="approval-actions">
            <CardActionButton
              tone="primary"
              disabled={!reason.trim() || decline.isPending}
              onClick={() => decline.mutate(reason.trim())}
            >
              {COPY.decline}
            </CardActionButton>
            <CardActionButton onClick={() => setDeclining(false)}>{COPY.keep}</CardActionButton>
          </CardActions>
        </div>
      ) : (
        <CardActions className="approval-actions">
          <CardActionButton tone="primary" disabled={!answerable} onClick={() => apply.mutate()}>
            {COPY.save}
            {keys && <span className="approval-kbd">{ENTER_HINT}</span>}
          </CardActionButton>
          <CardActionButton disabled={!answerable} onClick={() => setDeclining(true)}>
            {COPY.chat}
          </CardActionButton>
        </CardActions>
      )}
    </div>
  );
}

/** Consecutive rows on the same Settings page share one path line; a key with no row of its own has none. */
function groups(changes: readonly SettingsChangeEntry[]): { path: string | null; entries: SettingsChangeEntry[] }[] {
  const out: { path: string | null; entries: SettingsChangeEntry[] }[] = [];
  for (const entry of changes) {
    const path = keyPathLabel(entry.key);
    const last = out.at(-1);
    if (last && last.path === path) last.entries.push(entry);
    else out.push({ path, entries: [entry] });
  }
  return out;
}

function ChangeRow({ entry }: { entry: SettingsChangeEntry }): JSX.Element {
  return (
    <div className="settings-change-row" data-setting-key={entry.key}>
      <span className="settings-change-title">{SETTING_ROWS[entry.key].title}</span>
      <span className="settings-change-values">
        <s className="settings-change-from">{settingValueLabel(entry.key, entry.from)}</s>
        <span className="settings-change-arrow" aria-hidden="true">→</span>
        <strong className="settings-change-to">{settingValueLabel(entry.key, entry.to)}</strong>
      </span>
      {entry.tier === 2 ? <span className="settings-change-note">{COPY.newSessionsOnly}</span> : null}
    </div>
  );
}

/**
 * An answered SETTINGS_CHANGE card, folded to one line (§8.1): `✓ Changed 2 settings · Undo` or `Declined`. Undo sends
 * the owner's own PATCH with each `from` (§5.3), for the keys this card still marks — a setting the owner has changed
 * since is theirs, and is left alone.
 */
export function SettingsChangeFolded({ request }: { request: OwnerRequest }): JSX.Element {
  const qc = useQueryClient();
  const me = useQuery({ ...meQuery(), enabled: request.state === 'DONE' });
  const changes = settingsChangesOf(request.payload);
  const marked = changes.filter((entry) => {
    const mark = me.data?.changedBy?.[entry.key];
    return mark ? sameResourceId(mark.requestId, request.id) : false;
  });
  const undo = useMutation({
    mutationFn: () =>
      api<Me>('/users/me/preferences', {
        method: 'PATCH',
        body: Object.fromEntries(marked.map((entry) => [entry.key, entry.from])),
      }),
    onSuccess: (updated) => qc.setQueryData(meQuery().queryKey, updated),
  });
  if (request.state === 'DECLINED') {
    return (
      <div className="settings-change-folded is-declined" id={`owner-request-${request.id}`} data-kind="SETTINGS_CHANGE">
        <span>{COPY.declined}</span>
      </div>
    );
  }
  return (
    <div className="settings-change-folded is-done" id={`owner-request-${request.id}`} data-kind="SETTINGS_CHANGE">
      <span>{COPY.changed(changes.length)}</span>
      {undo.isSuccess ? (
        <>
          <span className="settings-change-sep" aria-hidden="true">·</span>
          <span>{COPY.undone}</span>
        </>
      ) : marked.length > 0 ? (
        <>
          <span className="settings-change-sep" aria-hidden="true">·</span>
          <button type="button" className="owner-request-link" disabled={undo.isPending} onClick={() => undo.mutate()}>
            {COPY.undo}
          </button>
        </>
      ) : null}
      {undo.isError ? <span className="owner-request-resolved-error">{(undo.error as Error).message}</span> : null}
    </div>
  );
}
