import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Popconfirm } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { SUBSCRIPTION_PATH, subscriptionQuery, type SubscriptionStatus } from '../lib/providerAdmin';
import { useToast } from '../lib/toast';

/**
 * The "Claude subscription" half of the Anthropic connect page: store (or replace, or drop) the
 * account-level `claude setup-token`. See `SubscriptionStatus` for why this shares the Anthropic
 * tile with the API-key form instead of being its own entry point.
 *
 * The token is write-only, so a configured account shows only that one exists and when it was
 * stored — replacing means pasting a new one.
 */
export function ClaudeSubscriptionForm() {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(false);

  const status = useQuery(subscriptionQuery());
  const refresh = () => qc.invalidateQueries({ queryKey: subscriptionQuery().queryKey });

  const save = useMutation({
    mutationFn: (t: string) => api<SubscriptionStatus>(SUBSCRIPTION_PATH, { method: 'PUT', body: { token: t } }),
    onSuccess: () => {
      setToken('');
      setEditing(false);
      void refresh();
      message.success('Claude subscription token saved');
      navigate('/providers');
    },
    onError: (e: Error) => message.error(e.message || 'Failed to save token'),
  });

  const clear = useMutation({
    mutationFn: () => api<SubscriptionStatus>(SUBSCRIPTION_PATH, { method: 'DELETE' }),
    onSuccess: () => {
      void refresh();
      message.success('Token removed — runners fall back to their own login');
      navigate('/providers');
    },
    onError: (e: Error) => message.error(e.message || 'Failed to remove token'),
  });

  const configured = status.data?.configured ?? false;

  // A stored token, and nothing being replaced: this is the manage view, not the paste view.
  if (configured && !editing) {
    return (
      <section className="provider-step">
        <div className="ps-head">
          <span className="ps-title">Subscription token</span>
        </div>
        {/* The method card above already carries the "Configured" badge — this only has to say
            when, and that the token isn't coming back. */}
        <div className="sub-stored">
          {status.data?.setAt ? `Stored ${new Date(status.data.setAt).toLocaleString()}.` : 'Stored.'}{' '}
          Encrypted at rest and never shown again.
        </div>
        <div className="provider-actions">
          <span />
          <div style={{ display: 'flex', gap: 8 }}>
            <Popconfirm
              title="Remove the stored token?"
              description="Sessions go back to using each runner's own login."
              onConfirm={() => clear.mutate()}
            >
              <Button danger loading={clear.isPending}>
                Remove
              </Button>
            </Popconfirm>
            <Button type="primary" onClick={() => setEditing(true)}>
              Replace token
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="provider-step">
      <div className="ps-head">
        <span className="ps-title">Paste your subscription token</span>
      </div>
      <div className="ps-hint" style={{ marginTop: 0, marginBottom: 8 }}>
        Run <code>claude setup-token</code> on any machine you're already signed in on, then paste
        what it prints.
      </div>
      <Input.Password
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="sk-ant-oat…"
        autoComplete="off"
        onPressEnter={() => token.trim() && save.mutate(token)}
      />
      <div className="ps-hint">Stored encrypted — never sent back to your browser.</div>
      <div className="provider-actions">
        <span />
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            onClick={() => {
              if (editing) {
                setEditing(false);
                setToken('');
              } else {
                navigate('/providers');
              }
            }}
          >
            Cancel
          </Button>
          <Button
            type="primary"
            loading={save.isPending}
            disabled={!token.trim()}
            onClick={() => save.mutate(token)}
          >
            Save
          </Button>
        </div>
      </div>
    </section>
  );
}
