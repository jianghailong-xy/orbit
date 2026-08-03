import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Popconfirm } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { providersQuery } from '../lib/queries';
import {
  PROVIDERS_LIST_KEY,
  SUBSCRIPTIONS_BASE,
  subscriptionAccountsQuery,
} from '../lib/providerAdmin';
import { ProviderTile } from './ProviderGallery';
import { useToast } from '../lib/toast';

/**
 * The "Claude subscription" half of the Anthropic connect page: this user's Claude accounts, and
 * the form to add one.
 *
 * Two things drive the shape. A token carries no account identity, so the user has to name each
 * one or a second account is indistinguishable from the first. And an agent that doesn't pick a
 * provider has to run on *something*, so exactly one account is the default.
 */
export function ClaudeSubscriptionForm() {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [adding, setAdding] = useState(false);

  const accounts = useQuery(subscriptionAccountsQuery());
  const rows = accounts.data ?? [];
  // An account is a provider row, so it lands in three caches: this list, the management list the
  // providers page renders, and the de-sensitized catalog every picker reads.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: subscriptionAccountsQuery().queryKey });
    void qc.invalidateQueries({ queryKey: PROVIDERS_LIST_KEY });
    void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
  };

  const resetForm = () => {
    setName('');
    setToken('');
    setAdding(false);
  };

  const save = useMutation({
    mutationFn: () =>
      api(SUBSCRIPTIONS_BASE, { method: 'POST', body: { label: name.trim(), token: token.trim() } }),
    onSuccess: () => {
      const label = name.trim();
      refresh();
      resetForm();
      message.success(`${label} connected`);
      navigate('/providers');
    },
    onError: (e: Error) => message.error(e.message || 'Failed to add account'),
  });

  const makeDefault = useMutation({
    mutationFn: (id: string) => api(`${SUBSCRIPTIONS_BASE}/${id}/default`, { method: 'PUT' }),
    onSuccess: refresh,
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`${SUBSCRIPTIONS_BASE}/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      refresh();
      message.success(`${rows.find((a) => a.id === id)?.label ?? 'Account'} removed`);
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  // Nothing stored yet, or the user asked for another one: the paste form. Otherwise the list.
  const showForm = rows.length === 0 || adding;

  return (
    <>
      {rows.length > 0 && (
        <section className="provider-step">
          <div className="ps-head">
            <span className="ps-title">Your Claude accounts</span>
          </div>
          <div className="sub-accounts">
            {rows.map((a) => (
              <div className="sub-account" key={a.id}>
                <ProviderTile slug="anthropic" label="Claude" size={28} />
                <div style={{ minWidth: 0 }}>
                  <div className="sa-name">
                    {a.label}
                    {a.isDefault && <span className="sa-default">Default</span>}
                  </div>
                  <div className="sa-meta">Stored {new Date(a.setAt).toLocaleDateString()}</div>
                </div>
                <div className="sa-actions">
                  {!a.isDefault && (
                    <Button
                      size="small"
                      loading={makeDefault.isPending && makeDefault.variables === a.id}
                      onClick={() => makeDefault.mutate(a.id)}
                    >
                      Make default
                    </Button>
                  )}
                  <Popconfirm
                    title={`Remove ${a.label}?`}
                    description="Agents on this account fall back to the default one."
                    onConfirm={() => remove.mutate(a.id)}
                  >
                    <Button size="small" danger loading={remove.isPending && remove.variables === a.id}>
                      Remove
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>
          {!adding && (
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              block
              style={{ marginTop: 10 }}
              onClick={() => setAdding(true)}
            >
              Add another account
            </Button>
          )}
          {/* Both halves of what "default" means, since neither is guessable from the list. */}
          <div className="ps-hint">
            A new agent runs on the default account. One that sets <code>CLAUDE_CODE_OAUTH_TOKEN</code>{' '}
            in its own env still overrides it.
          </div>
        </section>
      )}

      {showForm && (
        <>
          <section className="provider-step">
            <div className="ps-head">
              <span className="ps-title">Name this account</span>
            </div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Work account"
              autoComplete="off"
            />
            <div className="ps-hint">
              A label you'll recognise — the token doesn't say which account it came from.
            </div>
          </section>

          <section className="provider-step">
            <div className="ps-head">
              <span className="ps-title">Paste your subscription token</span>
            </div>
            <div className="ps-hint" style={{ marginTop: 0, marginBottom: 8 }}>
              Run <code>claude setup-token</code> on any machine signed in to <em>that</em> account,
              then paste what it prints.
            </div>
            <Input.Password
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="sk-ant-oat…"
              autoComplete="off"
              onPressEnter={() => name.trim() && token.trim() && save.mutate()}
            />
            <div className="ps-hint">Stored encrypted — never sent back to your browser.</div>
          </section>

          <div className="provider-actions">
            <span />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => (rows.length ? resetForm() : navigate('/providers'))}>
                Cancel
              </Button>
              <Button
                type="primary"
                disabled={!name.trim() || !token.trim()}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                {rows.length ? 'Add account' : 'Save'}
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
