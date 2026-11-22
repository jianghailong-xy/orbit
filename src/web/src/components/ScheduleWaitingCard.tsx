import { useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  SCHEDULE_COPY,
  SCHEDULE_WAITING_KINDS,
  scheduleApprovalWaiting,
  scheduleEnvelopeTitle,
  scheduleFailedWaiting,
  scheduleHeldWaiting,
  scheduleKeepLabel,
  scheduleWidenWaitingText,
  type ScheduleEnvelope,
  type ScheduleEnvelopeLines,
  type ScheduleRule,
  type ScheduleWaitingKind,
} from '@orbit/shared';
import { api, type ApprovalInfo, type PermissionRule } from '../api';
import { WAITING_ON_YOU, type OwnerRequest } from '../lib/ownerRequests';
import { scheduleDetailQuery, scheduleRequestQuery, scheduleRunSessionPath, schedulePath, viewerTimezone } from '../lib/schedules';
import type { SessionReach } from '../lib/sessionReach';
import { ago, sameResourceId } from '../lib/watches';
import { rememberRulesFor } from './ApprovalPanel';
import { CardActionButton, CardActions } from './CardAction';
import { scheduleErrorText } from './ScheduleCards';
import './OwnerRequest.css';
import './Scheduled.css';

const C = SCHEDULE_COPY;
/** A run waits this long for an approval before it fails (failureReasons.APPROVAL_TIMEOUT). */
const APPROVAL_WAIT_MS = 2 * 60 * 60_000;

export function isScheduleWaitingKind(kind: string): kind is ScheduleWaitingKind {
  return (SCHEDULE_WAITING_KINDS as readonly string[]).includes(kind);
}

function envelopeOf(lines: ScheduleEnvelopeLines): ScheduleEnvelope {
  return {
    workspaceId: lines.runsIn.workspaceId,
    accessLevel: lines.may.accessLevel,
    runsPerWeek: lines.costs.runsPerWeek,
    runLimitMinutes: lines.costs.runLimitMinutes,
  };
}

interface Door {
  label: string;
  primary?: boolean;
  /** A door that only goes somewhere leaves the card as it is. */
  navigates?: boolean;
  run: () => Promise<unknown> | void;
}

interface Drawn {
  title: string;
  kind: string;
  body: JSX.Element | string;
  doors: Door[];
}

/**
 * A scheduled task's item in Waiting on you (board 2/2 ④), in the owner-request card's frame: a failure, a hold, a
 * run's approval with Always allow, and a run's request for a wider envelope. Each is answered through the door of
 * what it points at, not the generic done / decline: only a failure is the owner's to dismiss here.
 */
export function ScheduleWaitingCard({ request, now = Date.now() }: { request: OwnerRequest; now?: number }): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const timezone = viewerTimezone();
  const scheduleId = request.scheduleId ?? '';
  const detail = useQuery({ ...scheduleDetailQuery(scheduleId), enabled: Boolean(scheduleId) });
  const approvals = useQuery({
    queryKey: ['session-approvals', request.askedBySessionId] as const,
    meta: { entities: ['session'], sessionReach: { session: request.askedBySessionId } satisfies SessionReach },
    queryFn: () => api<ApprovalInfo[]>(`/sessions/${encodeURIComponent(request.askedBySessionId)}/approvals?status=PENDING`),
    enabled: request.kind === 'SCHEDULE_APPROVAL',
  });
  const card = useQuery({
    ...scheduleRequestQuery(request.scheduleChangeRequestId ?? ''),
    enabled: request.kind === 'SCHEDULE_WIDEN' && Boolean(request.scheduleChangeRequestId),
  });
  const [done, setDone] = useState(false);
  const act = useMutation({
    mutationFn: async (door: Door) => {
      await door.run();
    },
    onSuccess: (_answer, door) => {
      if (!door.navigates) setDone(true);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['owner-requests'] });
      void qc.invalidateQueries({ queryKey: ['schedules'] });
    },
  });

  const schedule = detail.data?.schedule;
  const title = schedule?.title ?? request.title;
  const runs = detail.data?.recentRuns ?? [];
  const run = (request.scheduleRunId ? runs.find((r) => sameResourceId(r.id, request.scheduleRunId!)) : null)
    ?? detail.data?.lastRun ?? null;
  const nowDate = new Date(now);
  const post = (path: string) => api(path, { method: 'POST' });
  const schedulePathOf = `/schedules/${encodeURIComponent(scheduleId)}`;

  let drawn: Drawn = { title: request.title, kind: C.waiting.kinds.schedule, body: request.why, doors: [] };
  if (request.kind === 'SCHEDULE_FAILED' && run) {
    const text = scheduleFailedWaiting({
      title,
      consecutiveFailures: schedule?.consecutiveFailures ?? 1,
      run,
      timezone,
    });
    const runPath = scheduleRunSessionPath(run);
    drawn = {
      title: text.title,
      kind: text.kind,
      body: text.body,
      doors: [
        { label: text.actions[0]!, primary: true, navigates: true, run: () => { if (runPath) navigate(runPath); } },
        {
          label: text.actions[1]!,
          // Pausing settles the failure: the item is the owner's to dismiss, and pausing is how they answered it.
          run: async () => {
            await post(`${schedulePathOf}/pause`);
            await post(`/owner-requests/${encodeURIComponent(request.id)}/done`);
          },
        },
      ],
    };
  } else if (request.kind === 'SCHEDULE_HELD' && schedule) {
    const text = scheduleHeldWaiting({
      title,
      heldReason: schedule.heldReason,
      plannedAt: run?.plannedAt ?? schedule.nextDueAt ?? request.createdAt,
      agentName: schedule.agentName,
      workspaceName: schedule.workspaceName,
      now: nowDate,
      timezone,
    });
    const agent = schedule.heldReason === 'AGENT_DISABLED' || schedule.heldReason === 'AGENT_MISSING';
    drawn = {
      title: text.title,
      kind: text.kind,
      body: text.body,
      doors: [
        {
          label: text.actions[0]!,
          primary: true,
          navigates: true,
          run: () => navigate(agent ? `/settings/workspaces/${encodeURIComponent(schedule.workspaceId)}` : schedulePath(schedule.id)),
        },
        { label: text.actions[1]!, run: () => post(`${schedulePathOf}/resume`) },
      ],
    };
  } else if (request.kind === 'SCHEDULE_APPROVAL') {
    const approval: ApprovalInfo | undefined = (approvals.data ?? []).find((a) => sameResourceId(a.id, request.approvalId ?? ''));
    if (approval) {
      const rules = rememberRulesFor(approval);
      const pattern = rules.map((r) => r.ruleContent || r.toolName).join(', ');
      const text = scheduleApprovalWaiting({
        title,
        deadline: new Date(Date.parse(approval.createdAt) + APPROVAL_WAIT_MS).toISOString(),
        nextAt: schedule?.nextDueAt ?? null,
        pattern,
        workspaceName: schedule?.workspaceName ?? '',
        now: nowDate,
        timezone,
      });
      const command = approval.input && typeof approval.input === 'object'
        ? (approval.input as { command?: unknown }).command
        : undefined;
      // The approval card's own door (POST /sessions/:id/approvals/:approvalId/decision), as ApprovalPanel answers it.
      const decide = (behavior: 'allow' | 'deny', remember?: boolean) => {
        const body: { behavior: string; rememberRules?: PermissionRule[] } = { behavior };
        if (remember) body.rememberRules = rules;
        return api(`/sessions/${encodeURIComponent(approval.sessionId)}/approvals/${encodeURIComponent(approval.id)}/decision`, {
          method: 'POST',
          body,
        });
      };
      drawn = {
        title: text.title,
        kind: text.kind,
        body: (
          <>
            {typeof command === 'string' ? <code className="sched-command">{command}</code> : null}
            <p>{text.body} {pattern ? text.alwaysAllow : null}</p>
          </>
        ),
        doors: [
          ...(rules.length > 0 ? [{ label: text.actions[0]!, primary: true, run: () => decide('allow', true) }] : []),
          { label: text.actions[1]!, primary: rules.length === 0, run: () => decide('allow') },
          { label: text.actions[2]!, run: () => decide('deny') },
        ],
      };
    }
  } else if (request.kind === 'SCHEDULE_WIDEN' && card.data?.kind === 'UPDATE') {
    const env = card.data.envelope;
    const names: Record<string, string> = {};
    for (const lines of [env.now, env.asked]) {
      if (lines?.runsIn.workspaceName) names[lines.runsIn.workspaceId] = lines.runsIn.workspaceName;
    }
    const asked = envelopeOf(env.asked);
    const decided = card.data.state !== 'PENDING';
    drawn = {
      title: scheduleEnvelopeTitle(card.data.title ?? title, env.widens, names[asked.workspaceId], asked.accessLevel),
      kind: C.waiting.kinds.schedule,
      body: scheduleWidenWaitingText({
        reason: run?.summary ?? '',
        widens: env.widens,
        now: env.now ? envelopeOf(env.now) : null,
        asked,
        ruleNow: schedule?.rule ?? null,
        ruleAsked: (card.data.proposed?.rule as ScheduleRule | undefined) ?? null,
        workspaceNames: names,
      }),
      doors: decided ? [] : [
        { label: C.actions.allow, primary: true, run: () => post(`/schedule-requests/${encodeURIComponent(card.data!.id)}/allow`) },
        {
          label: scheduleKeepLabel(env.widens, env.now ? envelopeOf(env.now) : null, env.now ? names[env.now.runsIn.workspaceId] : undefined),
          run: () => post(`/schedule-requests/${encodeURIComponent(card.data!.id)}/decline`),
        },
      ],
    };
  }

  const error = scheduleErrorText(act.error);
  return (
    <section className="owner-request-card" id={`owner-request-${request.id}`} data-kind={request.kind}>
      <header className="owner-request-head">
        <span className="owner-request-dot" aria-hidden="true" />
        <span className="owner-request-waiting">{WAITING_ON_YOU}</span>
        <span className="owner-request-age">{ago(request.createdAt, now)}</span>
      </header>
      <div className="owner-request-body">
        <div className="owner-request-title-row">
          <h3 className="owner-request-title">{drawn.title}</h3>
          <span className="owner-request-kind">{drawn.kind}</span>
        </div>
        <div className="owner-request-why md">{typeof drawn.body === 'string' ? <p>{drawn.body}</p> : drawn.body}</div>
        {error ? <p className="sched-error" role="alert">{error}</p> : null}
        {drawn.doors.length > 0 && !done ? (
          <CardActions className="owner-request-actions">
            {drawn.doors.map((door) => (
              <CardActionButton
                key={door.label}
                tone={door.primary ? 'primary' : 'secondary'}
                disabled={act.isPending}
                onClick={() => act.mutate(door)}
              >
                {door.label}
              </CardActionButton>
            ))}
          </CardActions>
        ) : null}
      </div>
    </section>
  );
}
