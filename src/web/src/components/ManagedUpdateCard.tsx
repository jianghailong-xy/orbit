import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ManagedRunnerBuild } from '@orbit/shared';
import {
  RUNNER_UPDATE_NOW,
  RUNNER_UPDATE_NOW_CONFIRM,
  RUNNER_UPDATE_NOW_CONFIRM_ONE,
  RUNNER_UPDATE_NOW_FAILED,
  runnerUpdateNowConfirmMany,
  runnerUpdateNowTitle,
} from '../lib/runnerCopy';
import {
  buildName,
  dropPendingUpdate,
  pendingUpdateAt,
  pendingUpdateTurns,
  managedBusyOf,
  managedUpdateCard,
  managedUpdateNow,
  managedUpdateNowBody,
  managedUpdateNowJobsNote,
  notePendingUpdate,
  readUpdateOutcome,
  settlePendingUpdate,
  type ManagedBusy,
} from '../lib/managedRunnerUpdate';
import { managedRunnerStatusQuery, type ManagedRunner } from '../lib/managedRunner';
import { useToast } from '../lib/toast';
import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';

/** The confirmation's body (board 3): what it does, the turns it stops, and the jobs and services that stop. */
function ManagedUpdateNowDescription({ build, busy }: { build: string; busy: ManagedBusy | null }) {
  const turns = busy?.turns ?? [];
  return (
    <div className="runner-update-now">
      <p>{managedUpdateNowBody(build, turns.length)}</p>
      {turns.length > 0 && (
        <ul className="runner-update-now-turns">
          {turns.map((turn) => (
            <li key={turn.id}>
              <span className="runner-update-now-turn-title">{turn.title}</span>
              {turn.running && <span className="runner-update-now-turn-running">{turn.running}</span>}
            </li>
          ))}
        </ul>
      )}
      {busy && <p className="runner-update-now-jobs">{managedUpdateNowJobsNote(busy.backgroundJobs)}</p>}
    </div>
  );
}

const confirmText = (turns: number) =>
  turns === 0 ? RUNNER_UPDATE_NOW_CONFIRM : turns === 1 ? RUNNER_UPDATE_NOW_CONFIRM_ONE : runnerUpdateNowConfirmMany(turns);

/**
 * Orbit Cloud's Update card (docs/managed-runner-update-now-design.md, boards 2 to 4), shown on its machine page:
 * Available with Update Now…, Restarting, then Updated for a day. A plain press that finds the runner busy is
 * answered 409 with the turns and jobs; the red button then sends `interruptTurns: true`. There is no Later.
 * Only the owner's own managed status reaches here, so only the owner has the button.
 */
export function ManagedUpdateCard({ managed, machine, runnerId, idle, onChange }: { managed: ManagedRunner; machine: string; runnerId: string; idle: boolean; onChange?: () => void }) {
  const qc = useQueryClient();
  const message = useToast();
  const [confirm, confirmation] = useConfirm();
  const [, bump] = useState(0);
  const { status } = managed;
  const interrupted = pendingUpdateTurns(runnerId);
  const notedAt = pendingUpdateAt(runnerId);
  // Only a status read after the note says anything about it: a render with the one shown before the press does not.
  const readAt = qc.getQueryState(managedRunnerStatusQuery().queryKey)?.dataUpdatedAt ?? 0;
  const pending = notedAt !== null && readAt > notedAt;

  // The server no longer says the Update Now we noted is in progress. Back on the current build, it is done; with a
  // build still to move to, it ended unwatched before a newer one came out, or never took, and its note goes.
  useEffect(() => {
    if (!pending || status.managementState !== 'READY' || !status.usable || status.update?.phase === 'updating') return;
    if (!status.update) {
      if (!settlePendingUpdate(runnerId)) return;
      onChange?.();
    } else {
      dropPendingUpdate(runnerId);
    }
    bump((n) => n + 1);
  }, [pending, status, runnerId, onChange]);

  const outcome = readUpdateOutcome(runnerId);
  const card = managedUpdateCard(status, outcome, Date.now(), interrupted ?? 0);
  if (!card) return null;

  const run = async (to: ManagedRunnerBuild, interruptTurns: boolean, turns: number) => {
    const answered = await managedUpdateNow(interruptTurns);
    // The server's answer is the status from now on, so the card reads what it accepted, not what was shown before.
    qc.setQueryData(managedRunnerStatusQuery().queryKey, answered);
    if (answered.update?.phase === 'updating') notePendingUpdate(runnerId, turns, to);
    bump((n) => n + 1);
    void qc.invalidateQueries({ queryKey: ['managed-runner'] });
    void qc.invalidateQueries({ queryKey: ['runners'] });
    void qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  const askBusy = (to: ManagedRunnerBuild, busy: ManagedBusy) => {
    void confirm({
      title: runnerUpdateNowTitle(machine),
      description: <ManagedUpdateNowDescription build={buildName(to)} busy={busy} />,
      confirmText: confirmText(busy.turns.length),
      danger: true,
      width: 520,
      onConfirm: () => run(to, true, busy.turns.length),
    });
  };
  // A plain press: the server says whether the runner is busy. A runner that shows nothing running asks first;
  // one that shows turns is asked at once, so the confirmation lists them.
  const attempt = async (to: ManagedRunnerBuild) => {
    try {
      await run(to, false, 0);
    } catch (error) {
      const busy = managedBusyOf(error, Date.now());
      if (!busy) {
        message.error(RUNNER_UPDATE_NOW_FAILED, error instanceof Error ? error.message : undefined);
        return;
      }
      // The first dialog closes as this call returns; the busy one opens after it.
      setTimeout(() => askBusy(to, busy), 0);
    }
  };
  const press = (to: ManagedRunnerBuild) => {
    if (!idle) {
      void attempt(to);
      return;
    }
    void confirm({
      title: runnerUpdateNowTitle(machine),
      description: <ManagedUpdateNowDescription build={buildName(to)} busy={null} />,
      confirmText: RUNNER_UPDATE_NOW_CONFIRM,
      danger: false,
      width: 520,
      onConfirm: () => attempt(to),
    });
  };

  return (
    <section className={`rd-update-card ${card.tone}`} aria-label={card.title} data-phase={card.phase} data-testid="managed-update-card">
      <div className="rd-update-head">
        <div className="rd-update-title">{card.title}</div>
        <div className="rd-update-tag">{card.tag}</div>
      </div>
      <div className="rd-update-body">{card.body}</div>
      {card.phase === 'available' && card.to && (
        <div className="rd-update-actions">
          <Button variant="primary" className="runner-update-now-button" onClick={() => press(card.to!)}>
            {RUNNER_UPDATE_NOW}
          </Button>
        </div>
      )}
      {confirmation}
    </section>
  );
}
