import { type ReactNode, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber, Select, Space, Spin, Switch } from 'antd';
import { api } from '../api';
import { presetModelsQuery, providersQuery, type PresetCatalogEntry } from '../lib/queries';
import { PROVIDER_PRESETS, providerPreset, type ProviderPreset } from '@orbit/shared';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';
import { runtimeSummary } from '../lib/sessionProviderChoices';
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
  // A vendor's list is refreshed server-side, so the form asks for the current one rather than
  // seeding from the copy compiled into this bundle — otherwise the page that promises new models
  // "appear here on their own" would be the one place they don't. Waited for (it seeds state at
  // mount); a failed fetch falls through to the shipped list.
  const presetModels = useQuery(presetModelsQuery());

  if (presetModels.isPending) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

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
    const rowPreset = providerPreset(row.presetSlug);
    return (
      <ProviderForm
        key={row.id}
        editing={row}
        preset={rowPreset}
        catalog={rowPreset && presetModels.data?.[rowPreset.slug]}
      />
    );
  }

  const preset = PROVIDER_PRESETS.find((p) => p.slug === slug);
  if (!preset && slug !== 'custom') return <Navigate to="/providers/new" replace />;
  return <ProviderForm key={slug} preset={preset} catalog={preset && presetModels.data?.[preset.slug]} />;
}

/**
 * The connect/edit form. Mounted fresh per vendor (or per edited row), so its fields seed from the
 * preset — or the stored row — once, at mount.
 */
function ProviderForm({
  preset,
  catalog,
  editing,
}: {
  preset?: ProviderPreset;
  /** What the preset offers as the server resolves it today; falls back to the shipped catalogue. */
  catalog?: PresetCatalogEntry;
  editing?: ProviderRow;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // A custom provider names itself and declares its own endpoint; a preset ships every field but
  // the key, so those fields live behind Advanced.
  const isCustom = !preset;
  const presetModels = catalog?.models ?? preset?.models ?? [];
  // The vendor's current pick, which a following provider dispatches with — not the one this
  // bundle was built with, or the form would probe the key against a model the session won't use.
  const presetDefault = catalog?.defaultModel ?? preset?.defaultModel;

  const [advOpen, setAdvOpen] = useState(isCustom && !editing);
  const [label, setLabel] = useState(editing?.label ?? preset?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? preset?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [models, setModels] = useState<DraftModel[]>(
    (editing?.models ?? presetModels).map((m) => ({
      value: m.value,
      label: m.label,
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
    })),
  );
  // Which runtime CLI this endpoint is driven by, and with it the dialect it has to speak:
  // Anthropic-compatible (claude), OpenAI-compatible (codex), or Moonshot's own API (kimi). A
  // preset knows its own, so only a custom provider is asked — and only about the two dialects a
  // hand-typed endpoint can implement.
  const [runtime, setRuntime] = useState<'claude' | 'codex' | 'kimi'>(
    editing
      ? editing.runtime === 'codex' || editing.runtime === 'kimi'
        ? editing.runtime
        : 'claude'
      : (preset?.runtime ?? 'claude'),
  );
  // A self-maintained list shows as a one-line summary; opening it is how you edit it.
  const [modelsOpen, setModelsOpen] = useState(isCustom && !editing);
  // Whether the list is still the preset's. The server resolves a following row's models — and its
  // default — from the catalogue on every read, so a new model reaches this provider without
  // anyone touching it.
  const [follows, setFollows] = useState(editing ? editing.followsPreset : !!preset);
  // Every vendor preset maintains its own list now: the runner's CLI reports it, or it refreshes
  // from the vendor catalogue. There is nothing to configure in either case — a list typed here
  // would only be a copy that stops updating. What's left is a custom endpoint, which has no
  // catalogue behind it, and a row saved back when editing the list was still offered.
  const maintained = !!preset && follows;
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
        : presetDefault && values.includes(presetDefault)
          ? presetDefault
          : undefined;
      // A maintained list isn't ours to send: the server resolves both halves from the catalogue on
      // every read, and a payload from here would only park a stale copy on the row.
      const catalogue = maintained ? {} : { models: modelPayload, defaultModel: dm };
      if (editing) {
        return api(`${PROVIDERS_BASE}/${editing.id}`, {
          method: 'PATCH',
          body: {
            label: label.trim(),
            runtime,
            baseUrl: baseUrl.trim(),
            ...catalogue,
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
          ...catalogue,
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
    presetDefault ||
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
      ? { ...preset, runtime: preset.runtime ?? 'claude', count: presetModels.length, counted: 'included' }
      : null;

  return (
    <div className="provider-form">
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
              {runtimeSummary(identity.runtime)} ·{' '}
              {/* Counting a shipped list would misstate what this offers — the runner's CLI
                  decides, and that list changes without us. */}
              {preset?.modelsFromRuntime
                ? 'models from the runtime CLI'
                : `${identity.count} model${identity.count === 1 ? '' : 's'} ${identity.counted}`}
            </div>
          </div>
        </div>
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
              <Select<'claude' | 'codex' | 'kimi'>
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
                          : preset.runtime === 'kimi'
                            ? `${preset.label}'s own API, which the Kimi CLI speaks natively.`
                            : `The endpoint ${preset.label} documents for Claude Code.`)}
                    </div>
                  </Field>
                </>
              )}
              {/* A vendor's list keeps itself current — the runner probes the installed CLI, or the
                  server refreshes the vendor catalogue — so there is nothing to fill in here, only
                  something to read. Anything typed would be a copy that stops updating the moment
                  it's saved, which is the staleness this replaced. */}
              <Field label="Models">
                {maintained ? (
                  preset!.modelsFromRuntime ? (
                    <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                      Provided by the {runtime === 'codex' ? 'Codex' : 'Claude Code'} CLI on each
                      runner, refreshed automatically — new models appear without any change here.
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
                        {presetModels
                          .map((m) => (m.value === presetDefault ? `${m.label || m.value} (default)` : m.label || m.value))
                          .join(' · ')}
                      </div>
                      <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 6 }}>
                        Maintained by Orbit from the official {preset!.label} catalogue and refreshed
                        automatically — new models appear on their own, and the newest becomes the
                        default.
                      </div>
                    </>
                  )
                ) : modelsOpen ? (
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
                            setModels(models.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                          }
                        />
                        <Input
                          placeholder="e.g. Claude Opus 4.8"
                          value={m.label}
                          style={{ flex: 1, minWidth: 0 }}
                          onChange={(e) =>
                            setModels(models.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))
                          }
                        />
                        <InputNumber
                          placeholder="200000"
                          value={m.contextWindow}
                          min={0}
                          style={{ width: 140, flex: 'none' }}
                          onChange={(v) =>
                            setModels(models.map((r, j) => (j === i ? { ...r, contextWindow: v } : r)))
                          }
                        />
                        <Button
                          type="text"
                          icon={<DeleteOutlined />}
                          onClick={() => setModels(models.filter((_, j) => j !== i))}
                        />
                      </div>
                    ))}
                    <Button
                      type="dashed"
                      icon={<PlusOutlined />}
                      onClick={() => setModels([...models, { value: '', label: '', contextWindow: null }])}
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
                {/* The way back for a row saved while editing the list was still on offer: its
                    models are its own until it rejoins the vendor's, which is now a one-way door
                    because nothing here hands the list back out again. */}
                {preset && !maintained && (
                  <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 6 }}>
                    This list is yours to maintain.{' '}
                    <a onClick={() => setFollows(true)}>
                      Follow the {preset.label} catalogue again
                    </a>
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
