import { useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../lib/toast';
import {
  REOPENABLE_STATUSES,
  REOPEN_ACTION_LABEL,
  REOPEN_MODAL_OK,
  REOPEN_MODAL_TITLE,
  reopenMutationOptions,
  reopenParagraphs,
} from './TaskDetailPanel';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

/**
 * Reopen task, where a confirmation receipt's late review found a problem
 * (docs/owner-confirmation-review-contract.md §9 L4): the task panel's own question and write
 * (`reopenMutationOptions`, `reopenParagraphs`), so this is a second place to press the one door and
 * not a door of its own. Nothing for a task that has not settled — there is nothing to reopen.
 *
 * Kept out of `OwnerConfirmationCard.tsx`: the panel imports that card, and the console mounts this
 * beside it rather than the card importing the panel back.
 */
export function OwnerConfirmationReopen({
  taskId,
  projectId,
  status,
}: {
  taskId: string;
  projectId: string | null;
  /** The task's status as the confirmation read gave it. */
  status: string;
}): JSX.Element | null {
  const qc = useQueryClient();
  const message = useToast();
  const [asking, setAsking] = useState(false);
  const reopen = useMutation(reopenMutationOptions(qc, message, taskId, projectId, () => setAsking(false)));
  if (!REOPENABLE_STATUSES.includes(status)) return null;
  const back = () => {
    reopen.reset();
    setAsking(false);
  };
  // The task panel's own Reopen question (TaskDetailPanel), drawn the same: its dialog, paragraphs
  // and refusal.
  return (
    <>
      <Button style={{ width: '100%' }} onClick={() => setAsking(true)}>
        {REOPEN_ACTION_LABEL}
      </Button>
      <Dialog
        open={asking}
        title={REOPEN_MODAL_TITLE}
        className="tdp-reopen-dialog"
        onClose={back}
        footer={
          <>
            <Button onClick={back}>Back</Button>
            <Button variant="primary" loading={reopen.isPending} onClick={() => reopen.mutate()}>
              {REOPEN_MODAL_OK}
            </Button>
          </>
        }
      >
        {reopenParagraphs({ projectId }).map((paragraph) => (
          <p key={paragraph.text} className={`tdp-reopen-paragraph${paragraph.strong ? ' is-strong' : ''}`}>
            {paragraph.strong ? <strong>{paragraph.text}</strong> : paragraph.text}
          </p>
        ))}
        {reopen.error ? (
          <Alert type="error" title="Task status was not changed" description={(reopen.error as Error).message} />
        ) : null}
      </Dialog>
    </>
  );
}
