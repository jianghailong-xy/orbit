import { DeleteOutlined, FileOutlined, PaperClipOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Popconfirm, Upload } from 'antd';
import { useEffect, useState } from 'react';
import { deleteAttachment, fetchAttachmentObjectUrl, uploadAttachment } from '../api';
import { useToast } from '../lib/toast';

export interface TaskInput {
  id: string;
  mimeType: string;
  sizeBytes: number;
  fileName: string | null;
  createdAt: string;
}

const isImage = (mime: string) => mime.startsWith('image/');

/** Human-readable size. Kept local: one call site, and the exact rounding is cosmetic. */
const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB`
  : `${bytes} B`;

/**
 * One input's thumbnail. The download route is bearer-guarded, so an `<img src>` pointed straight
 * at it would 401 — the bytes are fetched with the token and handed back as an object URL, which
 * this revokes on unmount. Same device the transcript uses for a past turn's image.
 */
function InputThumbnail({ input }: { input: TaskInput }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage(input.mimeType)) return;
    let revoked = false;
    let objectUrl: string | null = null;
    fetchAttachmentObjectUrl(input.id).then((u) => {
      // The unmount may win the race with the fetch; revoking then is what keeps a
      // navigated-away panel from leaking one object URL per design mock it had shown.
      if (revoked) { URL.revokeObjectURL(u); return; }
      objectUrl = u;
      setUrl(u);
    }).catch(() => { /* a thumbnail that will not load is not worth a toast */ });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [input.id, input.mimeType]);

  if (!isImage(input.mimeType)) return <FileOutlined className="tdp-input-icon" />;
  return url
    ? <img className="tdp-input-thumb" src={url} alt={input.fileName ?? 'attachment'} />
    : <div className="tdp-input-thumb tdp-input-thumb-empty" />;
}

/**
 * The files a task carries as INPUT to its work — a design mock, a spec PDF.
 *
 * These are not a conversation's images. A task outlives every session that runs it, so what is
 * listed here is a template: each dispatch copies it into that run's session, which is what makes
 * a retry or a successor see the same inputs the first run did. Removing one changes what FUTURE
 * runs are given and never reaches into a run that has started.
 */
export function TaskInputs({ taskId, inputs }: { taskId: string; inputs: TaskInput[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['task', taskId] });

  const upload = useMutation({
    mutationFn: (file: File) => uploadAttachment(file, undefined, taskId),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAttachment(id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="tdp-section">
      <div className="tdp-section-title">Inputs ({inputs.length})</div>
      <div className="tdp-muted tdp-input-hint">
        Files every run of this task is given — design mocks, specs. Each run gets its own copy.
      </div>
      {inputs.length > 0 && (
        <div className="tdp-input-list">
          {inputs.map((input) => (
            <div className="tdp-input" key={input.id}>
              <InputThumbnail input={input} />
              <div className="tdp-input-meta">
                <div className="tdp-input-name">{input.fileName ?? input.mimeType}</div>
                <div className="tdp-muted">{humanSize(input.sizeBytes)}</div>
              </div>
              <Popconfirm
                title="Remove this input?"
                description="Runs already started keep their copy."
                okText="Remove"
                onConfirm={() => remove.mutate(input.id)}
              >
                <Button type="text" size="small" icon={<DeleteOutlined />} aria-label="Remove input" />
              </Popconfirm>
            </div>
          ))}
        </div>
      )}
      <Upload
        // The bytes go through `uploadAttachment` (multipart + bearer), not antd's own XHR.
        customRequest={({ file, onSuccess, onError }) => {
          upload.mutate(file as File, {
            onSuccess: () => onSuccess?.({}),
            onError: (e) => onError?.(e as Error),
          });
        }}
        showUploadList={false}
        multiple
      >
        <Button size="small" icon={<PaperClipOutlined />} loading={upload.isPending}>
          Add file
        </Button>
      </Upload>
    </section>
  );
}
