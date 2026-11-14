import {
  WORKTREE_ISOLATION_DIALOG_COPY as COPY,
  worktreeIsolationDirtyBody,
  worktreeIsolationOffBody,
  worktreeIsolationStuckBody,
  type MainCheckoutRepoHealth,
} from '@orbit/shared';
import { mainCheckoutFileCount } from './MainCheckout';
import { isBlockingRepoState } from './SessionOutputs';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

/** Which board 04 dialog flipping worktree isolation asks first. None (null): the switch just flips. */
export type WorktreeIsolationDialogKind =
  | { kind: 'on-dirty'; root: string; fileCount: number; branch: string; head: string }
  | { kind: 'on-stuck'; root: string; state: string }
  | { kind: 'on-unseen' }
  | { kind: 'off'; root: string; unmerged: number };

/** Board 04's rules: a clean checkout switches either way without asking; turning on over a dirty or stuck checkout,
 *  or one Orbit cannot see, says what new sessions will and won't see; turning off with unmerged worktrees says they
 *  stay. The switch never blocks and never touches the checkout. */
export function worktreeIsolationDialogFor(
  turnOn: boolean,
  health: MainCheckoutRepoHealth | null | undefined,
  unmergedSessions: number,
  workDir: string,
): WorktreeIsolationDialogKind | null {
  const root = health?.root ?? workDir;
  if (!turnOn) return unmergedSessions > 0 ? { kind: 'off', root, unmerged: unmergedSessions } : null;
  if (!health) return { kind: 'on-unseen' };
  if (isBlockingRepoState(health.state)) return { kind: 'on-stuck', root, state: health.state };
  const files = mainCheckoutFileCount(health);
  if (files > 0) {
    return { kind: 'on-dirty', root, fileCount: files, branch: health.branch ?? 'HEAD', head: health.head ?? '' };
  }
  return null;
}

/** The body with the checkout's path set as code, as on the board. */
function withRoot(text: string, root: string) {
  const i = text.indexOf(root);
  if (!root || i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <code>{root}</code>
      {text.slice(i + root.length)}
    </>
  );
}

export function WorktreeIsolationDialog({
  dialog,
  onCancel,
  onConfirm,
  onReview,
  onCleanUp,
}: {
  dialog: WorktreeIsolationDialogKind | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** Review files: the main checkout's drawer. Absent when the runner cannot act on it. */
  onReview?: () => void;
  onCleanUp?: () => void;
}) {
  if (!dialog) return null;
  const turnOn = dialog.kind !== 'off';
  let body;
  switch (dialog.kind) {
    case 'on-dirty':
      body = (
        <>
          <p>{withRoot(worktreeIsolationDirtyBody(dialog.root, dialog.fileCount, dialog.branch, dialog.head), dialog.root)}</p>
          <p>{COPY.unchanged}</p>
        </>
      );
      break;
    case 'on-stuck':
      body = (
        <>
          <p>{withRoot(worktreeIsolationStuckBody(dialog.root, dialog.state), dialog.root)}</p>
          <p>{COPY.unchanged}</p>
        </>
      );
      break;
    case 'on-unseen':
      body = (
        <>
          <p>{COPY.unseen}</p>
          <p>{COPY.unchanged}</p>
        </>
      );
      break;
    case 'off':
      body = <p>{withRoot(worktreeIsolationOffBody(dialog.root, dialog.unmerged), dialog.root)}</p>;
      break;
  }
  return (
    <Dialog
      open
      onClose={onCancel}
      width={480}
      className="wt-iso-dialog"
      title={turnOn ? COPY.turnOnTitle : COPY.turnOffTitle}
      footer={
        <>
          {dialog.kind === 'on-dirty' && onReview && <Button onClick={onReview}>{COPY.reviewFiles}</Button>}
          {dialog.kind === 'on-stuck' && onCleanUp && <Button onClick={onCleanUp}>{COPY.cleanUpCheckout}</Button>}
          <Button onClick={onCancel}>{COPY.cancel}</Button>
          <Button variant="primary" onClick={onConfirm}>
            {turnOn ? COPY.turnOn : COPY.turnOff}
          </Button>
        </>
      }
    >
      <div className="wt-iso-body">{body}</div>
    </Dialog>
  );
}
