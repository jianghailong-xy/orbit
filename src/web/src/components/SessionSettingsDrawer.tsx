import { useEffect, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CloseOutlined, CopyOutlined, DeleteOutlined, GlobalOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionNotifyOverride, SessionSettings, SessionSettingsPatch } from '@orbit/shared';
import {
  getShareLink,
  patchSessionSettings,
  putShareLink,
  restartSession,
  turnOffShareLink,
  type SessionDetail,
} from '../api';
import { copyText } from '../lib/clipboard';
import { decodeId } from '../lib/idCodec';
import { meQuery, sessionQuery } from '../lib/queries';
import type { SessionTagRef } from '../lib/sessionGrouping';
import { publicLinkUrl } from '../lib/shareLinks';
import { useToast } from '../lib/toast';
import { AUTO_COMPACT_SIZES, AUTO_COMPACT_VARIABLE } from './AutoCompactSelect';
import { shareLinkQueryKey } from './ShareModal';
import { Button } from './ui/Button';
import { Drawer } from './ui/Drawer';
import { Input } from './ui/Input';
import { Menu } from './ui/Menu';
import { Select } from './ui/Select';
import { Switch } from './ui/Switch';
import './SessionSettingsDrawer.css';

/** The session-env key rule the server enforces (PATCH /sessions/:id/settings). */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="ss-row">
      <div className="ss-row-text">
        <div className="ss-row-label">{label}</div>
        {hint && <div className="ss-row-hint">{hint}</div>}
      </div>
      <div className="ss-row-control">{children}</div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="ss-section" aria-label={title}>
      <div className="ss-section-head">
        <span className="ss-section-title">{title}</span>
        {note && <span className="ss-section-note">{note}</span>}
      </div>
      <div className="ss-card">{children}</div>
    </section>
  );
}

/** 1.82M, 108K, 950. */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}

const createdLabel = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** The last 12 characters, as the board shows an id. */
const tail = (id: string): string => (id.length > 12 ? `…${id.slice(-12)}` : id);

/** One session variable: its value saves when the field is left or Enter is pressed. */
function OwnVariable({ name, value, onSave, onRemove }: {
  name: string; value: string; onSave: (value: string) => void; onRemove: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onSave(draft);
  };
  return (
    <div className="ss-env-row own">
      <span className="ss-mono">{name}</span>
      <Input
        size="small"
        className="ss-mono ss-env-input"
        aria-label={`Value of ${name}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(value);
        }}
      />
      <Button size="small" variant="text" icon={<DeleteOutlined />} aria-label={`Remove ${name}`} onClick={onRemove} />
    </div>
  );
}

/** The row "+ Add variable" opens: a name and a value, saved together when Enter is pressed or focus leaves the row. */
function NewVariable({ onAdd, onCancel }: { onAdd: (name: string, value: string) => boolean; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const commit = () => {
    if (!name.trim()) return onCancel();
    if (onAdd(name.trim(), value)) onCancel();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') onCancel();
  };
  return (
    <div
      className="ss-env-row own ss-env-new"
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit();
      }}
    >
      <Input size="small" className="ss-mono" aria-label="Variable name" placeholder="NAME" autoFocus
        value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onKeyDown} />
      <Input size="small" className="ss-mono ss-env-input" aria-label="Variable value" placeholder="value"
        value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} />
      <Button size="small" variant="text" icon={<CloseOutlined />} aria-label="Cancel" onMouseDown={(e) => e.preventDefault()} onClick={onCancel} />
    </div>
  );
}

export interface SessionSettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  /** The session's tags as the page shows them, the owner's tag library + Add picks from, and the ⋯ Tags
   *  toggle that writes them (same cache updates). */
  sessionTags: SessionTagRef[];
  tagLibrary: SessionTagRef[];
  onToggleTag: (tagId: string) => void;
  tagsSaving: boolean;
  /** What the session page already calls these elsewhere: the engine's product name, its runner, its account. */
  engineName: string | null;
  runnerName: string | null;
  accountLabel: string | null;
}

/**
 * The session page's Settings… drawer (docs/mocks/session-settings, board r3): Session, Environment,
 * Notifications and Info. Nothing the composer offers. Every change saves at once.
 */
export function SessionSettingsDrawer({
  open, onClose, sessionId, sessionTags, tagLibrary, onToggleTag, tagsSaving, engineName, runnerName, accountLabel,
}: SessionSettingsDrawerProps) {
  const message = useToast();
  const qc = useQueryClient();
  const detailKey = sessionQuery(sessionId).queryKey;
  const session = useQuery({ ...sessionQuery(sessionId), enabled: open }).data as SessionDetail | undefined;
  const prefs = useQuery({ ...meQuery(), enabled: open }).data?.preferences;
  const shareKey = shareLinkQueryKey('SESSION', sessionId);
  const shareQ = useQuery({ queryKey: shareKey, queryFn: () => getShareLink('SESSION', sessionId), enabled: open });
  const [adding, setAdding] = useState(false);
  // The variables changed in this sitting, so the restart note can name them.
  const [changedKeys, setChangedKeys] = useState<string[]>([]);
  const [restartQueued, setRestartQueued] = useState(false);

  const settings = session?.settings;
  const pending = settings?.envPendingRestart === true;
  useEffect(() => {
    if (!pending) setRestartQueued(false);
  }, [pending]);
  useEffect(() => {
    if (!open) {
      setAdding(false);
      setChangedKeys([]);
    }
  }, [open]);

  const settingsMut = useMutation({
    mutationFn: (patch: SessionSettingsPatch) => patchSessionSettings(sessionId, patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: detailKey, exact: true });
      const previous = qc.getQueryData<SessionDetail>(detailKey);
      qc.setQueryData<SessionDetail>(detailKey, (old) =>
        old?.settings
          ? { ...old, settings: { ...old.settings, ...patch, env: patch.env === undefined ? old.settings.env : (patch.env ?? {}) } as SessionSettings }
          : old,
      );
      return { previous };
    },
    onSuccess: (next) => qc.setQueryData<SessionDetail>(detailKey, (old) => (old ? { ...old, settings: next } : old)),
    onError: (e: Error, _patch, context) => {
      if (context?.previous) qc.setQueryData(detailKey, context.previous);
      message.error("Couldn't save the setting", e.message);
    },
  });

  const restartMut = useMutation({
    mutationFn: () => restartSession(sessionId),
    onSuccess: (r) => {
      setRestartQueued(true);
      setChangedKeys([]);
      message.success(r.afterTurn ? 'The engine restarts when this turn ends' : 'Restarting the engine');
      void qc.invalidateQueries({ queryKey: detailKey, exact: true });
    },
    onError: (e: Error) => {
      message.error("Couldn't restart the engine", e.message);
      void qc.invalidateQueries({ queryKey: detailKey, exact: true });
    },
  });

  const refreshShared = () => {
    void qc.invalidateQueries({ queryKey: ['share-links'], exact: true });
    void qc.invalidateQueries({ queryKey: ['session'] });
    void qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  const shareOnMut = useMutation({
    mutationFn: () => putShareLink('SESSION', sessionId, {}),
    onSuccess: (link) => {
      qc.setQueryData(shareKey, (old: Awaited<ReturnType<typeof getShareLink>> | undefined) => ({ ...old, link }));
      refreshShared();
    },
    onError: (e: Error) => message.error("Couldn't turn on the link", e.message),
  });
  const shareOffMut = useMutation({
    mutationFn: () => turnOffShareLink('SESSION', sessionId),
    onSuccess: () => {
      qc.setQueryData(shareKey, (old: Awaited<ReturnType<typeof getShareLink>> | undefined) => ({ ...old, link: null }));
      refreshShared();
    },
    onError: (e: Error) => message.error("Couldn't turn off the link", e.message),
  });
  const link = shareQ.data?.link && shareQ.data.link.state !== 'ENDED' ? shareQ.data.link : null;
  const shareBusy = shareOnMut.isPending || shareOffMut.isPending;
  // The switch shows where it is going while the write is out.
  const live = shareOnMut.isPending ? true : shareOffMut.isPending ? false : !!link;

  const copy = (text: string, done: string) => {
    void copyText(text).then((ok) => (ok ? message.success(done) : message.error("Couldn't copy")));
  };

  const env = settings?.env ?? {};
  const workspaceEnv = settings?.workspaceEnv ?? {};
  const writeEnv = (next: Record<string, string>, touched: string[]) => {
    setChangedKeys((keys) => [...keys.filter((k) => !touched.includes(k)), ...touched]);
    settingsMut.mutate({ env: next });
  };
  const addVariable = (name: string, value: string): boolean => {
    if (!ENV_KEY.test(name) || name.toUpperCase().startsWith('ORBIT_')) {
      message.error('Use letters, digits and _ for the name, not starting with a digit or ORBIT_');
      return false;
    }
    writeEnv({ ...env, [name]: value }, [name]);
    return true;
  };
  const removeVariable = (name: string) => {
    const { [name]: _gone, ...rest } = env;
    writeEnv(rest, [name]);
  };
  const compactAt = env[AUTO_COMPACT_VARIABLE]?.trim() || 'default';
  const compactOptions = AUTO_COMPACT_SIZES.some((o) => o.value === compactAt)
    ? AUTO_COMPACT_SIZES
    : [...AUTO_COMPACT_SIZES, { value: compactAt, label: `${compactAt} tokens` }];
  const setCompactAt = (size: string) => {
    const { [AUTO_COMPACT_VARIABLE]: _old, ...rest } = env;
    writeEnv(size === 'default' ? rest : { ...rest, [AUTO_COMPACT_VARIABLE]: size }, [AUTO_COMPACT_VARIABLE]);
  };
  const ownRows = Object.entries(env).filter(([k]) => k !== AUTO_COMPACT_VARIABLE);
  // A session variable wins over the workspace's of the same name, so that one is not shown twice.
  const inheritedRows = Object.entries(workspaceEnv).filter(([k]) => !(k in env));

  const turnRunning = (session?.runStatus ?? session?.status) === 'RUNNING';
  const pendingWhat =
    changedKeys.length === 1
      ? `${changedKeys[0] === AUTO_COMPACT_VARIABLE ? 'Compact at' : changedKeys[0]} is waiting for the engine to restart.`
      : 'New variables are waiting for the engine to restart.';

  const notifyOptions = (inherited: string) => [
    { value: 'inherit' as const, label: `As in Settings (${inherited})` },
    { value: 'on' as const, label: 'Notify' },
    { value: 'off' as const, label: "Don't notify" },
  ];
  const setNotify = (field: 'notifyTurnFinished' | 'notifyNeedsYou', value: SessionNotifyOverride | null) => {
    if (value) settingsMut.mutate({ [field]: value });
  };

  const addable = tagLibrary.filter((t) => !sessionTags.some((s) => s.id === t.id));

  // The runner names a session's worktree folder by its UUID.
  const workDir = session?.branch
    ? { path: `~/.orbit/worktrees/${decodeId(session.id)}`, hint: "This session's worktree" }
    : { path: (session as { workspace?: { workDir?: string | null } } | undefined)?.workspace?.workDir ?? '—', hint: "The workspace's folder" };
  const usage = session?.usage;
  // As the board reads it: "in" is every input token, cached ones included, and cache is the part of it that was.
  const cacheTokens = usage ? usage.cacheReadTokens + usage.cacheCreationTokens : 0;
  const inTokens = usage ? usage.inputTokens + cacheTokens : 0;
  const totalTokens = usage ? inTokens + usage.outputTokens : 0;

  return (
    <Drawer open={open} onClose={onClose} title="Session settings" width={440} className="ss-drawer">
      <div className="ss-body">
        <Section title="Session">
          <div className="ss-row ss-row-top">
            <div className="ss-row-text">
              <div className="ss-row-label">Labels</div>
              <div className="ss-tags">
                {sessionTags.map((t) => (
                  <span key={t.id} className="ss-tag">
                    <span className="session-section-dot" style={{ background: t.color }} />
                    {t.name}
                    <button type="button" className="ss-tag-remove" aria-label={`Remove ${t.name}`} disabled={tagsSaving}
                      onClick={() => onToggleTag(t.id)}>
                      <CloseOutlined className="ss-tag-x" />
                    </button>
                  </span>
                ))}
                <Menu
                  side="bottom"
                  align="start"
                  disabled={addable.length === 0 || tagsSaving}
                  items={addable.map((t) => ({
                    key: t.id,
                    label: (
                      <span className="scope-tag-label">
                        <span className="session-section-dot" style={{ background: t.color }} />
                        {t.name}
                      </span>
                    ),
                    textValue: t.name,
                    onSelect: () => onToggleTag(t.id),
                  }))}
                  trigger={<button type="button" className="ss-tag ss-tag-add" disabled={addable.length === 0 || tagsSaving}><PlusOutlined /> Add</button>}
                />
              </div>
            </div>
          </div>
          <Row
            label="Public link"
            hint={live ? <span className="ss-live"><GlobalOutlined /> Live · anyone with the link can read it</span> : 'Off · only you can open this session'}
          >
            <Switch
              aria-label="Public link"
              checked={live}
              loading={shareQ.isLoading}
              disabled={shareBusy}
              onCheckedChange={(on) => (on ? shareOnMut.mutate() : shareOffMut.mutate())}
            />
          </Row>
          {link && !shareOffMut.isPending && (
            <div className="ss-link">
              <span className="ss-mono ss-link-url">{publicLinkUrl(link.token).replace(/^https?:\/\//, '')}</span>
              <Button size="small" icon={<CopyOutlined />} onClick={() => copy(publicLinkUrl(link.token), 'Link copied')}>Copy</Button>
            </div>
          )}
        </Section>

        <Section title="Environment" note="Applies when the engine next starts">
          <Row label="Working directory" hint={workDir.hint}>
            <span className="ss-mono ss-value ss-path" title={workDir.path}>{workDir.path}</span>
          </Row>
          <Row label="Compact at" hint="Claude Code summarizes the conversation near this size">
            <Select
              className="ss-select"
              aria-label="Compact at"
              value={compactAt}
              disabled={!settings}
              onValueChange={(v) => v && v !== compactAt && setCompactAt(v)}
              options={compactOptions}
            />
          </Row>
          <div className="ss-env">
            <div className="ss-env-head">Variables</div>
            {inheritedRows.map(([k, v]) => (
              <div key={k} className="ss-env-row inherited">
                <span className="ss-mono">{k}</span><span className="ss-mono ss-env-val" title={v}>{v}</span>
                <span className="ss-env-from">Workspace</span>
              </div>
            ))}
            {ownRows.map(([k, v]) => (
              <OwnVariable key={k} name={k} value={v}
                onSave={(next) => writeEnv({ ...env, [k]: next }, [k])}
                onRemove={() => removeVariable(k)} />
            ))}
            {adding && <NewVariable onAdd={addVariable} onCancel={() => setAdding(false)} />}
            {!adding && (
              <Button size="small" variant="text" icon={<PlusOutlined />} className="ss-env-add" disabled={!settings}
                onClick={() => setAdding(true)}>Add variable</Button>
            )}
          </div>
          {pending && (
            <div className="ss-restart" role="status">
              <div className="ss-restart-text">
                <b>{pendingWhat}</b>
                <span>
                  {turnRunning
                    ? 'A turn is running. Orbit restarts the engine with the new variables when it ends. The conversation is kept.'
                    : 'Restart starts the engine again with the new variables. The conversation is kept.'}
                </span>
              </div>
              <Button size="small" variant="primary" icon={<ReloadOutlined />}
                loading={restartMut.isPending} disabled={restartQueued}
                onClick={() => restartMut.mutate()}>
                {turnRunning ? 'Restart after this turn' : 'Restart'}
              </Button>
            </div>
          )}
        </Section>

        <Section title="Notifications" note="iOS and Android">
          <Row label="When a turn finishes">
            <Select className="ss-select" aria-label="When a turn finishes" disabled={!settings}
              value={settings?.notifyTurnFinished ?? 'inherit'}
              onValueChange={(v) => setNotify('notifyTurnFinished', v)}
              options={notifyOptions(prefs?.notifySessionFinished === false ? "Don't notify" : 'Notify')} />
          </Row>
          <Row label="When it needs you" hint="Approvals and questions">
            {/* No account switch exists for this one: following Settings means it notifies. */}
            <Select className="ss-select" aria-label="When it needs you" disabled={!settings}
              value={settings?.notifyNeedsYou ?? 'inherit'}
              onValueChange={(v) => setNotify('notifyNeedsYou', v)}
              options={notifyOptions('Notify')} />
          </Row>
          <Row label="Mute this session" hint="No notifications at all, until you turn this off">
            <Switch aria-label="Mute this session" checked={settings?.muted ?? false} disabled={!settings}
              onCheckedChange={(muted) => settingsMut.mutate({ muted })} />
          </Row>
        </Section>

        <Section title="Info">
          <dl className="ss-info">
            <dt>Engine</dt>
            <dd>{[engineName ?? session?.engine ?? '—', session?.engineVersion].filter(Boolean).join(' ')}</dd>
            <dt>Runner</dt><dd>{runnerName ?? '—'}</dd>
            <dt>Account</dt><dd>{accountLabel ?? '—'}</dd>
            <dt>Branch</dt><dd className="ss-mono">{session?.branch ?? '—'}</dd>
            <dt>Created</dt><dd>{session?.createdAt ? createdLabel(session.createdAt) : '—'}</dd>
            <dt>Tokens</dt>
            <dd>
              {usage ? compactCount(totalTokens) : '—'}
              {usage && (
                <span className="ss-sub">
                  in {compactCount(inTokens)} · out {compactCount(usage.outputTokens)} · cache {compactCount(cacheTokens)}
                </span>
              )}
            </dd>
            <dt>Cost</dt>
            <dd>
              {usage ? `$${usage.costUsd.toFixed(2)}` : '—'}
              {usage && <span className="ss-sub">{usage.numTurns === 1 ? '1 turn' : `${usage.numTurns} turns`}</span>}
            </dd>
            <dt>Session ID</dt>
            <dd className="ss-mono ss-copy">
              <button type="button" className="ss-copy-btn" title={sessionId} aria-label="Copy session ID"
                onClick={() => copy(session?.id ?? sessionId, 'Session ID copied')}>
                {tail(session?.id ?? sessionId)} <CopyOutlined />
              </button>
            </dd>
            <dt>Engine session</dt>
            <dd className="ss-mono ss-copy">
              {session?.runtimeSessionId ? (
                <button type="button" className="ss-copy-btn" title={session.runtimeSessionId} aria-label="Copy engine session ID"
                  onClick={() => copy(session.runtimeSessionId!, 'Engine session ID copied')}>
                  {tail(session.runtimeSessionId)} <CopyOutlined />
                </button>
              ) : '—'}
            </dd>
          </dl>
        </Section>
      </div>
    </Drawer>
  );
}
