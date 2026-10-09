import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { useState, type RefObject } from 'react';
import { api } from '../api';
import { copyText } from '../lib/clipboard';
import { useToast } from '../lib/toast';
import type { Runner } from './TasksSidePanel';
import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';
import { Dialog } from './ui/Dialog';

/**
 * Rotating a runner's token: the confirmation that says what it breaks, then the new token, shown
 * exactly once. A machine card's ⋯ menu on Infrastructure and the runner's own Actions menu both
 * offer it, so both mount this rather than each keeping a copy of the words. `dialogs` is where both
 * are drawn.
 */
export function useRunnerTokenRotation() {
  const message = useToast();
  const [confirm, confirmation] = useConfirm();
  // The freshly minted token from a rotation, shown exactly once.
  const [revealed, setRevealed] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Where focus goes once the token is put away: the menu's button the rotation was asked from.
  const [returnFocus, setReturnFocus] = useState<RefObject<HTMLElement | null> | undefined>();

  const rotateMut = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) =>
      api<{ token: string }>(`/runners/${id}/rotate-token`, { method: 'POST' }),
    onSuccess: (data, vars) => {
      setCopied(false);
      setRevealed({ name: vars.name, token: data.token });
    },
    onError: (e: Error) => message.error("Couldn't rotate the token", e.message),
  });

  /** Asked from a menu: `from` is the button that opened it, where focus returns. */
  const confirmRotate = (r: Runner, from?: RefObject<HTMLElement | null>) => {
    setReturnFocus(from);
    void confirm({
      title: `Rotate token for “${r.displayName || r.name}”?`,
      description:
        'This immediately invalidates the runner’s current credential. The runner will go offline until you set the new token as runnerToken in its ~/.orbit/config.json and restart it.',
      confirmText: 'Rotate token',
      cancelText: 'Cancel',
      onConfirm: () => rotateMut.mutateAsync({ id: r.id, name: r.displayName || r.name }),
      returnFocus: from,
    });
  };

  const copyToken = () => {
    if (!revealed) return;
    void copyText(revealed.token).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const dialogs = (
    <>
      {confirmation}
      <Dialog
        className="runner-dialog"
        title="New runner token"
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        returnFocus={returnFocus}
        footer={
          <Button variant="primary" onClick={() => setRevealed(null)}>
            Done
          </Button>
        }
      >
        <div style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 12 }}>
          Copy this token now — it won’t be shown again. Set it as <code>runnerToken</code> in{' '}
          <code>~/.orbit/config.json</code> on <b>{revealed?.name}</b>, then restart the runner.
        </div>
        <div className="runner-token-box">{revealed?.token}</div>
        <Button icon={copied ? <CheckOutlined /> : <CopyOutlined />} onClick={copyToken} style={{ marginTop: 12 }}>
          {copied ? 'Copied' : 'Copy token'}
        </Button>
      </Dialog>
    </>
  );

  return { confirmRotate, dialogs };
}
