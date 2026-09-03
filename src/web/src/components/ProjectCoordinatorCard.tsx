import type { CSSProperties, ReactNode } from 'react';
import { Button } from 'antd';
import { SessionRunState, type SessionLifecycleState } from '@orbit/shared';

/**
 * A project's coordination session, drawn as the four states it can actually be in.
 *
 * Replaces the one-button Coordinator section ProjectsPage used to carry below the fields, which
 * drew one state: a button that said *Open coordinator* whatever the truth was. Pressing it when
 * the conversation was in Trash silently opened a blank new one; pressing it when the workspace
 * was disabled returned the same 409 forever behind a *Retry* that could never succeed; and the
 * first press bound the project to a workspace, permanently, without ever saying so.
 *
 * Reads `GET /projects/:id/coordinator/status`, whose shape is frozen in
 * `docs/project-coordinator-status-contract.md`. Every field this card renders comes from that
 * payload; the one exception is `openTaskCount`, which the payload deliberately does not carry
 * (task tallies are the panorama's job) and the page passes in.
 *
 * PRESENTATIONAL, ON PURPOSE. It issues no request and performs no navigation: it reports one
 * `CoordinatorAction` and lets the caller decide what that means. A static render cannot press a
 * button, so handing the whole payload in is the only way to assert what each of the four states
 * puts on screen.
 */

export type CoordinatorState = 'NEVER_OPENED' | 'LIVE' | 'TRASHED' | 'UNAVAILABLE';

export type CoordinatorRefusalDetail =
  | 'WORKSPACE_TRASHED'
  | 'WORKSPACE_DISABLED'
  | 'WORKSPACE_UNBOUND'
  | 'WORKSPACE_FORGOTTEN'
  | 'NO_TASK_ASSIGNEE';

/** The `coordination.session` object. Every field is emitted for every state — which of them a
 *  given state's layout reads is the contract's "What each state needs" table, not the wire. */
export interface CoordinatorSession {
  id: string;
  title: string;
  runStatus: string;
  runState: SessionRunState;
  lifecycleState: SessionLifecycleState;
  filingState: string;
  endReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  completedAt: string | null;
  deletedAt: string | null;
  engineTurnActive: boolean;
  pendingApprovals: number;
}

export interface CoordinatorStatus {
  projectId: string;
  /** The clock the handler stamped once at the top of the read. Every relative time on this card
   *  is measured against it, so the card never disagrees with the payload it was handed. */
  readAt: string;
  state: CoordinatorState;
  coordination: {
    sessionId: string | null;
    sessionIdAbsentReason: string | null;
    session: CoordinatorSession | null;
    sessionAbsentReason: string | null;
    /** Decimal string, 0-based: a project's FIRST coordinator is generation "0". */
    coordinatorGeneration: string;
    workspaceId: string | null;
    workspaceIdAbsentReason: string | null;
    workspaceName: string | null;
    workspaceNameAbsentReason: string | null;
    agentId: string | null;
    agentIdAbsentReason: string | null;
    agentName: string | null;
    agentNameAbsentReason: string | null;
  };
  openability: {
    canOpen: boolean;
    willCreate: boolean;
    refusalCode: 'COORDINATOR_UNAVAILABLE' | 'NO_LANDING_WORKSPACE' | null;
    refusalDetail: CoordinatorRefusalDetail | null;
    refusalCodeAbsentReason: string | null;
    requiredAction: string | null;
    requiredActionAbsentReason: string | null;
    landing: {
      workspaceId: string | null;
      workspaceIdAbsentReason: string | null;
      workspaceName: string | null;
      workspaceNameAbsentReason: string | null;
      agentId: null;
      agentName: null;
      /** True when the project already records a coordination workspace: the replacement has
       *  nowhere else it could open. */
      fixed: boolean;
    };
  };
}

/** What the card asks the page to do. One callback rather than six, because which of these a
 *  press means is decided here and what it costs is decided there. */
export type CoordinatorAction =
  | 'open'
  | 'start'
  | 'restore-session'
  | 'change-workspace'
  | 'enable-workspace'
  | 'restore-workspace'
  | 'bind-workspace'
  | 'rebind-workspace';

/** The command-centre parent owns width. The layout marker remains part of the presentational
 *  contract so responsive variants can be introduced without making this card read the viewport. */
export type CoordinatorCardLayout = 'desktop' | 'narrow';

type Tone = 'neutral' | 'brand' | 'warning' | 'error';

/** Colour NEVER travels alone: every pill carries its label as text, and the three glyphs let the
 *  four tones be told apart without reading colour at all — Orbit's own tokens do not separate
 *  under CVD (see ProjectPanoramaHeader's palette note). Tokens only, from index.css. */
const TONES: Record<Tone, { fg: string; bg: string; mark: string; border: string }> = {
  neutral: { fg: 'var(--text-2)', bg: 'var(--fill-muted)', mark: 'var(--text-4)', border: 'var(--border-subtle)' },
  brand: { fg: 'var(--brand-strong)', bg: 'var(--brand-tint)', mark: 'var(--brand)', border: 'var(--brand-border)' },
  warning: { fg: 'var(--warning)', bg: 'var(--warning-bg)', mark: 'var(--warning-solid)', border: 'var(--warning-border)' },
  error: { fg: 'var(--error)', bg: 'var(--error-bg)', mark: 'var(--error-solid)', border: 'var(--error-border)' },
};

type Glyph = 'disc' | 'ring' | 'diamond';

/**
 * The three sub-states a LIVE coordinator shows, exactly as the contract's "Card shows / Predicate"
 * table spells them.
 *
 * The rows are evaluated with `pendingApprovals > 0` FIRST rather than in table order, because a
 * pending approval blocks *inside* the turn: the session is RUNNING while the card is up, so the
 * literal top-down read would answer "Working" for the one case the table added that clause for and
 * leave it unreachable. It is also what the rest of the console already does
 * (`WorkspaceView.tsx:659` puts "Waiting for approval" ahead of "Running").
 *
 * The third row's `lifecycleState !== "TRASH"` clause is not re-tested here: a trashed pointer is
 * the `TRASHED` state, never `LIVE` (the truth table's T column), so this is only ever asked about
 * a session that has already passed it.
 */
function liveSubState(session: CoordinatorSession): { label: string; tone: Tone; glyph: Glyph } {
  if (session.pendingApprovals > 0) return { label: 'Needs you', tone: 'warning', glyph: 'disc' };
  // `isSessionGenerating` — src/apiserver/src/common/session-generating.ts:17.
  if (
    session.runState === SessionRunState.RUNNING
    || (session.runState === SessionRunState.AWAITING_INPUT && session.engineTurnActive)
  ) {
    return { label: 'Working', tone: 'brand', glyph: 'disc' };
  }
  if (session.runState === SessionRunState.AWAITING_INPUT) {
    return { label: 'Needs you', tone: 'warning', glyph: 'disc' };
  }
  // QUEUED, SUCCEEDED, FAILED, INTERRUPTED, ENDED. FAILED sits here on purpose: the server reuses
  // a failed coordinator rather than replacing it, so it is a conversation to reopen.
  return { label: 'Idle', tone: 'neutral', glyph: 'ring' };
}

/** 1st, 2nd, 3rd, 4th — with the 11th/12th/13th exception a naive implementation gets wrong. */
function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Which coordinator of this project a generation is, in words. Generation is 0-based. */
function nth(generation: string, offset = 1): string {
  const n = Number(generation);
  return ordinal(Number.isFinite(n) ? n + offset : offset);
}

/**
 * "last active 12m ago", measured against the payload's own `readAt`.
 *
 * The contract's session carries no `updatedAt`, so the newest of the three timestamps it does
 * carry is what "last active" can honestly mean. Null when none of them is set — a queued
 * coordinator that has never started has no activity to report, and inventing one would be this
 * card asserting a fact.
 */
function lastActive(session: CoordinatorSession, readAt: string): string | null {
  const stamps = [session.startedAt, session.finishedAt, session.completedAt]
    .map((iso) => (iso ? new Date(iso).getTime() : Number.NaN))
    .filter((t) => Number.isFinite(t));
  const now = new Date(readAt).getTime();
  if (stamps.length === 0 || !Number.isFinite(now)) return null;

  const diff = now - Math.max(...stamps);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return 'last active just now';
  if (diff < hour) return `last active ${Math.floor(diff / min)}m ago`;
  if (diff < day) return `last active ${Math.floor(diff / hour)}h ago`;
  return `last active ${Math.floor(diff / day)}d ago`;
}

/** The status pill. `data-tone` and the label live on the SAME element so that "which colour said
 *  what" is answerable from the rendered output rather than from two places that happen to agree. */
function StatusPill({ label, tone, glyph }: { label: string; tone: Tone; glyph: Glyph }) {
  const palette = TONES[tone];
  return (
    <span
      data-tone={tone}
      data-glyph={glyph}
      aria-label={`Coordinator status: ${label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flex: 'none',
        height: 22,
        padding: '0 9px 0 7px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: palette.bg,
        color: palette.fg,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: glyph === 'diamond' ? 7 : 8,
          height: glyph === 'diamond' ? 7 : 8,
          flex: 'none',
          borderRadius: glyph === 'diamond' ? 2 : '50%',
          transform: glyph === 'diamond' ? 'rotate(45deg)' : undefined,
          background: glyph === 'ring' ? 'transparent' : palette.mark,
          border: glyph === 'ring' ? `1.5px solid ${palette.mark}` : undefined,
        }}
      />
      {label}
    </span>
  );
}

/** A workspace name. The square remains a quick visual cue while `IdentityRow` makes the role
 *  explicit instead of leaving the value as an unexplained label. */
function NameChip({ name, tone }: { name: string; tone: 'neutral' | 'brand' }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 12.5,
        fontWeight: 600,
        minWidth: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 9,
          height: 9,
          flex: 'none',
          borderRadius: 2.5,
          background: tone === 'brand' ? 'var(--brand)' : 'var(--text-3)',
        }}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </span>
    </span>
  );
}

function IdentityRow({
  label,
  name,
  tone,
}: {
  label: 'Workspace' | 'Agent';
  name: string;
  tone: 'neutral' | 'brand';
}) {
  return (
    <div
      aria-label={`${label}: ${name}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '72px minmax(0, 1fr)',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{label}</span>
      <NameChip name={name} tone={tone} />
    </div>
  );
}

const BODY: CSSProperties = { fontSize: 13.5, lineHeight: 1.62, color: 'var(--text-2)' };
const MUTED: CSSProperties = { fontSize: 12, lineHeight: 1.6, color: 'var(--text-3)' };
const ACTIONS: CSSProperties = { display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 14 };

/** The one sentence and the one fix that `refusalDetail` picks out. `WORKSPACE_FORGOTTEN` has no
 *  workspace to name — the id was hard-deleted — which is exactly why it has no fix to offer. */
function unavailableCopy(
  detail: CoordinatorRefusalDetail | null,
  workspaceName: string | null,
  requiredAction: string | null,
): { sentence: ReactNode; fix: { label: string; action: CoordinatorAction } | null } {
  const where = workspaceName ? <b style={{ color: 'var(--text-1)' }}>{workspaceName}</b> : 'its workspace';
  switch (detail) {
    case 'WORKSPACE_DISABLED':
      return {
        sentence: <>It runs in {where}, which is disabled — and a coordinator cannot be opened anywhere else.</>,
        fix: workspaceName ? { label: `Enable ${workspaceName}`, action: 'enable-workspace' } : null,
      };
    case 'WORKSPACE_TRASHED':
      return {
        sentence: <>It runs in {where}, which is in Trash — and a coordinator cannot be opened anywhere else.</>,
        fix: workspaceName ? { label: `Restore ${workspaceName}`, action: 'restore-workspace' } : null,
      };
    case 'WORKSPACE_UNBOUND':
      return {
        sentence: <>It runs in {where}, which is not bound to a runner — and a coordinator cannot be opened anywhere else.</>,
        fix: workspaceName ? { label: `Bind ${workspaceName} to a runner`, action: 'bind-workspace' } : null,
      };
    case 'WORKSPACE_FORGOTTEN':
      return {
        sentence: <>This project no longer records the workspace its coordinator ran in, so there is nowhere to reopen it.</>,
        fix: null,
      };
    default:
      // A refusal this build does not know by name still gets the server's own sentence rather
      // than a shrug.
      return { sentence: <>{requiredAction ?? 'The coordinator cannot be opened right now.'}</>, fix: null };
  }
}

export function ProjectCoordinatorCard({
  status,
  layout = 'desktop',
  openTaskCount,
  onAction,
}: {
  status: CoordinatorStatus;
  layout?: CoordinatorCardLayout;
  /** Open tasks in this project. Not in the payload — the card is told, so it can say what the
   *  conversation is FOR. Omitted while the page's own tally is still loading. */
  openTaskCount?: number;
  onAction?: (action: CoordinatorAction) => void;
}) {
  const { coordination } = status;
  const session = coordination.session;
  const live = status.state === 'LIVE' && session ? liveSubState(session) : null;

  const pill: { label: string; tone: Tone; glyph: Glyph } =
    live
    ?? (status.state === 'NEVER_OPENED'
      ? { label: 'Not started', tone: 'neutral', glyph: 'ring' }
      : status.state === 'TRASHED'
        ? { label: 'Deleted', tone: 'neutral', glyph: 'diamond' }
        : { label: 'Cannot be opened', tone: 'error', glyph: 'diamond' });

  // The whole card used to turn amber while it needed a reply, then sat beside a second amber
  // dispatch warning. A slim semantic accent preserves the state without making two large warning
  // surfaces compete. An actual refusal still owns the full error surface because no press can
  // succeed until it is repaired.
  const unavailableSurface = status.state === 'UNAVAILABLE' ? TONES.error : null;
  const liveAccent = live && live.tone !== 'neutral' ? TONES[live.tone] : null;

  return (
    <section
      data-state={status.state}
      data-layout={layout}
      aria-label="Coordinator"
      style={{
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: unavailableSurface ? unavailableSurface.bg : 'var(--bg-raised)',
        border: `1px solid ${unavailableSurface ? unavailableSurface.border : 'var(--border-subtle)'}`,
        boxShadow: liveAccent ? `inset 3px 0 0 ${liveAccent.mark}` : undefined,
        borderRadius: 10,
        padding: '18px 18px 16px',
      }}
    >
      <header
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-1)' }}>
          Coordinator
        </span>
        <StatusPill {...pill} />
      </header>

      {status.state === 'NEVER_OPENED' ? (
        <NeverOpened status={status} onAction={onAction} />
      ) : status.state === 'LIVE' && session ? (
        <Live
          session={session}
          coordination={coordination}
          readAt={status.readAt}
          openTaskCount={openTaskCount}
          needsReply={live?.label === 'Needs you'}
          onAction={onAction}
        />
      ) : status.state === 'TRASHED' ? (
        <Trashed status={status} onAction={onAction} />
      ) : (
        <Unavailable status={status} onAction={onAction} />
      )}
    </section>
  );
}

/** Nothing has ever coordinated this project. Two facts have to land before the button does: work
 *  here never starts on its own, and the first press decides the workspace forever. */
function NeverOpened({
  status,
  onAction,
}: {
  status: CoordinatorStatus;
  onAction?: (action: CoordinatorAction) => void;
}) {
  const { landing, refusalCode, refusalDetail, requiredAction } = status.openability;
  const noLanding = refusalCode === 'NO_LANDING_WORKSPACE' || !landing.workspaceName;

  return (
    <>
      <p style={{ ...BODY, margin: '10px 0 0' }}>
        Tasks in this project <b style={{ color: 'var(--text-1)', fontWeight: 600 }}>never start on their own</b>.
        This conversation is where you and it decide what runs next.
      </p>

      <div
        style={{
          background: 'var(--fill-inset)',
          borderRadius: 8,
          padding: '11px 12px',
          margin: '12px 0 0',
        }}
      >
        {noLanding ? (
          // Nothing to borrow: no task here has an assignee. Said before the press rather than as
          // the 400 after it — and said in the words of the choice the reader is being offered,
          // because the server's own sentence is addressed to a caller who can pass a field.
          <p style={{ ...BODY, margin: 0 }}>
            {refusalDetail === 'NO_TASK_ASSIGNEE'
              ? 'No task here is assigned to a workspace yet, so there is none to borrow. Name the one this conversation runs in.'
              : requiredAction ?? 'There is no workspace to open in yet — name the one this conversation runs in.'}
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Opens in</span>
                <NameChip name={landing.workspaceName as string} tone="neutral" />
              </span>
              <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => onAction?.('change-workspace')}>
                Change
              </Button>
            </div>
            <p style={{ ...MUTED, margin: '5px 0 0' }}>
              Permanent — a coordinator cannot be moved to another workspace later.
            </p>
          </>
        )}
      </div>

      <div style={ACTIONS}>
        {noLanding ? (
          // Not a disabled Start: the press would 400, and what clears that refusal is naming a
          // workspace, which is a thing this card can ask for. The name travels with the open,
          // so this button decides the landing and opens the conversation in one press.
          <Button type="primary" block onClick={() => onAction?.('change-workspace')}>
            Choose a workspace…
          </Button>
        ) : (
          <Button type="primary" block onClick={() => onAction?.('start')}>
            Start coordinator
          </Button>
        )}
      </div>
    </>
  );
}

/** The conversation exists and is reachable: what it is doing, who is doing it and where, and what
 *  is waiting on it. */
function Live({
  session,
  coordination,
  readAt,
  openTaskCount,
  needsReply,
  onAction,
}: {
  session: CoordinatorSession;
  coordination: CoordinatorStatus['coordination'];
  readAt: string;
  openTaskCount?: number;
  needsReply: boolean;
  onAction?: (action: CoordinatorAction) => void;
}) {
  const age = lastActive(session, readAt);
  const which = `${nth(coordination.coordinatorGeneration)} coordinator of this project`;
  const dispatchCopy =
    typeof openTaskCount !== 'number'
      ? 'Open tasks are coordinated from this conversation.'
      : openTaskCount === 0
        ? 'No open tasks remain.'
        : `${openTaskCount} open task${openTaskCount === 1 ? ' is' : 's are'} coordinated from this conversation.`;

  return (
    <>
      <p style={{ margin: '10px 0 0', fontSize: 14, fontWeight: 600, color: 'var(--text-1)' }}>
        {session.title}
      </p>
      <p style={{ ...MUTED, margin: '3px 0 0' }}>{age ? `${age} · ${which}` : which}</p>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '12px 0' }} />

      <div style={{ display: 'grid', gap: 7 }}>
        {coordination.workspaceName ? (
          <IdentityRow label="Workspace" name={coordination.workspaceName} tone="neutral" />
        ) : null}
      </div>

      <div
        style={{
          marginTop: 12,
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--fill-inset)',
        }}
      >
        <div style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-3)', marginBottom: 2 }}>
          Manual dispatch
        </div>
        <div style={{ ...BODY, lineHeight: 1.5 }}>{dispatchCopy}</div>
      </div>

      <div style={ACTIONS}>
        <Button type="primary" block onClick={() => onAction?.('open')}>
          {needsReply ? 'Reply to coordinator' : 'Open coordinator'}
        </Button>
      </div>
    </>
  );
}

/**
 * The pointer names a conversation in Trash, or one that was purged out of it.
 *
 * The button deliberately does not say *Open*: there is nothing to open, and the old spelling is
 * how a whole project's discussion used to disappear behind a blank new session.
 */
function Trashed({
  status,
  onAction,
}: {
  status: CoordinatorStatus;
  onAction?: (action: CoordinatorAction) => void;
}) {
  const { coordination, openability } = status;
  const restorable = coordination.sessionId !== null;
  const title = coordination.session?.title;

  return (
    <>
      <p style={{ ...BODY, margin: '10px 0 0' }}>
        {restorable && title ? <>「{title}」 is in Trash. </> : <>The previous coordinator conversation is gone. </>}
        Starting a new one{' '}
        <b style={{ color: 'var(--text-1)', fontWeight: 600 }}>does not carry that conversation over</b> — the
        replacement opens empty.
      </p>

      {openability.landing.workspaceName ? (
        <p style={{ ...MUTED, margin: '8px 0 0' }}>
          The replacement opens in {openability.landing.workspaceName}
          {openability.landing.fixed ? ', which is fixed for this project and cannot be redirected' : ''}.
        </p>
      ) : null}

      <div style={ACTIONS}>
        <Button type="primary" style={{ flex: 1 }} onClick={() => onAction?.('start')}>
          Start a {nth(coordination.coordinatorGeneration, 2)} coordinator
        </Button>
        {restorable ? <Button onClick={() => onAction?.('restore-session')}>Restore</Button> : null}
      </div>
    </>
  );
}

/**
 * The landing is unusable, so no press can succeed.
 *
 * No *Retry*: the refusal is a property of committed rows, and pressing again returns the same 409
 * forever. Two ways out instead — repair the workspace this project is bound to, or rebind to a
 * different one.
 */
function Unavailable({
  status,
  onAction,
}: {
  status: CoordinatorStatus;
  onAction?: (action: CoordinatorAction) => void;
}) {
  const { coordination, openability } = status;
  const { sentence, fix } = unavailableCopy(
    openability.refusalDetail,
    coordination.workspaceName,
    openability.requiredAction,
  );

  return (
    <>
      <p style={{ ...BODY, margin: '10px 0 0', color: 'var(--text-1)' }}>{sentence}</p>

      <div style={ACTIONS}>
        {fix ? (
          <Button type="primary" size="small" onClick={() => onAction?.(fix.action)}>
            {fix.label}
          </Button>
        ) : null}
        <Button size="small" onClick={() => onAction?.('rebind-workspace')}>
          Rebind workspace…
        </Button>
      </div>
    </>
  );
}
