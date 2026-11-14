import { useEffect, useRef, useState, type ClipboardEvent, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uploadAttachment } from '../api';
import { inertObjectUrl, isRasterImage } from '../lib/userFile';
import {
  CONFIRM_SHEET_ATTACH,
  CONFIRM_SHEET_DROP,
  CONFIRM_SHEET_NOT_AN_IMAGE,
  CONFIRM_SHEET_NOT_UPLOADED,
  CONFIRM_SHEET_REMOVE,
  CONFIRM_SHEET_SCREENSHOT,
  CONFIRM_SHEET_UPLOADING,
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
 * optional "What did you check?" and one optional screenshot. The owner's door; the server keeps who
 * and when.
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
  // One optional screenshot (board 03 ④ D): uploaded when picked, dropped or pasted, so Confirm
  // sends only its id. The preview is the picked file itself.
  const [shot, setShot] = useState<{ id: string; preview: string } | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.preview); }, [shot]);
  const upload = useMutation({
    mutationFn: async (file: File) => ({ id: (await uploadAttachment(file)).id, preview: inertObjectUrl(file) }),
    onSuccess: (uploaded) => { setShot(uploaded); setShotError(null); },
    onError: (error: Error) => setShotError(error.message),
  });
  const take = (files: FileList | null | undefined) => {
    const file = Array.from(files ?? [])[0];
    if (!file) return;
    if (!isRasterImage(file.type)) {
      setShotError(CONFIRM_SHEET_NOT_AN_IMAGE);
      return;
    }
    upload.mutate(file);
  };
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) => isRasterImage(file.type));
    if (images.length === 0) return;
    event.preventDefault();
    upload.mutate(images[0]);
  };
  const confirm = useMutation({
    mutationFn: () => confirmCriterion(subject.projectId, subject.criterionId, {
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(subject.revision ? { revision: subject.revision } : {}),
      ...(shot ? { attachmentIds: [shot.id] } : {}),
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['project', subject.projectId] });
      setNote('');
      setShot(null);
      onClose();
    },
  });
  const busy = confirm.isPending || upload.isPending;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      width={520}
      className="confirm-criterion-dialog"
      title={CONFIRM_SHEET_TITLE.replace('{n}', String(subject.ordinal))}
      footer={(
        <>
          <Button onClick={onClose} disabled={confirm.isPending}>{CONFIRM_SHEET_CANCEL}</Button>
          <Button variant="primary" loading={confirm.isPending} disabled={upload.isPending} onClick={() => confirm.mutate()}>
            {CONFIRM_SHEET_CONFIRM}
          </Button>
        </>
      )}
    >
      <div className="confirm-criterion-body" onPaste={onPaste}>
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
        <label className="confirm-criterion-label">
          {CONFIRM_SHEET_SCREENSHOT} <span className="confirm-criterion-optional">{CONFIRM_SHEET_OPTIONAL}</span>
        </label>
        {shot ? (
          <div className="confirm-criterion-shot">
            <img src={shot.preview} alt={CONFIRM_SHEET_SCREENSHOT} />
            <Button size="small" variant="text" onClick={() => setShot(null)} disabled={confirm.isPending}>{CONFIRM_SHEET_REMOVE}</Button>
          </div>
        ) : (
          <button
            type="button"
            className="confirm-criterion-drop"
            aria-label={CONFIRM_SHEET_ATTACH}
            disabled={busy}
            onClick={() => picker.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); take(event.dataTransfer.files); }}
          >
            {upload.isPending ? CONFIRM_SHEET_UPLOADING : (
              <>
                <span className="confirm-criterion-drop-action">+ {CONFIRM_SHEET_ATTACH}</span>
                <span className="confirm-criterion-drop-hint">{CONFIRM_SHEET_DROP}</span>
              </>
            )}
          </button>
        )}
        <input
          ref={picker}
          type="file"
          accept="image/*"
          hidden
          data-testid="confirm-criterion-file"
          onChange={(event) => { take(event.target.files); event.target.value = ''; }}
        />
        {shotError ? <Alert type="error" title={CONFIRM_SHEET_NOT_UPLOADED} description={shotError} /> : null}
        <p className="confirm-criterion-hint">{CONFIRM_SHEET_FOOTNOTE}</p>
        {confirm.error ? <Alert type="error" title={CONFIRM_SHEET_NOT_RECORDED} description={confirm.error.message} /> : null}
      </div>
    </Dialog>
  );
}
