import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Popconfirm, Skeleton, Tooltip } from 'antd';
import { api } from '../api';
import { providersQuery, runnersQuery } from '../lib/queries';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import {
  localLoginCoverage,
  vendorGroups,
  type LocalLogin,
  type LocalLoginOnRunner,
  type RunnerLike,
} from '../lib/connections';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';
import { copyText } from '../lib/clipboard';

/**
 * Providers: every way this user's agents can reach a model, grouped by vendor.
 *
 * Two kinds of credential land in the same card because they are the same kind of thing — a local
 * login (the Claude Code / Codex CLI signed in on one of their runners) and an API key. The page
 * used to show only the second, which meant the credential most sessions actually run on was the
 * one thing it couldn't display. See lib/connections.ts for why reach, not permission, is the
 * difference worth showing.
 */
export function ProvidersPage() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const providers = useQuery({ queryKey: PROVIDERS_LIST_KEY, queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE) });
  const runners = useQuery(runnersQuery());

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`${PROVIDERS_BASE}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      // Both this list and the de-sensitized ['providers'] catalog the pickers read
      // must refresh on any change.
      void qc.invalidateQueries({ queryKey: PROVIDERS_LIST_KEY });
      void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
      message.success('Provider deleted');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  const loading = providers.isLoading || runners.isLoading;
  const groups = vendorGroups((runners.data ?? []) as RunnerLike[], providers.data ?? []);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            Providers
          </h1>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            Model access for your agents: the subscriptions signed in on your runners, and your own
            API keys. Both are visible only to you.
          </div>
        </div>
        <Button type="primary" onClick={() => navigate('/providers/new')}>
          Add provider
        </Button>
      </div>

      {loading ? (
        <Skeleton active style={{ marginTop: 24 }} />
      ) : groups.length === 0 ? (
        <div className="provider-empty">
          <h3>Connect your first provider</h3>
          <p>Pick a provider and paste your API key — that's it.</p>
          <ProviderGallery />
        </div>
      ) : (
        <>
          <div className="vendor-list">
            {groups.map((g) => (
              <section key={g.key} className="vendor-card">
                <header className="vendor-head">
                  <ProviderTile slug={g.logoSlug} label={g.label} size={32} />
                  <div className="vendor-name">{g.label}</div>
                </header>
                {g.localLogin && <LocalLoginBlock login={g.localLogin} />}
                {g.apiKeys.map((p) => (
                  <ApiKeyBlock
                    key={p.id}
                    provider={p}
                    onEdit={() => navigate(`/providers/${p.id}`)}
                    onDelete={() => deleteMut.mutate(p.id)}
                  />
                ))}
              </section>
            ))}
          </div>
          {/* The gallery stays on the page once the list isn't empty: it's how another vendor gets
              connected, and it's where "which of these do I already have?" gets answered. A user
              whose only credential is a runner login hasn't connected anything yet, so "another"
              would be wrong for them. */}
          <div className="provider-more">
            <h3>{groups.some((g) => g.apiKeys.length) ? 'Connect another provider' : 'Connect a provider'}</h3>
            <ProviderGallery />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A vendor's local login: one line per runner, because that IS the credential's scope. An API key
 * works everywhere the moment it's saved; a subscription login only works on the machine it was
 * run on, and nothing else in the product says which machines those are.
 */
function LocalLoginBlock({ login }: { login: LocalLogin }) {
  const { message } = AntdApp.useApp();
  const needsAttention = login.runners.some((r) => r.state === 'signedOut' || r.state === 'missing');
  return (
    <div className="conn-row">
      <div className="conn-main">
        <div className="conn-title">
          {login.label}
          <span className="conn-kind">Subscription</span>
        </div>
        <div className={`conn-sub${needsAttention ? ' warn' : ''}`}>{localLoginCoverage(login)}</div>
        {login.runners.length > 0 && (
          <ul className="conn-runners">
            {login.runners.map((r) => (
              <RunnerLine key={r.runnerId} runner={r} />
            ))}
          </ul>
        )}
      </div>
      {needsAttention && (
        <div className="conn-actions">
          {/* The fix is a command on a machine we can't reach from here, so the useful action is
              handing over the exact string to paste. */}
          <Tooltip title={`Headless: ${login.headlessCmd}`}>
            <Button
              size="small"
              onClick={() =>
                void copyText(login.loginCmd).then((ok) =>
                  ok ? message.success(`Copied "${login.loginCmd}"`) : message.error('Copy failed'),
                )
              }
            >
              Copy sign-in command
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

const RUNNER_STATE: Record<LocalLoginOnRunner['state'], { dot: string; text: string }> = {
  signedIn: { dot: 'ok', text: 'Signed in' },
  signedOut: { dot: 'warn', text: 'Not signed in' },
  missing: { dot: 'warn', text: 'CLI not installed' },
  // Distinct from "not installed" on purpose: an older runner, or one still on its first probe,
  // hasn't claimed anything either way, and telling this user to install something is a guess.
  notReported: { dot: 'idle', text: 'Not reported yet' },
  unknown: { dot: 'idle', text: 'Sign-in unverified' },
};

function RunnerLine({ runner }: { runner: LocalLoginOnRunner }) {
  const s = RUNNER_STATE[runner.state];
  return (
    <li>
      <span className={`conn-dot ${s.dot}`} aria-hidden="true" />
      <span className="conn-runner-name">{runner.runnerName}</span>
      <span className="conn-runner-state">{s.text}</span>
      {runner.version && <span className="conn-runner-meta">{runner.version}</span>}
      {runner.pathWarning && (
        <Tooltip title="Signed in, but the CLI isn't on the background service's PATH — it works in a shell and fails under the runner.">
          <span className="conn-runner-meta warn">not on service PATH</span>
        </Tooltip>
      )}
    </li>
  );
}

function ApiKeyBlock({
  provider,
  onEdit,
  onDelete,
}: {
  provider: ProviderRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="conn-row">
      <div className="conn-main">
        <div className="conn-title">
          {provider.label}
          <span className="conn-kind">API key</span>
          {!provider.enabled && <span className="conn-kind off">Disabled</span>}
        </div>
        {/* Reach is the contrast with the login above it: one key, every machine. */}
        <div className="conn-sub">
          Usable on all your runners · <code>{provider.baseUrl}</code>
        </div>
      </div>
      <div className="conn-actions">
        <Button size="small" onClick={onEdit}>
          Edit
        </Button>
        <Popconfirm title={`Delete ${provider.label}?`} onConfirm={onDelete}>
          <Button size="small" danger>
            Delete
          </Button>
        </Popconfirm>
      </div>
    </div>
  );
}
