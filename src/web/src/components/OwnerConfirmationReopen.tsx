import { useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Modal, Typography } from 'antd';
import { useToast } from '../lib/toast';
import {
  REOPENABLE_STATUSES,
  REOPEN_ACTION_LABEL,
  REOPEN_MODAL_OK,
  REOPEN_MODAL_TITLE,
  reopenMutationOptions,
  reopenParagraphs,
} from './TaskDetailPanel';

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
  return (
    <>
      <Button block onClick={() => setAsking(true)}>
        {REOPEN_ACTION_LABEL}
      </Button>
      <Modal
        open={asking}
        title={REOPEN_MODAL_TITLE}
        okText={REOPEN_MODAL_OK}
        cancelText="Back"
        okButtonProps={{ loading: reopen.isPending }}
        onOk={() => reopen.mutate()}
        onCancel={() => {
          reopen.reset();
          setAsking(false);
        }}
      >
        {reopenParagraphs({ projectId }).map((paragraph) => (
          <Typography.Paragraph
            key={paragraph.text}
            strong={paragraph.strong}
            type={paragraph.strong ? undefined : 'secondary'}
          >
            {paragraph.text}
          </Typography.Paragraph>
        ))}
        {reopen.error ? (
          <Alert
            type="error"
            showIcon
            message="Task status was not changed"
            description={(reopen.error as Error).message}
          />
        ) : null}
      </Modal>
    </>
  );
}
