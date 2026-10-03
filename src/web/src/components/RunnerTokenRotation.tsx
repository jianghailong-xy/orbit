import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { App as AntdApp, Button, Modal } from 'antd';
import { useState } from 'react';
import { api } from '../api';
import { copyText } from '../lib/clipboard';
import { useToast } from '../lib/toast';
import type { Runner } from './TasksSidePanel';

/**
 * Rotating a runner's token: the confirmation that says what it breaks, then the new token, shown
 * exactly once. The Runners list's ⋯ menu and the runner's own Actions menu both offer it, so both
 * mount this rather than each keeping a copy of the words.
 */
export function useRunnerTokenRotation() {
  const { modal } = AntdApp.useApp();
  const message = useToast();
  // The freshly minted token from a rotation, shown exactly once.
  const [revealed, setRevealed] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const rotateMut = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) =>
      api<{ token: string }>(`/runners/${id}/rotate-token`, { method: 'POST' }),
    onSuccess: (data, vars) => {
      setCopied(false);
      setRevealed({ name: vars.name, token: data.token });
    },
    onError: (e: Error) => message.error("Couldn't rotate the token", e.message),
  });

  const confirmRotate = (r: Runner) =>
    modal.confirm({
      title: `Rotate token for “${r.displayName || r.name}”?`,
      content:
        'This immediately invalidates the runner’s current credential. The runner will go offline until you set the new token as runnerToken in its ~/.orbit/config.json and restart it.',
      okText: 'Rotate token',
      cancelText: 'Cancel',
      onOk: () => rotateMut.mutateAsync({ id: r.id, name: r.displayName || r.name }),
    });

  const copyToken = () => {
    if (!revealed) return;
    void copyText(revealed.token).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const tokenModal = (
    <Modal
      title="New runner token"
      open={revealed !== null}
      onCancel={() => setRevealed(null)}
      footer={[
        <Button key="done" type="primary" onClick={() => setRevealed(null)}>
          Done
        </Button>,
      ]}
      destroyOnClose
    >
      <div style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 12 }}>
        Copy this token now — it won’t be shown again. Set it as <code>runnerToken</code> in{' '}
        <code>~/.orbit/config.json</code> on <b>{revealed?.name}</b>, then restart the runner.
      </div>
      <div className="runner-token-box">{revealed?.token}</div>
      <Button
        icon={copied ? <CheckOutlined /> : <CopyOutlined />}
        onClick={copyToken}
        style={{ marginTop: 12 }}
      >
        {copied ? 'Copied' : 'Copy token'}
      </Button>
    </Modal>
  );

  return { confirmRotate, tokenModal };
}
