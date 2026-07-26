import { type ReactNode, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Input, InputNumber, Select, Space, Spin, Switch } from 'antd';
import { api } from '../api';
import { providersQuery } from '../lib/queries';
import { PROVIDER_PRESETS, type ProviderPreset } from '../lib/providerPresets';
import {
  PROVIDER_SCOPES,
  providerScopeFrom,
  scopeSuffix,
  type ProviderRow,
  type ProviderScope,
} from '../lib/providerAdmin';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';

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
  const [params] = useSearchParams();
  const scope = providerScopeFrom(params.get('scope'));
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/providers">
        ‹ All providers
      </Link>
      <h1 className="page-title" style={{ marginTop: 8 }}>
        {scope === 'shared' ? 'Add a shared provider' : 'Add a provider'}
      </h1>
      <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: -8, marginBottom: 20 }}>
        {scope === 'shared'
          ? 'Shared providers use the deployment key and are available to every user here.'
          : 'Pick a model provider to get started. Each uses your own key, visible only to you.'}
      </p>
      <ProviderGallery scope={scope} />
      <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 14 }}>
        Can't find your provider? Choose Custom to enter an endpoint.
      </div>
    </div>
  );
}

/**
 * Step 2 of adding a provider (/providers/new/:slug), and the edit form (/providers/:id): paste a
 * key, optionally probe it, and save. `?scope=shared` targets the admin-managed list.
 *
 * Editing needs the row, and the management APIs only list — so the page reads the same cached
 * list the providers page fills and picks its id out of it.
 */
export function ProviderConnectPage() {
  const { slug, id } = useParams();
  const [params] = useSearchParams();
  const scope = providerScopeFrom(params.get('scope'));
  const { basePath, listKey } = PROVIDER_SCOPES[scope];

  const providers = useQuery({
    queryKey: listKey,
    queryFn: () => api<ProviderRow[]>(basePath),
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
    return (
      <ProviderForm
        key={row.id}
        scope={scope}
        editing={row}
        preset={PROVIDER_PRESETS.find((p) => p.slug === row.slug)}
      />
    );
  }

  const preset = PROVIDER_PRESETS.find((p) => p.slug === slug);
  if (!preset && slug !== 'custom') return <Navigate to={`/providers/new${scopeSuffix(scope)}`} replace />;
  return <ProviderForm key={slug} scope={scope} preset={preset} />;
}

/**
 * The connect/edit form. Mounted fresh per vendor (or per edited row), so its fields seed from the
 * preset — or the stored row — once, at mount.
 */
function ProviderForm({
  scope,
  preset,
  editing,
}: {
  scope: ProviderScope;
  preset?: ProviderPreset;
  editing?: ProviderRow;
}) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { basePath, listKey } = PROVIDER_SCOPES[scope];
  // A custom provider names itself; a preset ships every field but the key.
  const isCustom = !preset;

  const [advOpen, setAdvOpen] = useState(isCustom && !editing);
  const [slug, setSlug] = useState(editing?.slug ?? preset?.slug ?? '');
  const [label, setLabel] = useState(editing?.label ?? preset?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? preset?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState(editing?.defaultModel ?? preset?.defaultModel ?? '');
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [models, setModels] = useState<DraftModel[]>(
    (editing?.models ?? preset?.models ?? []).map((m) => ({
      value: m.value,
      label: m.label,
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
    })),
  );
  // Anthropic-compatible (claude) vs OpenAI-compatible (codex) endpoint dialect.
  const [runtime, setRuntime] = useState<'claude' | 'codex'>(
    editing ? (editing.runtime === 'codex' ? 'codex' : 'claude') : (preset?.runtime ?? 'claude'),
  );

  // Stateless pre-save probe of the endpoint + typed key (POST /providers/test).
  const testMut = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; status?: number; message: string }>('/providers/test', {
        method: 'POST',
        body: {
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          model: defaultModel.trim() || models.find((m) => m.value.trim())?.value || '',
          runtime,
        },
      }),
  });

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
      const dm = defaultModel.trim() || undefined;
      if (editing) {
        return api(`${basePath}/${editing.id}`, {
          method: 'PATCH',
          body: {
            label: label.trim(),
            runtime,
            baseUrl: baseUrl.trim(),
            models: modelPayload,
            defaultModel: dm,
            enabled,
            // Omit the key to keep the stored one; send it only when a new one was typed.
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          },
        });
      }
      return api(basePath, {
        method: 'POST',
        body: {
          slug: slug.trim().toLowerCase(),
          label: label.trim(),
          runtime,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          models: modelPayload,
          defaultModel: dm,
          enabled,
        },
      });
    },
    onSuccess: () => {
      // Both this scope's list and the de-sensitized ['providers'] catalog the pickers read
      // must refresh on any change.
      void qc.invalidateQueries({ queryKey: listKey });
      void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
      message.success(editing ? 'Provider updated' : 'Provider created');
      navigate('/providers');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  // Create needs a key; edit keeps the stored one when left blank. slug/label/baseUrl always required.
  const canSave =
    label.trim() !== '' &&
    baseUrl.trim() !== '' &&
    (editing ? true : slug.trim() !== '' && apiKey.trim() !== '');
  // A test needs somewhere to send it, a key to send, and a model to probe with.
  const canTest =
    baseUrl.trim() !== '' &&
    apiKey.trim() !== '' &&
    (defaultModel.trim() !== '' || models.some((m) => m.value.trim() !== ''));

  const title = editing ? `Edit ${editing.label}` : preset ? `Connect ${preset.label}` : 'Add a custom provider';
  // The hero above the form: the row being edited, or the vendor being connected. A blank custom
  // provider has no identity yet, so it gets none.
  const identity = editing
    ? { ...editing, count: editing.models?.length ?? 0, counted: 'configured' }
    : preset
      ? { ...preset, runtime: preset.runtime ?? 'claude', count: preset.models.length, counted: 'included' }
      : null;

  return (
    <div className="provider-form">
      <Link className="provider-back" to={editing ? '/providers' : `/providers/new${scopeSuffix(scope)}`}>
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

      {isCustom && (
        <Step num={1} title={editing ? 'Label' : 'Name this provider'} hideNum={!!editing}>
          <Input placeholder="e.g. My provider" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Step>
      )}

      <Step
        num={isCustom ? 2 : 1}
        title={preset ? `Paste your ${preset.label} API key` : 'API key'}
        link={
          preset?.keyUrl && (
            <a href={preset.keyUrl} target="_blank" rel="noreferrer">
              Get your API key ↗
            </a>
          )
        }
        hideNum={!!editing}
      >
        <Input.Password
          placeholder={editing ? 'Leave blank to keep the current key' : 'Provider API key'}
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            testMut.reset();
          }}
          autoComplete="new-password"
        />
        <div className="ps-hint">Stored encrypted — never sent back to your browser.</div>
      </Step>

      <Step num={isCustom ? 3 : 2} title="Check the connection" hideNum={!!editing}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button onClick={() => testMut.mutate()} disabled={!canTest} loading={testMut.isPending}>
            Test connection
          </Button>
          {!testMut.isPending && testMut.data?.ok && (
            <span style={{ color: 'var(--success)', fontSize: 13, fontWeight: 500 }}>
              ✓ {testMut.data.message}
            </span>
          )}
          {!testMut.isPending && testMut.data && !testMut.data.ok && (
            <span style={{ color: 'var(--error)', fontSize: 13 }}>{testMut.data.message}</span>
          )}
          {!testMut.isPending && testMut.isError && (
            <span style={{ color: 'var(--error)', fontSize: 13 }}>
              {(testMut.error as Error)?.message || 'Test failed'}
            </span>
          )}
        </div>
        <div className="ps-hint">Sends one tiny request to the endpoint. Optional — you can save without it.</div>
      </Step>

      <div className="provider-adv" style={{ marginTop: 20 }}>
        <div className={`provider-adv-head${advOpen ? ' open' : ''}`} onClick={() => setAdvOpen((v) => !v)}>
          <span className="pa-chev">▸</span>
          <span>Advanced</span>
          {preset && !editing && <span className="provider-adv-badge">Auto-filled</span>}
        </div>
        {advOpen && (
          <div className="provider-adv-body">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {preset && (
                <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                  Filled from the official {preset.label} preset — most people don't need to change these.
                </div>
              )}
              <Field label="Runtime">
                <Select<'claude' | 'codex'>
                  value={runtime}
                  onChange={(v) => {
                    setRuntime(v);
                    testMut.reset();
                  }}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'claude', label: 'Anthropic-compatible (Claude)' },
                    { value: 'codex', label: 'OpenAI-compatible (Codex)' },
                  ]}
                />
                <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>
                  The API dialect this endpoint speaks — a preset sets it for you.
                </div>
              </Field>
              {!isCustom && (
                <Field label="Label">
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} />
                </Field>
              )}
              <Field label="Slug">
                <Input
                  placeholder="e.g. deepseek"
                  value={slug}
                  disabled={!!editing}
                  onChange={(e) => setSlug(e.target.value)}
                />
                <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>
                  Lowercase letters, digits and hyphens, starting with a letter. Can't be claude or codex.
                  Fixed once created.
                </div>
              </Field>
              <Field label="Base URL">
                <Input
                  placeholder="https://api.example.com/anthropic"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    testMut.reset();
                  }}
                />
                <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>
                  {preset?.note ??
                    (runtime === 'codex'
                      ? 'An OpenAI-compatible endpoint (its base URL, e.g. up to /v1).'
                      : 'An Anthropic-compatible endpoint (the one the vendor documents for Claude Code).')}
                </div>
              </Field>
              <Field label="Models">
                {models.map((m, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <Input
                      placeholder="model id (value)"
                      value={m.value}
                      onChange={(e) =>
                        setModels(models.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                      }
                    />
                    <Input
                      placeholder="Label"
                      value={m.label}
                      onChange={(e) =>
                        setModels(models.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))
                      }
                    />
                    <InputNumber
                      placeholder="Context"
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
              </Field>
              <Field label="Default model">
                <Input
                  placeholder="Model id used by default (optional)"
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                />
              </Field>
            </Space>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20 }}>
        <Switch checked={enabled} onChange={setEnabled} />
        <span>Enabled</span>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
          Disabled providers are hidden from the pickers.
        </span>
      </div>

      <div className="provider-actions">
        <span style={{ color: 'var(--text-3)', fontSize: 12, lineHeight: 1.4 }}>
          {preset && !editing ? 'Everything else uses sensible defaults.' : ''}
        </span>
        <Space>
          <Button onClick={() => navigate('/providers')}>Cancel</Button>
          <Button
            type="primary"
            disabled={!canSave}
            loading={saveMut.isPending}
            onClick={() => canSave && saveMut.mutate()}
          >
            {editing ? 'Save' : 'Create'}
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
