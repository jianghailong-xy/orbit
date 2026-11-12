import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAIN_CHECKOUT_ACTION_TIMEOUT_SECONDS,
  MAIN_CHECKOUT_COPY,
  mainCheckoutChooseFiles,
  mainCheckoutCommitButton,
  mainCheckoutManagedBranchWarning,
  mainCheckoutPushLabel,
  mainCheckoutResultLine,
  mainCheckoutUncommitted,
  shortSha,
  type MainCheckoutActionKind,
  type MainCheckoutActionPost,
  type MainCheckoutActionRequest,
  type MainCheckoutActionResult,
  type MainCheckoutRepoHealth,
  type MainCheckoutView,
} from '@orbit/shared';
import { cancelMainCheckoutAction, getMainCheckout, postMainCheckoutAction } from '../api';
import type { SessionChangedFile, SessionFilePatch } from '../api';
import { type MainCheckoutHost, type MainCheckoutTarget } from '../lib/mainCheckout';
import { useToast } from '../lib/toast';
import { MainCheckoutResultRow } from './MainCheckout';
import { WorktreeDiffDrawer } from './SessionOutputs';
import { Input } from './ui/Input';
import { Menu, type MenuItem } from './ui/Menu';
import { useConfirm } from './ui/ConfirmDialog';

const POLL_MS = 2000;

export const mainCheckoutQueryKey = (workspaceId: string) => ['main-checkout', workspaceId] as const;

function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `mck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const VERB: Record<MainCheckoutActionKind, string> = {
  move: 'move the files',
  commit: 'commit',
  push: 'push',
  rescue: 'save the main checkout',
};

export function checkedAgo(iso: string | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `Checked ${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `Checked ${m} min ago`;
  return `Checked at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export interface MainCheckoutControllerOptions {
  workspaceId?: string | null;
  sessionId?: string;
  sessionTitle?: string;
  /** The session's worktree branch; absent for a Shared session. */
  sessionBranch?: string;
  actionsSupported: boolean;
  health: MainCheckoutRepoHealth | null;
  /** Worktree sessions of this workspace a Move can target (the console's own first). */
  targets: MainCheckoutTarget[];
  askAgent?: (text: string) => void;
  cleanUp?: () => void;
  viewChanges?: () => void;
}

/**
 * The main checkout's actions for one console: what the card, bar and result lines call, plus the review drawer
 * (board 02) to render once beside them. Each action is posted with a fresh requestId and re-posted under the same id
 * until its answer is final (a repeat answers with the first request's state, contract §10.4).
 */
export function useMainCheckoutController(o: MainCheckoutControllerOptions): {
  host: MainCheckoutHost | null;
  drawer: ReactNode;
} {
  const qc = useQueryClient();
  const message = useToast();
  const [confirm, confirmHolder] = useConfirm();
  const ws = o.workspaceId ?? null;
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState('');
  const [inFlight, setInFlight] = useState<{ requestId: string; kind: MainCheckoutActionKind } | null>(null);
  const [lastResult, setLastResult] = useState<MainCheckoutActionResult | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Another workspace is another checkout: nothing chosen or written for this one carries over.
  useEffect(() => {
    setOpen(false);
    setPath(null);
    setUnchecked(new Set());
    setCommitMessage('');
    setLastResult(null);
  }, [ws]);

  const viewQ = useQuery({
    queryKey: mainCheckoutQueryKey(ws ?? ''),
    queryFn: ({ signal }) => getMainCheckout(ws!, [], signal),
    enabled: open && !!ws,
    staleTime: 0,
    retry: false,
  });
  const view = viewQ.data;
  const snapshot = view?.snapshot;
  const files: SessionChangedFile[] = useMemo(
    () =>
      (snapshot?.files ?? []).map((f) => ({
        path: f.path,
        status: f.status,
        // The drawer's convention for "no line counts": a binary file.
        additions: f.binary ? -1 : (f.additions ?? 0),
        deletions: f.binary ? -1 : (f.deletions ?? 0),
      })),
    [snapshot],
  );
  // Open on the file asked for, else the first; a refreshed snapshot without it falls back to the first.
  useEffect(() => {
    if (!open || !snapshot) return;
    if (!path || !snapshot.files.some((f) => f.path === path)) setPath(snapshot.files[0]?.path ?? null);
  }, [open, snapshot, path]);
  const diffQ = useQuery({
    queryKey: [...mainCheckoutQueryKey(ws ?? ''), 'diff', path, snapshot?.fingerprint],
    queryFn: ({ signal }) => getMainCheckout(ws!, [path!], signal),
    enabled: open && !!ws && !!path && !!snapshot,
    staleTime: Infinity,
    retry: false,
  });
  const patches = useMemo(() => {
    const m = new Map<string, SessionFilePatch>();
    for (const d of diffQ.data?.diffs ?? []) m.set(d.path, { path: d.path, patch: d.patch, truncated: d.patchTruncated });
    return m;
  }, [diffQ.data]);

  const settle = useCallback(
    (result: MainCheckoutActionResult) => {
      if (!ws) return;
      setLastResult(result);
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      // A stale refusal is answered by reading the checkout again: the open drawer redraws what is there now.
      void qc.invalidateQueries({ queryKey: mainCheckoutQueryKey(ws) });
      if ((result.status === 'done' || result.status === 'partial') && result.kind !== 'push') {
        setOpen(false);
        setCommitMessage('');
        setUnchecked(new Set());
      }
      // Without a conversation to write the line into, say it here.
      if (!o.sessionId) {
        const line = mainCheckoutResultLine(result, { isolated: false });
        if (line.tone === 'ok') message.success(line.text);
        else if (line.tone === 'waiting') message.info(line.text);
        else message.error(line.lead.replace(/:$/, ''), line.text.slice(line.lead.length).trim());
      }
    },
    [ws, qc, message, o.sessionId],
  );

  const run = useCallback(
    async (req: Omit<MainCheckoutActionRequest, 'requestId'>) => {
      if (!ws) return;
      const requestId = newRequestId();
      const post: MainCheckoutActionPost = {
        ...req,
        requestId,
        ...(o.sessionId ? { initiatedFromSessionId: o.sessionId } : {}),
      };
      setInFlight({ requestId, kind: req.kind });
      setLastResult(null);
      try {
        let answer = await postMainCheckoutAction(ws, post);
        const deadline = Date.now() + (MAIN_CHECKOUT_ACTION_TIMEOUT_SECONDS + 30) * 1000;
        while (answer.status === 'pending' && answer.result?.status !== 'waiting' && Date.now() < deadline) {
          await sleep(POLL_MS);
          if (!mounted.current) return;
          answer = await postMainCheckoutAction(ws, post);
        }
        if (answer.result && mounted.current) settle(answer.result);
      } catch (e) {
        if (mounted.current) message.error(`Couldn't ${VERB[req.kind]}`, (e as Error).message);
      } finally {
        if (mounted.current) setInFlight((cur) => (cur?.requestId === requestId ? null : cur));
      }
    },
    [ws, o.sessionId, settle, message],
  );

  const push = useCallback(async () => {
    if (!ws) return;
    let fresh: MainCheckoutView;
    try {
      fresh = await qc.fetchQuery({
        queryKey: mainCheckoutQueryKey(ws),
        queryFn: () => getMainCheckout(ws),
        staleTime: 0,
      });
    } catch (e) {
      message.error("Couldn't read the main checkout", (e as Error).message);
      return;
    }
    const s = fresh.snapshot;
    const go = () => void run({ kind: 'push', root: s.root, fingerprint: s.fingerprint });
    if (!fresh.managedBranch) return go();
    const upstream = s.upstream ?? `origin/${s.branch ?? 'main'}`;
    void confirm({
      title: `${mainCheckoutPushLabel(upstream)}?`,
      description: mainCheckoutManagedBranchWarning(fresh.managedBranch.projectTitle),
      confirmText: 'Push',
      onConfirm: go,
    });
  }, [ws, qc, run, confirm, message]);

  const cancel = useCallback(
    (requestId: string) => {
      if (!ws) return;
      cancelMainCheckoutAction(ws, requestId)
        .then((answer) => {
          if (answer.result) settle(answer.result);
        })
        .catch((e: Error) => message.error("Couldn't cancel", e.message));
    },
    [ws, settle, message],
  );

  const host = useMemo<MainCheckoutHost | null>(
    () =>
      ws
        ? {
            workspaceId: ws,
            sessionId: o.sessionId,
            sessionTitle: o.sessionTitle,
            sessionBranch: o.sessionBranch,
            actionsSupported: o.actionsSupported,
            health: o.health,
            targets: o.targets,
            inFlight,
            openReview: (p) => {
              setPath(p ?? null);
              setUnchecked(new Set());
              setOpen(true);
            },
            move: (i) => void run({ kind: 'move', ...i }),
            rescue: (i) => void run({ kind: 'rescue', ...i }),
            push: () => void push(),
            cancel,
            askAgent: o.askAgent,
            cleanUp: o.cleanUp,
            viewChanges: o.viewChanges,
          }
        : null,
    [ws, o.sessionId, o.sessionTitle, o.sessionBranch, o.actionsSupported, o.health, o.targets, inFlight, run, push, cancel,
      o.askAgent, o.cleanUp, o.viewChanges],
  );

  const drawer =
    host && open ? (
      <MainCheckoutDrawer
        host={host}
        view={view}
        loading={viewQ.isLoading}
        error={viewQ.error as Error | null}
        files={files}
        patches={patches}
        diffLoading={diffQ.isLoading}
        path={path}
        onSelect={setPath}
        onClose={() => setOpen(false)}
        unchecked={unchecked}
        setUnchecked={setUnchecked}
        commitMessage={commitMessage}
        setCommitMessage={setCommitMessage}
        lastResult={lastResult}
        onCommit={(chosen) =>
          snapshot &&
          void run({
            kind: 'commit',
            root: snapshot.root,
            fingerprint: snapshot.fingerprint,
            files: chosen,
            message: commitMessage.trim(),
          })
        }
        onMove={(chosen, targetSessionId) =>
          snapshot &&
          void run({ kind: 'move', root: snapshot.root, fingerprint: snapshot.fingerprint, files: chosen, targetSessionId })
        }
        onRescue={() => snapshot && void run({ kind: 'rescue', root: snapshot.root, fingerprint: snapshot.fingerprint })}
      />
    ) : null;
  return {
    host,
    drawer: (
      <>
        {drawer}
        {confirmHolder}
      </>
    ),
  };
}

/** Board 02: the session diff drawer, showing the main checkout. Files are chosen on the left (all by default); Commit,
 *  Move and Save leave from the bottom bar. */
export function MainCheckoutDrawer({
  host,
  view,
  loading,
  error,
  files,
  patches,
  diffLoading,
  path,
  onSelect,
  onClose,
  unchecked,
  setUnchecked,
  commitMessage,
  setCommitMessage,
  lastResult,
  onCommit,
  onMove,
  onRescue,
}: {
  host: MainCheckoutHost;
  view?: MainCheckoutView;
  loading: boolean;
  error: Error | null;
  files: SessionChangedFile[];
  patches: ReadonlyMap<string, SessionFilePatch>;
  diffLoading: boolean;
  path: string | null;
  onSelect: (path: string) => void;
  onClose: () => void;
  unchecked: ReadonlySet<string>;
  setUnchecked: (next: ReadonlySet<string>) => void;
  commitMessage: string;
  setCommitMessage: (text: string) => void;
  lastResult: MainCheckoutActionResult | null;
  onCommit: (files: string[]) => void;
  onMove: (files: string[], targetSessionId: string) => void;
  onRescue: () => void;
}) {
  const snapshot = view?.snapshot;
  const branch = snapshot?.branch ?? 'HEAD';
  const chosen = files.filter((f) => !unchecked.has(f.path)).map((f) => f.path);
  const busy = !!host.inFlight || !!view?.inFlight;
  const actions = host.actionsSupported && (view?.actionsSupported ?? true);
  const canCommit = actions && !busy && chosen.length > 0 && commitMessage.trim() !== '' && !!snapshot?.branch;
  const total = snapshot?.fileCount ?? files.length;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(iv);
  }, []);

  const title = (
    <span className="mck-drawer-head">
      <span className="mck-drawer-title">{MAIN_CHECKOUT_COPY.label}</span>
      {snapshot && (
        <>
          <span className="mck-chip">{snapshot.root}</span>
          <span className="mck-chip">
            {branch}
            {snapshot.head ? ` · ${shortSha(snapshot.head)}` : ''}
          </span>
          {total > 0 && <span className="mck-chip mck-chip-warn">{mainCheckoutUncommitted(total)}</span>}
          <span className="mck-drawer-checked">{checkedAgo(snapshot.checkedAt, now)}</span>
        </>
      )}
    </span>
  );

  // Board 02②: the session it was opened from first, busy ones visible but not choosable.
  const targets = [...host.targets].sort((a, b) => Number(b.id === host.sessionId) - Number(a.id === host.sessionId));
  const moveItems: MenuItem[] = targets.map((t) => ({
    key: t.id,
    disabled: t.busy,
    textValue: t.title,
    label: (
      <span className="mck-menu-row">
        <span className="mck-menu-label">
          {t.title} <code className="mck-menu-branch">{t.branch}</code>
        </span>
        {t.busy ? (
          <span className="mck-menu-hint">{MAIN_CHECKOUT_COPY.targetBusy}</span>
        ) : t.id === host.sessionId ? (
          <span className="mck-menu-hint">{MAIN_CHECKOUT_COPY.targetOpenedFrom}</span>
        ) : null}
      </span>
    ),
    onSelect: () => onMove(chosen, t.id),
  }));

  const footer = actions ? (
    <div className="mck-drawer-foot">
      {lastResult && lastResult.status !== 'done' && (
        <MainCheckoutResultRow
          notice={{
            noticeKind: 'main-checkout-action-result',
            notice: mainCheckoutResultLine(lastResult, { sessionId: host.sessionId, isolated: !!host.sessionBranch }).text,
            result: lastResult,
          }}
          isolated={!!host.sessionBranch}
        />
      )}
      {view?.managedBranch && (
        <div className="mck-managed">{mainCheckoutManagedBranchWarning(view.managedBranch.projectTitle)}</div>
      )}
      <div className="mck-drawer-actions">
        <Input
          className="mck-commit-msg"
          placeholder={MAIN_CHECKOUT_COPY.commitMessagePlaceholder}
          aria-label={MAIN_CHECKOUT_COPY.commitMessagePlaceholder}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
        />
        <button
          type="button"
          className="mck-btn mck-btn-primary"
          disabled={!canCommit}
          onClick={() => onCommit(chosen)}
        >
          {host.inFlight?.kind === 'commit' ? 'Committing…' : mainCheckoutCommitButton(chosen.length, branch)}
        </button>
        {moveItems.length > 0 && (
          <Menu
            side="top"
            align="end"
            popupClassName="mck-menu"
            items={moveItems}
            disabled={busy || chosen.length === 0}
            trigger={
              <button type="button" className="mck-btn" disabled={busy || chosen.length === 0}>
                {MAIN_CHECKOUT_COPY.moveToAWorktree} ▾
              </button>
            }
          />
        )}
        <Menu
          side="top"
          align="end"
          popupClassName="mck-menu"
          items={[
            {
              key: 'rescue',
              disabled: busy,
              textValue: MAIN_CHECKOUT_COPY.saveAndClean,
              label: (
                <span className="mck-menu-row">
                  <span className="mck-menu-label">{MAIN_CHECKOUT_COPY.saveAndClean}</span>
                  <span className="mck-menu-hint">{MAIN_CHECKOUT_COPY.saveAndCleanHint}</span>
                </span>
              ),
              onSelect: onRescue,
            },
          ]}
          trigger={
            <button type="button" className="mck-btn mck-btn-more" aria-label="More actions">
              ⋯
            </button>
          }
        />
      </div>
    </div>
  ) : undefined;

  const allOn = chosen.length === files.length;
  const listHead = (
    <div className="mck-drawer-choose">
      {error ? (
        <span className="mck-drawer-error">Couldn't read the main checkout: {error.message}</span>
      ) : loading ? (
        'Reading the main checkout…'
      ) : (
        <button
          type="button"
          className="mck-choose-toggle"
          title={allOn ? 'Choose none' : 'Choose all'}
          onClick={() => setUnchecked(allOn ? new Set(files.map((f) => f.path)) : new Set())}
        >
          {mainCheckoutChooseFiles(chosen.length, files.length)}
        </button>
      )}
    </div>
  );

  return (
    <WorktreeDiffDrawer
      sessionId=""
      files={files}
      branch={branch}
      openPath={path ?? ''}
      onSelect={onSelect}
      onClose={onClose}
      source={{
        patches,
        loading: diffLoading,
        title,
        listHead,
        listFoot: <div className="mck-drawer-note">{MAIN_CHECKOUT_COPY.notShown}</div>,
        footer,
        checked: (p) => !unchecked.has(p),
        onCheck: (p, on) => {
          const next = new Set(unchecked);
          if (on) next.delete(p);
          else next.add(p);
          setUnchecked(next);
        },
      }}
    />
  );
}
