import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  InfoCircleFilled,
  LoadingOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Modal } from 'antd';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  codexRateLimitResetOf,
  type CodexRateLimitResetOperationView,
  type CodexRateLimitResetRefusalCode,
} from '@orbit/shared';
import { api, ApiError } from '../api';
import {
  CODEX_RESET_CLIENT_TIMING,
  CODEX_RESET_HIDDEN_REFUSALS,
  CODEX_RESET_REFUSAL_REASON,
  clearCodexResetIntent,
  codexResetCard,
  codexResetCountLabel,
  codexResetCreateFailure,
  codexResetExpiry,
  codexResetFreshness,
  codexResetLookUp,
  codexResetOperationActive,
  codexResetResume,
  codexResetStatusCopy,
  decodeCodexResetOperation,
  decodeCodexResetOperations,
  readCodexResetIntent,
  writeCodexResetIntent,
  type CodexResetCard,
  type CodexResetIntent,
  type CodexResetRunner,
  type CodexResetStatusCopy,
  type CodexResetTone,
} from '../lib/codexResetCredit';
import { runnersQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { compatibleUuid } from '../lib/uuid';

/** Where a reset is confirmed from: the runner whose default Codex account it spends, and the
 *  workspace whose composer asked, which the create route checks for an account override. */
export interface CodexResetContext {
  runner: CodexResetRunner;
  workspaceId?: string;
}

type CreatePhase =
  | { phase: 'idle' }
  | { phase: 'sending'; again: boolean }
  | { phase: 'retrying' }
  | { phase: 'unanswered' };

type Notice =
  | { kind: 'refused'; code: CodexRateLimitResetRefusalCode }
  | { kind: 'rejected'; status: number };

export interface CodexResetCreditState {
  card: CodexResetCard | null;
  /** The operation this page follows: its own confirmation's, or one already in flight. */
  operation: CodexRateLimitResetOperationView | null;
  /** The last poll for that operation failed, so what is drawn may be behind. */
  operationLagging: boolean;
  create: CreatePhase;
  notice: Notice | null;
  /** A refusal saying the entry does not belong here at all (§6.1's hide answers). */
  hiddenBy: CodexRateLimitResetRefusalCode | null;
  now: Date;
  runnerOnline: boolean;
  accountChanged: boolean;
  /** Something is under way that the pill says even while the popover is closed. */
  busy: boolean;
  confirmOpen: boolean;
  openConfirm: () => void;
  cancelConfirm: () => void;
  confirm: () => void;
  retry: () => void;
  dismiss: () => void;
  restoreFocus: () => void;
  statusRef: RefObject<HTMLDivElement | null>;
  useButtonRef: RefObject<HTMLButtonElement | null>;
}

const operationsKey = (runnerId: string | undefined) => ['codex-rate-limit-reset', runnerId, 'operations'] as const;
const operationKey = (runnerId: string | undefined, operationId: string | undefined) =>
  ['codex-rate-limit-reset', runnerId, 'operation', operationId] as const;

function announce(toast: ReturnType<typeof useToast>, copy: CodexResetStatusCopy): void {
  const text = `${copy.title}. ${copy.detail}`;
  if (copy.tone === 'success') toast.success(text);
  else if (copy.tone === 'error') toast.error(text);
  else if (copy.tone === 'warning') toast.warning(text);
  else toast.info(text);
}

/**
 * One runner's reset credit, for the Plan usage popover: the card, the confirmation and the
 * operation it becomes. The API calls are the operation API alone (§6.1); what this browser keeps is
 * its own confirmation — the clientRequestId minted when the user confirmed — so a second press, a
 * create that timed out and a reload all come back to the same operation instead of starting another.
 */
export function useCodexResetCredit(
  context: CodexResetContext | undefined,
  visible: boolean,
  /** Where focus goes when the control that had it is gone and no enabled entry replaces it. */
  fallbackFocus?: () => void,
): CodexResetCreditState {
  const qc = useQueryClient();
  const toast = useToast();
  const runner = context?.runner;
  const runnerId = runner?.id;
  const workspaceId = context?.workspaceId;

  const [now, setNow] = useState(() => new Date());
  const [intent, setIntent] = useState<CodexResetIntent | null>(null);
  const [attachedId, setAttachedId] = useState<string | null>(null);
  const [create, setCreate] = useState<CreatePhase>({ phase: 'idle' });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [hiddenBy, setHiddenBy] = useState<CodexRateLimitResetRefusalCode | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const useButtonRef = useRef<HTMLButtonElement>(null);
  /** A create is on the wire. Checked synchronously, so a double press cannot send two. */
  const sending = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announced = useRef<string | null>(null);
  const dismissed = useRef(new Set<string>());
  const confirmed = useRef(false);

  const remember = useCallback(
    (next: CodexResetIntent | null) => {
      if (!runnerId) return;
      if (next) writeCodexResetIntent(next);
      else clearCodexResetIntent(runnerId);
      setIntent(next);
    },
    [runnerId],
  );

  const offered = runner ? codexResetCard(runner, now, false) !== null : false;
  const operations = useQuery({
    queryKey: operationsKey(runnerId),
    queryFn: async () => {
      const decoded = decodeCodexResetOperations(await api(`/runners/${runnerId}/codex-rate-limit-reset`));
      if (!decoded) throw new Error('unreadable reset operations');
      return decoded;
    },
    enabled: !!runnerId && (offered || intent !== null),
    refetchInterval: (query) => (query.state.data?.active ? CODEX_RESET_CLIENT_TIMING.pollMs : false),
    staleTime: 10_000,
  });

  const operationId = intent?.operationId ?? attachedId ?? undefined;
  const followed = useQuery({
    queryKey: operationKey(runnerId, operationId),
    queryFn: async () => {
      const op = decodeCodexResetOperation(
        await api(`/runners/${runnerId}/codex-rate-limit-reset/${encodeURIComponent(operationId ?? '')}`),
      );
      if (!op) throw new Error('unreadable reset operation');
      return op;
    },
    enabled: !!runnerId && !!operationId,
    // §6.1: every 2–3 s until the operation settles; an unreadable or failed poll keeps polling.
    refetchInterval: (query) =>
      query.state.data && !codexResetOperationActive(query.state.data) ? false : CODEX_RESET_CLIENT_TIMING.pollMs,
    retry: false,
  });
  const operation = operationId ? (followed.data ?? null) : null;

  const send = async (target: CodexResetIntent, attempt: number, again: boolean): Promise<void> => {
    if (!runnerId || !target.clientRequestId || sending.current) return;
    sending.current = true;
    clearTimeout(retryTimer.current);
    setNotice(null);
    setCreate(attempt === 0 ? { phase: 'sending', again } : { phase: 'retrying' });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), CODEX_RESET_CLIENT_TIMING.postTimeoutMs);
    let retryIn: number | null = null;
    try {
      const response = await api<{ operation?: unknown } | undefined>(`/runners/${runnerId}/codex-rate-limit-reset`, {
        method: 'POST',
        body: {
          clientRequestId: target.clientRequestId,
          accountFingerprint: target.accountFingerprint,
          ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
        },
        signal: abort.signal,
      });
      const op = decodeCodexResetOperation(response?.operation);
      // A 2xx this page cannot read still created (or replayed) the operation: asking again under
      // the same id is how to learn which one it is.
      if (!op) throw new Error('unreadable reset operation');
      qc.setQueryData(operationKey(runnerId, op.id), op);
      remember({ ...target, operationId: op.id });
      setCreate({ phase: 'idle' });
    } catch (error) {
      const failure = codexResetCreateFailure(error);
      if (failure.kind === 'refused' && failure.code === 'OPERATION_IN_FLIGHT' && failure.operationId) {
        // This confirmation created nothing; the operation in the way is another one. Follow that.
        remember({
          v: 1,
          runnerId,
          accountFingerprint: target.accountFingerprint,
          confirmedAt: target.confirmedAt,
          operationId: failure.operationId,
        });
        setCreate({ phase: 'idle' });
      } else if (failure.kind !== 'unanswered') {
        remember(null);
        setCreate({ phase: 'idle' });
        if (failure.kind === 'refused') {
          setNotice({ kind: 'refused', code: failure.code });
          if (CODEX_RESET_HIDDEN_REFUSALS.has(failure.code)) setHiddenBy(failure.code);
        } else {
          setNotice({ kind: 'rejected', status: failure.status });
        }
        void qc.invalidateQueries({ queryKey: runnersQuery().queryKey });
      } else if (attempt < CODEX_RESET_CLIENT_TIMING.retryDelaysMs.length) {
        retryIn = CODEX_RESET_CLIENT_TIMING.retryDelaysMs[attempt];
        setCreate({ phase: 'retrying' });
      } else {
        setCreate({ phase: 'unanswered' });
      }
    } finally {
      clearTimeout(timeout);
      sending.current = false;
    }
    if (retryIn !== null) {
      retryTimer.current = setTimeout(() => void sendRef.current(target, attempt + 1, true), retryIn);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // A page that finds a remembered confirmation picks it back up (see codexResetResume).
  useEffect(() => {
    setIntent(null);
    setAttachedId(null);
    setCreate({ phase: 'idle' });
    setNotice(null);
    announced.current = null;
    if (!runnerId) return;
    const stored = readCodexResetIntent(runnerId);
    if (stored) {
      const step = codexResetResume(stored, new Date());
      if (step === 'forget') {
        clearCodexResetIntent(runnerId);
      } else {
        setIntent(stored);
        if (stored.settledAt) announced.current = stored.operationId ?? null;
        if (step === 'send-again') void sendRef.current(stored, 0, true);
      }
    }
    return () => clearTimeout(retryTimer.current);
  }, [runnerId]);

  // An account override is the workspace's, so moving to another workspace asks again.
  useEffect(() => setHiddenBy(null), [workspaceId]);

  // Past the consume deadline an unanswered confirmation is only looked for, never sent again.
  useEffect(() => {
    if (!intent || intent.operationId || !operations.data) return;
    if (codexResetResume(intent, new Date()) !== 'look-up') return;
    const found = codexResetLookUp(intent, operations.data);
    remember(found ? { ...intent, operationId: found.id } : null);
  }, [intent, operations.data, remember]);

  // An operation in flight that this page did not start — another tab, another device — is followed
  // rather than raced: the create route would refuse a second one anyway.
  const listedActive = operations.data?.active ?? null;
  useEffect(() => {
    if (!listedActive || intent || attachedId === listedActive.id || dismissed.current.has(listedActive.id)) return;
    setAttachedId(listedActive.id);
  }, [listedActive, intent, attachedId]);

  // The runner no longer has that operation (deleted, or not this runner's): stop following it.
  useEffect(() => {
    if (!(followed.error instanceof ApiError) || followed.error.status !== 404) return;
    if (intent?.operationId === operationId) remember(null);
    setAttachedId(null);
  }, [followed.error, intent, operationId, remember]);

  const runnerOnline = runner?.online === true;
  const block = runner ? codexRateLimitResetOf(runner.planUsage) : undefined;
  const accountChanged = !!operation && !!block && block.accountFingerprint !== operation.accountFingerprint;

  // A settled operation refreshes what it changed, and a result nobody has seen yet is announced once.
  const settled = operation && !codexResetOperationActive(operation) ? operation : null;
  useEffect(() => {
    if (!runnerId || !settled) return;
    void qc.invalidateQueries({ queryKey: runnersQuery().queryKey });
    void qc.invalidateQueries({ queryKey: operationsKey(runnerId) });
    if (intent?.operationId !== settled.id || intent.settledAt) return;
    remember({ ...intent, settledAt: new Date().toISOString() });
    if (announced.current === settled.id) return;
    announced.current = settled.id;
    announce(toast, codexResetStatusCopy(settled, { runnerOnline, accountChanged }));
    // Keyed on the settled status alone: the effect is the transition, not every re-render after it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerId, settled?.id, settled?.status]);

  const shown = offered || !!operation;
  useEffect(() => {
    if (!shown) return;
    setNow(new Date());
    const tick = setInterval(() => setNow(new Date()), CODEX_RESET_CLIENT_TIMING.clockTickMs);
    return () => clearInterval(tick);
  }, [shown, visible]);

  const active = !!operation && codexResetOperationActive(operation);
  const card = runner ? codexResetCard(runner, now, !!listedActive || active, operations.data) : null;
  const busy = create.phase === 'sending' || create.phase === 'retrying' || active;

  const openConfirm = () => {
    if (card?.availability.kind !== 'ready' || busy || intent) return;
    confirmed.current = false;
    setConfirmOpen(true);
  };

  const confirm = () => {
    if (!runnerId || sending.current) return;
    setConfirmOpen(false);
    confirmed.current = true;
    // One confirmation, one clientRequestId. A remembered confirmation that has not settled is this
    // same intent pressed again: send it again if nothing answered it, and never mint a second id.
    if (intent && !intent.settledAt) {
      if (!intent.operationId && intent.clientRequestId) void send(intent, 0, true);
      return;
    }
    if (!card || card.availability.kind !== 'ready') return;
    const target: CodexResetIntent = {
      v: 1,
      runnerId,
      clientRequestId: compatibleUuid(),
      accountFingerprint: card.accountFingerprint,
      confirmedAt: new Date().toISOString(),
      ...(workspaceId ? { workspaceId } : {}),
    };
    remember(target);
    void send(target, 0, false);
  };

  const retry = () => {
    if (intent?.clientRequestId && !intent.operationId) void send(intent, 0, true);
  };

  /** The entry when it can take focus, otherwise the popover itself — never the page body. */
  const focusEntry = () => {
    const use = useButtonRef.current;
    if (use && !use.disabled) use.focus();
    else fallbackFocus?.();
  };

  const dismiss = () => {
    if (operation) dismissed.current.add(operation.id);
    remember(null);
    setAttachedId(null);
    setNotice(null);
    setCreate({ phase: 'idle' });
    // The button that pressed this is gone; land on what replaces it once it has rendered.
    setTimeout(focusEntry, 0);
  };

  return {
    card,
    operation,
    operationLagging: !!operation && active && followed.isError,
    create,
    notice,
    hiddenBy,
    now,
    runnerOnline,
    accountChanged,
    busy,
    confirmOpen,
    openConfirm,
    cancelConfirm: () => setConfirmOpen(false),
    confirm,
    retry,
    dismiss,
    restoreFocus: () => (confirmed.current ? statusRef.current?.focus() : focusEntry()),
    statusRef,
    useButtonRef,
  };
}

const TONE_ICON: Record<CodexResetTone, ReactNode> = {
  progress: <LoadingOutlined />,
  success: <CheckCircleFilled />,
  info: <InfoCircleFilled />,
  warning: <ExclamationCircleFilled />,
  error: <CloseCircleFilled />,
};

const fmtDay = (iso: string): string => {
  const date = new Date(iso);
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
};

const fmtFull = (iso: string): string => new Date(iso).toLocaleString();

/** The one status line the card carries, most immediate first: the create on the wire, then the
 *  operation it became, then why a create was refused. */
export function codexResetStatusOf(state: CodexResetCreditState): CodexResetStatusCopy | null {
  const { create, operation, notice } = state;
  if (create.phase === 'sending') {
    return create.again
      ? {
          tone: 'progress',
          spent: 'maybe',
          title: 'Checking the reset request…',
          detail: 'Sending the same request again, so at most 1 credit is used.',
        }
      : { tone: 'progress', spent: 'not-yet', title: 'Sending reset request…', detail: 'No credit has been used yet.' };
  }
  if (create.phase === 'retrying') {
    return {
      tone: 'progress',
      spent: 'maybe',
      title: 'Couldn’t reach Orbit — retrying…',
      detail: 'Sending the same request again, so at most 1 credit is used.',
    };
  }
  if (create.phase === 'unanswered') {
    return {
      tone: 'warning',
      spent: 'maybe',
      title: 'Couldn’t confirm the reset request',
      detail: 'Orbit didn’t answer. Retry sends the same request, so at most 1 credit is used.',
    };
  }
  if (operation) {
    return codexResetStatusCopy(operation, { runnerOnline: state.runnerOnline, accountChanged: state.accountChanged });
  }
  if (notice) {
    return {
      tone: 'warning',
      spent: 'no',
      title: 'Couldn’t start the reset',
      detail: `${
        notice.kind === 'refused'
          ? CODEX_RESET_REFUSAL_REASON[notice.code]
          : `Orbit refused the request (HTTP ${notice.status}).`
      } No credit was used.`,
    };
  }
  return null;
}

/** The reset credit section under the usage windows: count, expiry, freshness, and the one action. */
export function CodexResetCreditCard({ state }: { state: CodexResetCreditState }) {
  const headingId = useId();
  const reasonId = useId();
  const { card, operation, create, notice, hiddenBy } = state;
  const status = codexResetStatusOf(state);
  if ((!card && !status) || (hiddenBy && !status)) return null;
  const expiry = card ? codexResetExpiry(card.block, fmtDay) : null;
  const freshness = card ? codexResetFreshness(card.block, state.now) : null;
  const settled = !!operation && !codexResetOperationActive(operation);
  const blocked = card?.availability.kind === 'blocked' ? card.availability : null;
  const offerUse = !!card && !operation && !notice && create.phase === 'idle' && card.availability.kind !== 'in-flight';

  return (
    <section className="cu-rc" aria-labelledby={headingId}>
      {card ? (
        <div className="cu-rc-card">
          <SafetyCertificateOutlined className="cu-rc-icon" aria-hidden="true" />
          <div className="cu-rc-body">
            <div className="cu-rc-title" id={headingId}>
              Reset credit
            </div>
            <div className="cu-rc-count">{codexResetCountLabel(card.details)}</div>
            {expiry && (
              <div className="cu-rc-meta" title={expiry.at ? fmtFull(expiry.at) : undefined}>
                {expiry.label}
              </div>
            )}
            {freshness && (
              <div
                className={`cu-rc-meta${freshness.stale ? ' cu-rc-stale' : ''}`}
                title={fmtFull(card.block.fetchedAt)}
              >
                {freshness.label}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="cu-rc-title" id={headingId}>
          Reset credit
        </div>
      )}
      <div ref={state.statusRef} className="cu-rc-live" role="status" aria-live="polite" tabIndex={-1}>
        {status && (
          <div className={`cu-rc-status cu-rc-status--${status.tone}`}>
            <span className="cu-rc-status-icon" aria-hidden="true">
              {TONE_ICON[status.tone]}
            </span>
            <div>
              <div className="cu-rc-status-title">{status.title}</div>
              <div>{status.detail}</div>
              {state.operationLagging && <div>Reconnecting to Orbit…</div>}
            </div>
          </div>
        )}
      </div>
      {card?.availability.kind === 'in-flight' && !operation && create.phase === 'idle' && (
        <div className="cu-rc-reason">{CODEX_RESET_REFUSAL_REASON.OPERATION_IN_FLIGHT}</div>
      )}
      {offerUse && !hiddenBy && (
        <>
          <Button
            ref={state.useButtonRef}
            type="primary"
            block
            disabled={!!blocked}
            aria-haspopup="dialog"
            aria-describedby={blocked ? reasonId : undefined}
            onClick={state.openConfirm}
          >
            Use reset credit
          </Button>
          {blocked && (
            <div id={reasonId} className="cu-rc-reason">
              {blocked.reason}
            </div>
          )}
        </>
      )}
      {(settled || notice || create.phase === 'unanswered') && (
        <div className="cu-rc-actions">
          {create.phase === 'unanswered' && (
            <Button size="small" type="primary" onClick={state.retry}>
              Retry
            </Button>
          )}
          <Button size="small" onClick={state.dismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </section>
  );
}

/** The second confirmation: what the press spends, before anything is sent. */
export function CodexResetConfirm({ state, usagePercent }: { state: CodexResetCreditState; usagePercent: number }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const card = state.card;
  const expiry = card ? codexResetExpiry(card.block, fmtDay) : null;
  return (
    <Modal
      open={state.confirmOpen}
      title="Use reset credit?"
      width={440}
      onCancel={state.cancelConfirm}
      // Cancel is where focus starts: the safe answer to an action that can't be undone. Closing
      // puts it back on the entry that opened this, or on the status line a confirmation started.
      afterOpenChange={(open) => (open ? cancelRef.current?.focus() : state.restoreFocus())}
      focusable={{ focusTriggerAfterClose: false }}
      // The Plan usage popover stays open underneath, and antd stacks popovers (1030) above modals
      // (1000): without this the popover would sit on top of the confirmation's own buttons.
      zIndex={1100}
      destroyOnHidden
      footer={[
        <Button key="cancel" ref={cancelRef} onClick={state.cancelConfirm}>
          Cancel
        </Button>,
        <Button key="use" type="primary" onClick={state.confirm}>
          Use reset
        </Button>,
      ]}
    >
      <p className="cu-rc-confirm-text">
        This consumes 1 earned credit and resets eligible Codex usage windows. This action can’t be undone.
      </p>
      <div className="cu-rc-confirm-usage">
        <span>Current usage</span>
        <span className="cu-rc-confirm-value">{usagePercent}% → reset</span>
      </div>
      <p className="cu-rc-confirm-note">
        {card ? `${codexResetCountLabel(card.details)}${expiry ? ` · ${expiry.label}` : ''}. ` : ''}
        Your conversations and their context aren’t affected.
      </p>
    </Modal>
  );
}
