import { CheckCircleFilled } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Popconfirm } from 'antd';
import { useState } from 'react';
import { api } from '../api';
import { useToast } from '../lib/toast';

const SUBSCRIPTION_PATH = '/providers/subscription';
export const SUBSCRIPTION_KEY = ['providers', 'subscription'] as const;

interface SubscriptionStatus {
  configured: boolean;
  setAt: string | null;
}

/**
 * Account-level Claude subscription token (`claude setup-token`), injected as
 * CLAUDE_CODE_OAUTH_TOKEN into this user's claude sessions on EVERY runner.
 *
 * This is the fleet-wide counterpart to the per-runner sign-in card in a transcript: that one
 * fixes the one machine whose local login expired, this one means no machine needs a local login
 * at all. Deliberately not listed as a provider — it supplies credentials without redirecting the
 * endpoint, so it would be a picker entry that isn't a distinct model choice.
 *
 * The token is write-only: the server never returns it, so a configured card shows only that one
 * exists and when it was stored. Replacing means pasting a new one.
 */
export function ClaudeSubscriptionCard() {
  const message = useToast();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(false);

  const status = useQuery({
    queryKey: SUBSCRIPTION_KEY,
    queryFn: () => api<SubscriptionStatus>(SUBSCRIPTION_PATH),
  });

  const save = useMutation({
    mutationFn: (t: string) => api<SubscriptionStatus>(SUBSCRIPTION_PATH, { method: 'PUT', body: { token: t } }),
    onSuccess: () => {
      setToken('');
      setEditing(false);
      void qc.invalidateQueries({ queryKey: SUBSCRIPTION_KEY });
      message.success('Claude subscription token saved');
    },
    onError: (e: Error) => message.error(e.message || 'Failed to save token'),
  });

  const clear = useMutation({
    mutationFn: () => api<SubscriptionStatus>(SUBSCRIPTION_PATH, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SUBSCRIPTION_KEY });
      message.success('Token removed — runners fall back to their own login');
    },
    onError: (e: Error) => message.error(e.message || 'Failed to remove token'),
  });

  const configured = status.data?.configured ?? false;
  const showForm = !configured || editing;

  return (
    <div className="claude-sub">
      <div className="claude-sub-head">
        <div>
          <div className="claude-sub-title">Claude subscription</div>
          <div className="claude-sub-sub">
            Use your Claude subscription on every runner, so no machine needs its own{' '}
            <code>claude auth login</code>.
          </div>
        </div>
        {configured && !editing && (
          <span className="claude-sub-badge">
            <CheckCircleFilled /> Configured
          </span>
        )}
      </div>

      {configured && !editing && (
        <div className="claude-sub-meta">
          {status.data?.setAt
            ? `Token stored ${new Date(status.data.setAt).toLocaleString()}.`
            : 'Token stored.'}{' '}
          It's encrypted at rest and never shown again.
        </div>
      )}

      {showForm && (
        <>
          <div className="claude-sub-steps">
            Run <code>claude setup-token</code> on any machine you're signed in on, then paste the
            token it prints.
          </div>
          <div className="claude-sub-form">
            <Input.Password
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="sk-ant-oat…"
              autoComplete="off"
              onPressEnter={() => token.trim() && save.mutate(token)}
            />
            <Button
              type="primary"
              loading={save.isPending}
              disabled={!token.trim()}
              onClick={() => save.mutate(token)}
            >
              Save
            </Button>
            {editing && (
              <Button
                onClick={() => {
                  setEditing(false);
                  setToken('');
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </>
      )}

      {configured && !editing && (
        <div className="claude-sub-actions">
          <Button size="small" onClick={() => setEditing(true)}>
            Replace
          </Button>
          <Popconfirm
            title="Remove the stored token?"
            description="Sessions go back to using each runner's own login."
            onConfirm={() => clear.mutate()}
          >
            <Button size="small" danger loading={clear.isPending}>
              Remove
            </Button>
          </Popconfirm>
        </div>
      )}
    </div>
  );
}
