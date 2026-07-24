import { CheckOutlined, CopyOutlined, GlobalOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Modal, Popconfirm } from 'antd';
import { useEffect, useState } from 'react';
import { disableSessionShare, enableSessionShare } from '../api';
import { copyText } from '../lib/clipboard';

/**
 * Share dialog for one session: mint / show / revoke a public read-only link (`/s/<token>`).
 * Seeded with the session's current shareToken (from SessionDetail); on enable/revoke it
 * invalidates the session query so the dialog reflects the truth if reopened.
 */
export function ShareModal({
  open,
  onClose,
  sessionId,
  initialToken,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  initialToken: string | null;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(initialToken);
  const [copied, setCopied] = useState(false);

  // Re-seed when reopened for a (possibly different) session.
  useEffect(() => {
    if (open) {
      setToken(initialToken);
      setCopied(false);
    }
  }, [open, initialToken]);

  const url = token ? `${window.location.origin}/s/${token}` : '';

  const enableMut = useMutation({
    mutationFn: () => enableSessionShare(sessionId),
    onSuccess: (res) => {
      setToken(res.shareToken);
      qc.invalidateQueries({ queryKey: ['session'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const disableMut = useMutation({
    mutationFn: () => disableSessionShare(sessionId),
    onSuccess: () => {
      setToken(null);
      setCopied(false);
      qc.invalidateQueries({ queryKey: ['session'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const copy = () => {
    if (!url) return;
    void copyText(url).then((ok) => {
      if (ok) {
        setCopied(true);
        message.success('Link copied');
      } else {
        message.error('Could not copy');
      }
    });
  };

  return (
    <Modal open={open} onCancel={onClose} title="Share session" footer={null} width={460}>
      <p className="share-modal-desc">
        Anyone with the link can view this session’s full transcript, read-only — no sign-in
        required. They can’t reply or change anything.
      </p>
      {token ? (
        <>
          <div className="share-modal-link">
            <input className="share-modal-url" readOnly value={url} onFocus={(e) => e.target.select()} />
            <Button type="primary" icon={copied ? <CheckOutlined /> : <CopyOutlined />} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <div className="share-modal-actions">
            <span className="share-modal-on">
              <GlobalOutlined /> Sharing is on
            </span>
            <Popconfirm
              title="Revoke this link?"
              description="The current link will stop working immediately."
              okText="Revoke"
              okButtonProps={{ danger: true }}
              onConfirm={() => disableMut.mutate()}
            >
              <Button type="text" danger loading={disableMut.isPending}>
                Revoke link
              </Button>
            </Popconfirm>
          </div>
        </>
      ) : (
        <Button
          type="primary"
          icon={<GlobalOutlined />}
          loading={enableMut.isPending}
          onClick={() => enableMut.mutate()}
        >
          Create share link
        </Button>
      )}
    </Modal>
  );
}
