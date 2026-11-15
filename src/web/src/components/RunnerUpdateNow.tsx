import type { RefObject } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Runner } from './TasksSidePanel';
import {
  RUNNER_UPDATE_NOW,
  RUNNER_UPDATE_NOW_FAILED,
  RUNNER_UPDATE_NOW_JOBS_NOTE,
  runnerUpdateNowTitle,
  runnerUpdateNowToast,
} from '../lib/runnerCopy';
import { runnerUpdateNowBody, runnerUpdateNowConfirm, runnerUpdateNowTurns, updateRunnerNow } from '../lib/runnerUpdateNow';
import { useToast } from '../lib/toast';
import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';

/** What the confirmation says (board 3 ⑧): what it does, the turns it interrupts and for how long they have run, and the jobs. */
export function RunnerUpdateNowDescription({ version, turns }: { version: string; turns: ReturnType<typeof runnerUpdateNowTurns> }) {
  return (
    <div className="runner-update-now">
      <p>{runnerUpdateNowBody(version, turns.length)}</p>
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
      {turns.length > 0 && <p className="runner-update-now-jobs">{RUNNER_UPDATE_NOW_JOBS_NOTE}</p>}
    </div>
  );
}

/**
 * Update Now… (docs/runner-update-drain-design.md §2, D4): the one button that interrupts work, so it
 * confirms first, naming each turn it interrupts and how long it has run, with the cost on the red
 * button (`Interrupt 2 Turns and Update`). Only the owner sees a runner, so only the owner can press it.
 * `machine` is the name the reader knows the runner by.
 *
 * Render `confirmation` outside any popover: the popover's positioner is placed by a transform, which
 * holds a dialog inside it to the popover's box. A popover closes itself and calls `open` with its trigger.
 * No runner (a popover that offers no Update Now…): `open` does nothing.
 */
export function useRunnerUpdateNow(runner: Runner | undefined, machine: string) {
  const qc = useQueryClient();
  const message = useToast();
  const [confirm, confirmation] = useConfirm();
  const version = runner?.selfUpdate?.targetVersion ?? '';
  const now = useMutation({
    mutationFn: () => updateRunnerNow(runner!.id),
    onSuccess: () => {
      message.success(runnerUpdateNowToast(version));
      void qc.invalidateQueries({ queryKey: ['runners'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error(RUNNER_UPDATE_NOW_FAILED, e.message),
  });
  const open = (returnFocus?: RefObject<HTMLElement | null>) => {
    if (!runner) return;
    // Read when it opens, so each turn's `running 47 min` is as of the press.
    const turns = runnerUpdateNowTurns(runner, Date.now());
    void confirm({
      title: runnerUpdateNowTitle(machine),
      description: <RunnerUpdateNowDescription version={version} turns={turns} />,
      confirmText: runnerUpdateNowConfirm(turns.length),
      danger: true,
      width: 520,
      onConfirm: () => now.mutateAsync(),
      returnFocus,
    });
  };
  return { open, pending: now.isPending, confirmation };
}

export function RunnerUpdateNowPress({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <Button className="runner-update-now-button" loading={pending} onClick={onClick}>
      {RUNNER_UPDATE_NOW}
    </Button>
  );
}

/** Update Now… where no popover holds it (a page or a card). */
export function RunnerUpdateNowButton({ runner, machine }: { runner: Runner; machine: string }) {
  const updateNow = useRunnerUpdateNow(runner, machine);
  return (
    <>
      <RunnerUpdateNowPress pending={updateNow.pending} onClick={() => updateNow.open()} />
      {updateNow.confirmation}
    </>
  );
}
