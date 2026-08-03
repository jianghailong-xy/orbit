import { type ReactNode, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber, Select, Space, Spin, Switch } from 'antd';
import { api } from '../api';
import { providersQuery } from '../lib/queries';
import { PROVIDER_PRESETS, providerPreset, type ProviderPreset } from '@orbit/shared';
import {
  PROVIDERS_BASE,
  PROVIDERS_LIST_KEY,
  subscriptionAccountsQuery,
  type ProviderRow,
} from '../lib/providerAdmin';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';
import { ClaudeSubscriptionForm } from '../components/ClaudeSubscriptionForm';
import { useToast } from '../lib/toast';

// A model row while it's being edited in the form. contextWindow is a free InputNumber (null when
// blank) rather than the wire's optional number, so an empty cell round-trips cleanly.
interface DraftModel {
  value: string;
  label: string;
  contextWindow: number | null;
}

/**
 * Step 1 of adding a provider (/providers/new): pick a vendor. Its own page rather than a modal
 * step, so picking a vendor is a normal navigation — back button included.
 */
export function ProviderPickPage() {
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/providers">
        ‹ All providers
      </Link>
      <h1 className="page-title" style={{ marginTop: 8 }}>
        Add a provider
      </h1>
      <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: -8, marginBottom: 20 }}>
        Pick a model provider to get started. Each uses your own key, visible only to you.
      </p>
      <ProviderGallery />
      <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 14 }}>
        Can't find your provider? Choose Custom to enter an endpoint.
      </div>
    </div>
  );
}

/**
 * Step 2 of adding a provider (/providers/new/:slug), and the edit form (/providers/:id): paste a
 * key, optionally probe it, and save.
 *
 * Editing needs the row, and the management API only lists — so the page reads the same cached
 * list the providers page fills and picks its id out of it.
 */
export function ProviderConnectPage() {
  const { slug, id } = useParams();

  const providers = useQuery({
    queryKey: PROVIDERS_LIST_KEY,
    queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE),
    enabled: !!id,
  });

  if (id) {
    if (providers.isPending) {
      return (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      );
    }
    const row = providers.data?.find((p) => p.id === id);
    if (!row) {
      return (
        <div className="provider-form">
          <Link className="provider-back" to="/providers">
            ‹ All providers
          </Link>
          <div style={{ marginTop: 16, color: 'var(--text-3)' }}>That provider no longer exists.</div>
        </div>
      );
    }
    // The vendor a row was created from is recorded on the row, not guessed from its slug — a
    // second key for the same vendor lands on "anthropic-2" and is still an Anthropic provider.
    return <ProviderForm key={row.id} editing={row} preset={providerPreset(row.presetSlug)} />;
  }

  const preset = PROVIDER_PRESETS.find((p) => p.slug === slug);
  if (!preset && slug !== 'custom') return <Navigate to="/providers/new" replace />;
  // Anthropic is the one vendor with two ways in — the account's Claude subscription, or an API
  // key — so its tile leads to the choice rather than straight to the key form.
  if (preset?.slug === 'anthropic') return <AnthropicConnect preset={preset} />;
  return <ProviderForm key={slug} preset={preset} />;
}

/** `/providers/subscription` — the deep link onto the subscription half of the Anthropic page,
 *  which is where the list page's subscription row goes to be managed. */
export function ClaudeSubscriptionPage() {
  return <AnthropicConnect preset={providerPreset('anthropic')!} />;
}

type AuthMethod = 'subscription' | 'key';

/**
 * Connecting Anthropic: pick how to authenticate, then fill in that one.
 *
 * Both methods reach the same vendor, so they share one tile in the gallery and one page here —
 * what differs is who pays. The subscription spends the plan quota the user already has and
 * covers every runner at once; an API key is billed per token. That's the decision this page
 * exists to put in front of them, so it leads, and the form follows underneath.
 */
function AnthropicConnect({ preset }: { preset: ProviderPreset }) {
  const subs = useQuery(subscriptionAccountsQuery());
  const accounts = subs.data?.length ?? 0;
  const providers = useQuery({
    queryKey: PROVIDERS_LIST_KEY,
    queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE),
  });
  // Accounts are Anthropic rows too, so they'd otherwise be counted as keys on the other card.
  const keys = (providers.data ?? []).filter(
    (p) => p.presetSlug === preset.slug && p.authMode !== 'subscription',
  ).length;
  // The subscription leads: it's the cheaper path for anyone who already pays for a plan, and the
  // only one that fixes every runner at once.
  const [method, setMethod] = useState<AuthMethod>('subscription');
  // Arriving on accounts that already exist (the list's subscription rows link straight here) is
  // a manage visit, not a connect one — so the heading drops the verb.
  const managing = method === 'subscription' && accounts > 0;

  return (
    <div className="provider-form">
      <Link className="provider-back" to="/providers">
        ‹ All providers
      </Link>
      <h1 className="page-title" style={{ marginTop: 8 }}>
        {managing ? preset.label : `Connect ${preset.label}`}
      </h1>

      <div className="provider-idbar" style={{ marginBottom: 24 }}>
        <ProviderTile slug={preset.slug} label={preset.label} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{preset.label}</div>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            Anthropic-compatible · {preset.models.length} models included
          </div>
        </div>
      </div>

      <section className="provider-step" style={{ marginTop: 0 }}>
        <div className="ps-head">
          <span className="ps-title">How do you want to authenticate?</span>
        </div>
        <div className="auth-methods">
          <AuthChoice
            on={method === 'subscription'}
            onPick={() => setMethod('subscription')}
            name="Claude subscription"
            desc={
              <>
                Runs on your Claude plan's quota — no API billing. Every runner uses it, so no
                machine needs its own <code>claude auth login</code>.
              </>
            }
            state={accounts ? (accounts === 1 ? '1 account' : `${accounts} accounts`) : null}
          />
          <AuthChoice
            on={method === 'key'}
            onPick={() => setMethod('key')}
            name="API key"
            desc="Billed per token by Anthropic. Use a key from the Anthropic console."
            state={keys ? (keys === 1 ? '1 connected' : `${keys} connected`) : null}
          />
        </div>
      </section>

      {method === 'subscription' ? <ClaudeSubscriptionForm /> : <ProviderForm preset={preset} embedded />}
    </div>
  );
}

/** One of the two authentication methods: a radio-ish card that says what it costs and whether
 *  it's already set up. */
function AuthChoice({
  on,
  onPick,
  name,
  desc,
  state,
}: {
  on: boolean;
  onPick: () => void;
  name: string;
  desc: ReactNode;
  state: string | null;
}) {
  return (
    <button type="button" className={`auth-method${on ? ' on' : ''}`} onClick={onPick} aria-pressed={on}>
      <div className="am-head">
        <span className="am-radio" aria-hidden="true" />
        <span className="am-name">{name}</span>
        {state && <span className="am-state">{state}</span>}
      </div>
      <div className="am-desc">{desc}</div>
    </button>
  );
}

/**
 * The connect/edit form. Mounted fresh per vendor (or per edited row), so its fields seed from the
 * preset — or the stored row — once, at mount.
 *
 * `embedded` drops the page chrome (back link, title, identity bar) for a caller that already drew
 * it — AnthropicConnect, where this form is one of two choices under a shared heading.
 */
function ProviderForm({
  preset,
  editing,
  embedded,
}: {
  preset?: ProviderPreset;
  editing?: ProviderRow;
  embedded?: boolean;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // A custom provider names itself and declares its own endpoint; a preset ships every field but
  // the key, so those fields live behind Advanced.
  const isCustom = !preset;

  const [advOpen, setAdvOpen] = useState(isCustom && !editing);
  const [label, setLabel] = useState(editing?.label ?? preset?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? preset?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [models, setModels] = useState<DraftModel[]>(
    (editing?.models ?? preset?.models ?? []).map((m) => ({
      value: m.value,
      label: m.label,
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
    })),
  );
  // Anthropic-compatible (claude) vs OpenAI-compatible (codex) endpoint dialect. A preset knows its
  // own dialect, so only a custom provider is asked.
  const [runtime, setRuntime] = useState<'claude' | 'codex'>(
    editing ? (editing.runtime === 'codex' ? 'codex' : 'claude') : (preset?.runtime ?? 'claude'),
  );
  // The model list is the system's — a preset's, or a saved row's. It shows as a one-line summary;
  // editing it is an escape hatch for a model the catalogue doesn't know about yet.
  const [modelsOpen, setModelsOpen] = useState(isCustom && !editing);
  // Whether the list is still the preset's. The server resolves a following row's models from the
  // catalogue on every read, so a new Claude model reaches this provider without anyone touching
  // it — until someone edits the list here, which hands ownership back to them. The row stays an
  // Anthropic one either way; only ownership of the list changes.
  const [follows, setFollows] = useState(editing ? editing.followsPreset : !!preset);
  const editModels = (next: DraftModel[]) => {
    setModels(next);
    setFollows(false);
  };
  // The pre-save probe's verdict, when it failed: shown inline, with "Save anyway" beside it.
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const saveMut = useMutation({
    mutationFn: () => {
      // Keep only complete model rows; carry contextWindow only when set.
      const modelPayload = models
        .filter((m) => m.value.trim() && m.label.trim())
        .map((m) => ({
          value: m.value.trim(),
          label: m.label.trim(),
          ...(m.contextWindow != null ? { contextWindow: m.contextWindow } : {}),
        }));
      // The default model is the system's pick, not a typed field: the preset's choice, else the
      // first row (the server's own fallback when we omit it). On edit, an omitted default keeps
      // the stored one — so it's sent only to correct a value the model list no longer contains.
      const values = modelPayload.map((m) => m.value);
      const dm = editing
        ? editing.defaultModel && values.includes(editing.defaultModel)
          ? undefined
          : values[0]
        : preset?.defaultModel && values.includes(preset.defaultModel)
          ? preset.defaultModel
          : undefined;
      if (editing) {
        return api(`${PROVIDERS_BASE}/${editing.id}`, {
          method: 'PATCH',
          body: {
            label: label.trim(),
            runtime,
            baseUrl: baseUrl.trim(),
            models: modelPayload,
            defaultModel: dm,
            // Who owns the list from here on; the vendor identity is fixed at creation.
            followsPreset: follows,
            enabled,
            // Omit the key to keep the stored one; send it only when a new one was typed.
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          },
        });
      }
      // No slug: the server derives one from the preset or the name and suffixes it until it's
      // free, so connecting a vendor someone else already connected just works.
      return api(PROVIDERS_BASE, {
        method: 'POST',
        body: {
          label: label.trim(),
          runtime,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          models: modelPayload,
          defaultModel: dm,
          ...(preset ? { presetSlug: preset.slug, followsPreset: follows } : {}),
          enabled,
        },
      });
    },
    onSuccess: () => {
      // Both this list and the de-sensitized ['providers'] catalog the pickers read
      // must refresh on any change.
      void qc.invalidateQueries({ queryKey: PROVIDERS_LIST_KEY });
      void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
      message.success(editing ? 'Provider updated' : 'Provider created');
      navigate('/providers');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  // Create needs a key; edit keeps the stored one when left blank. label/baseUrl always required.
  const canSave =
    label.trim() !== '' && baseUrl.trim() !== '' && (editing ? true : apiKey.trim() !== '');
  // The model the probe pings with: the one a session would get by default.
  const probeModel = (
    preset?.defaultModel ||
    editing?.defaultModel ||
    models.find((m) => m.value.trim())?.value ||
    ''
  ).trim();

  /**
   * The single commit action. Connecting a provider *is* checking it works, so the probe rides
   * along with the save instead of sitting in its own step: one tiny request to the endpoint, then
   * the write. A failed probe stops short of saving and offers "Save anyway" — some endpoints
   * refuse a bare ping. Without a fresh key (an edit that keeps the stored one) there's nothing to
   * probe with, so it saves directly.
   */
  const connect = async () => {
    setProbeError(null);
    if (apiKey.trim() && probeModel) {
      setProbing(true);
      try {
        const r = await api<{ ok: boolean; message: string }>('/providers/test', {
          method: 'POST',
          body: { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: probeModel, runtime },
        });
        if (!r.ok) {
          setProbeError(r.message);
          return;
        }
      } catch (e) {
        setProbeError((e as Error).message || 'Could not reach the endpoint');
        return;
      } finally {
        setProbing(false);
      }
    }
    saveMut.mutate();
  };

  const title = editing ? `Edit ${editing.label}` : preset ? `Connect ${preset.label}` : 'Add a custom provider';
  // The hero above the form: the row being edited, or the vendor being connected. A blank custom
  // provider has no identity yet, so it gets none.
  const identity = editing
    ? {
        ...editing,
        // The logo follows the vendor, not the row's identifier — a second Anthropic key sits on
        // "anthropic-2" and is still Anthropic.
        slug: editing.presetSlug ?? editing.slug,
        count: editing.models?.length ?? 0,
        counted: 'configured',
      }
    : preset
      ? { ...preset, runtime: preset.runtime ?? 'claude', count: preset.models.length, counted: 'included' }
      : null;

  return (
    <div className={embedded ? undefined : 'provider-form'}>
      {!embedded && (
        <>
          <Link className="provider-back" to={editing ? '/providers' : '/providers/new'}>
            ‹ All providers
          </Link>
          <h1 className="page-title" style={{ marginTop: 8 }}>
            {title}
          </h1>

          {identity && (
            <div className="provider-idbar" style={{ marginBottom: 24 }}>
              <ProviderTile slug={identity.slug} label={identity.label} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{identity.label}</div>
                <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                  {identity.runtime === 'codex' ? 'OpenAI-compatible' : 'Anthropic-compatible'} ·{' '}
                  {identity.count} model{identity.count === 1 ? '' : 's'} {identity.counted}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* A custom provider's dialect, endpoint and name are decisions only the user can make, so
          they lead the walkthrough. A preset already knows all three. */}
      {isCustom && (
        <>
          <Step num={1} title={editing ? 'Name' : 'Name this provider'} hideNum={!!editing}>
            <Input placeholder="e.g. My provider" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Step>

          <Step num={2} title="Endpoint" hideNum={!!editing}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Select<'claude' | 'codex'>
                value={runtime}
                onChange={(v) => {
                  setRuntime(v);
                  setProbeError(null);
                }}
                style={{ width: '100%' }}
                options={[
                  { value: 'claude', label: 'Anthropic-compatible (Claude)' },
                  { value: 'codex', label: 'OpenAI-compatible (Codex)' },
                ]}
              />
              <Input
                placeholder="https://api.example.com/anthropic"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setProbeError(null);
                }}
              />
            </Space>
            <div className="ps-hint">
              {runtime === 'codex'
                ? 'The API dialect this endpoint speaks, and its base URL (e.g. up to /v1).'
                : 'The API dialect this endpoint speaks, and its base URL (the one the vendor documents for Claude Code).'}
            </div>
          </Step>
        </>
      )}

      <Step
        num={isCustom ? 3 : 1}
        title={preset ? `Paste your ${preset.label} API key` : 'API key'}
        link={
          preset?.keyUrl && (
            <a href={preset.keyUrl} target="_blank" rel="noreferrer">
              Get your API key ↗
            </a>
          )
        }
        hideNum={!isCustom || !!editing}
      >
        {/* The stored key never comes back to the browser, so whether one exists is said by the
            placeholder rather than by a second line of hint. */}
        <Input.Password
          placeholder={editing?.hasApiKey ? 'Leave blank to keep the current key' : 'Provider API key'}
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setProbeError(null);
          }}
          autoComplete="new-password"
        />
        <div className="ps-hint">
          Stored encrypted — never sent back to your browser.
          {apiKey.trim() ? ` ${editing ? 'Saving' : 'Connecting'} sends one tiny test request first.` : ''}
        </div>
      </Step>

      <div className="provider-adv" style={{ marginTop: 20 }}>
        <div className={`provider-adv-head${advOpen ? ' open' : ''}`} onClick={() => setAdvOpen((v) => !v)}>
          <span className="pa-chev">▸</span>
          <span>Advanced</span>
          {preset && <span className="provider-adv-badge">{editing ? 'From preset' : 'Auto-filled'}</span>}
        </div>
        {advOpen && (
          <div className="provider-adv-body">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {preset && (
                <>
                  <Field label="Name">
                    <Input value={label} onChange={(e) => setLabel(e.target.value)} />
                  </Field>
                  <Field label="Endpoint">
                    <Input
                      value={baseUrl}
                      onChange={(e) => {
                        setBaseUrl(e.target.value);
                        setProbeError(null);
                      }}
                    />
                    <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>
                      {preset.note ??
                        (preset.runtime === 'codex'
                          ? `${preset.label}'s OpenAI-compatible endpoint.`
                          : `The endpoint ${preset.label} documents for Claude Code.`)}
                    </div>
                  </Field>
                </>
              )}
              <Field label="Models">
                {modelsOpen ? (
                  <>
                    <div className="pf-models-head">
                      <span>Model ID</span>
                      <span>Display name</span>
                      <span>Context</span>
                      <span />
                    </div>
                    {models.map((m, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <Input
                          placeholder="e.g. claude-opus-4-8"
                          value={m.value}
                          style={{ flex: 1, minWidth: 0 }}
                          onChange={(e) =>
                            editModels(models.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                          }
                        />
                        <Input
                          placeholder="e.g. Claude Opus 4.8"
                          value={m.label}
                          style={{ flex: 1, minWidth: 0 }}
                          onChange={(e) =>
                            editModels(models.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))
                          }
                        />
                        <InputNumber
                          placeholder="200000"
                          value={m.contextWindow}
                          min={0}
                          style={{ width: 140, flex: 'none' }}
                          onChange={(v) =>
                            editModels(models.map((r, j) => (j === i ? { ...r, contextWindow: v } : r)))
                          }
                        />
                        <Button
                          type="text"
                          icon={<DeleteOutlined />}
                          onClick={() => editModels(models.filter((_, j) => j !== i))}
                        />
                      </div>
                    ))}
                    <Button
                      type="dashed"
                      icon={<PlusOutlined />}
                      onClick={() => editModels([...models, { value: '', label: '', contextWindow: null }])}
                      block
                    >
                      Add model
                    </Button>
                  </>
                ) : (
                  <div className="pf-models-sum">
                    <span className="pf-sum-list">
                      {models.length
                        ? models.map((m) => m.label || m.value).join(' · ')
                        : 'No models yet — the picker will have nothing to offer.'}
                    </span>
                    <a onClick={() => setModelsOpen(true)}>Edit</a>
                  </div>
                )}
                {/* Who owns this list, and how to change hands. A following row is maintained for
                    the user; once they edit it, keeping up with the vendor is on them. */}
                {preset && (
                  <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 6 }}>
                    {follows ? (
                      <>
                        Maintained by Orbit, from the official {preset.label} preset — new models
                        appear here on their own.
                        {modelsOpen && ' Editing the list stops that.'}
                      </>
                    ) : (
                      <>
                        This list is yours to maintain.{' '}
                        <a
                          onClick={() => {
                            setModels(
                              preset.models.map((m) => ({
                                value: m.value,
                                label: m.label,
                                contextWindow: m.contextWindow ?? null,
                              })),
                            );
                            setFollows(true);
                          }}
                        >
                          Follow the {preset.label} preset again
                        </a>
                      </>
                    )}
                  </div>
                )}
              </Field>
            </Space>
          </div>
        )}
      </div>

      {/* Nobody adds a provider they want switched off, so this is an edit-time control. */}
      {editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20 }}>
          <Switch checked={enabled} onChange={setEnabled} />
          <span>Enabled</span>
          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
            Disabled providers are hidden from the pickers.
          </span>
        </div>
      )}

      <div className="provider-actions">
        <span style={{ color: 'var(--error)', fontSize: 12, lineHeight: 1.4 }}>
          {probing ? <span style={{ color: 'var(--text-3)' }}>Testing the connection…</span> : probeError}
        </span>
        <Space>
          {probeError && (
            <Button loading={saveMut.isPending} onClick={() => saveMut.mutate()}>
              Save anyway
            </Button>
          )}
          <Button onClick={() => navigate('/providers')}>Cancel</Button>
          <Button
            type="primary"
            disabled={!canSave}
            loading={probing || saveMut.isPending}
            onClick={() => canSave && void connect()}
          >
            {editing ? 'Save' : 'Connect'}
          </Button>
        </Space>
      </div>
    </div>
  );
}

// One numbered step of the guided form: a heading (with an optional right-aligned link) over its
// control. Editing an existing provider isn't a walkthrough, so it drops the numbers.
function Step({
  num,
  title,
  link,
  hideNum,
  children,
}: {
  num: number;
  title: ReactNode;
  link?: ReactNode;
  hideNum?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="provider-step">
      <div className="ps-head">
        {!hideNum && <span className="ps-num">{num}</span>}
        <span className="ps-title">{title}</span>
        {link && <span className="ps-link">{link}</span>}
      </div>
      {children}
    </section>
  );
}

// One labelled form row: a small label above its control.
function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
