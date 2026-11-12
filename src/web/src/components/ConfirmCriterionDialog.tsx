import { useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CONFIRM_SHEET_CANCEL,
  CONFIRM_SHEET_CONFIRM,
  CONFIRM_SHEET_FOOTNOTE,
  CONFIRM_SHEET_HOW_CHECKED,
  CONFIRM_SHEET_NOT_RECORDED,
  CONFIRM_SHEET_OPTIONAL,
  CONFIRM_SHEET_PLACEHOLDER,
  CONFIRM_SHEET_TITLE,
  CONFIRM_SHEET_WHAT_CHECKED,
  confirmCriterion,
} from '../lib/projectDone';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Textarea } from './ui/Textarea';

export interface ConfirmCriterionSubject {
  projectId: string;
  criterionId: string;
  ordinal: number;
  text: string;
  verificationMethod?: string | null;
  /** The revision the reader is looking at: a confirmation of wording that moved is refused. */
  revision?: number;
}

/**
 * The Confirm sheet (board 03 ④, Web dialog): the criterion and how it is checked on top, then the
 * optional "What did you check?". The owner's door; the server keeps who and when.
 */
export function ConfirmCriterionDialog({
  subject,
  open,
  onClose,
}: {
  subject: ConfirmCriterionSubject;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const confirm = useMutation({
    mutationFn: () => confirmCriterion(subject.projectId, subject.criterionId, {
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(subject.revision ? { revision: subject.revision } : {}),
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['project', subject.projectId] });
      setNote('');
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={confirm.isPending}
      width={520}
      className="confirm-criterion-dialog"
      title={CONFIRM_SHEET_TITLE.replace('{n}', String(subject.ordinal))}
      footer={(
        <>
          <Button onClick={onClose} disabled={confirm.isPending}>{CONFIRM_SHEET_CANCEL}</Button>
          <Button variant="primary" loading={confirm.isPending} onClick={() => confirm.mutate()}>
            {CONFIRM_SHEET_CONFIRM}
          </Button>
        </>
      )}
    >
      <div className="confirm-criterion-body">
        <p className="confirm-criterion-text">
          {subject.text}
          {subject.verificationMethod ? (
            <span className="confirm-criterion-method"> {CONFIRM_SHEET_HOW_CHECKED} {subject.verificationMethod}</span>
          ) : null}
        </p>
        <label className="confirm-criterion-label">
          {CONFIRM_SHEET_WHAT_CHECKED} <span className="confirm-criterion-optional">{CONFIRM_SHEET_OPTIONAL}</span>
        </label>
        <Textarea
          aria-label={CONFIRM_SHEET_WHAT_CHECKED}
          placeholder={CONFIRM_SHEET_PLACEHOLDER}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          autoSize={{ minRows: 2, maxRows: 6 }}
          disabled={confirm.isPending}
        />
        <p className="confirm-criterion-hint">{CONFIRM_SHEET_FOOTNOTE}</p>
        {confirm.error ? <Alert type="error" title={CONFIRM_SHEET_NOT_RECORDED} description={confirm.error.message} /> : null}
      </div>
    </Dialog>
  );
}
