import { type ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  type TableColumnsType,
} from 'antd';
import { api } from '../api';
import { meQuery, providersQuery } from '../lib/queries';
import { PROVIDER_PRESETS, type ProviderBrand } from '../lib/providerPresets';

interface ProviderModelRow {
  value: string;
  label: string;
  contextWindow?: number;
}

// A provider row as the management APIs return it (mine or shared): every field except the
// encrypted key, which is surfaced only as `hasApiKey`.
interface ProviderRow {
  id: string;
  slug: string;
  label: string;
  runtime: string;
  baseUrl: string;
  models: ProviderModelRow[];
  defaultModel: string | null;
  enabled: boolean;
  hasApiKey: boolean;
}

// A model row while it's being edited in the form. contextWindow is a free InputNumber (null when
// blank) rather than the wire's optional number, so an empty cell round-trips cleanly.
interface DraftModel {
  value: string;
  label: string;
  contextWindow: number | null;
}

// The brand for a provider: presets ship one; a custom provider falls back to a neutral monogram
// derived from its label.
function brandFor(slug: string, label: string): ProviderBrand {
  const preset = PROVIDER_PRESETS.find((p) => p.slug === slug);
  if (preset) return preset.brand;
  return { mono: (label.trim()[0] ?? '?').toUpperCase(), from: '#9aa0a8', to: '#6b7178' };
}

// The square logo tile — a monogram over the brand gradient, or a dashed neutral tile for "Custom".
function ProviderTile({
  brand,
  size = 40,
  muted = false,
}: {
  brand: ProviderBrand;
  size?: number;
  muted?: boolean;
}) {
  const radius = Math.round(size * 0.26);
  const paint = muted
    ? {
        background: 'var(--fill-muted)',
        color: 'var(--text-3)',
        border: '1px dashed var(--border)',
        fontSize: Math.round(size * 0.5),
      }
    : {
        background: `linear-gradient(135deg, ${brand.from}, ${brand.to})`,
        fontSize: Math.round(size * 0.42),
      };
  return (
    <div className="provider-tile" style={{ width: size, height: size, borderRadius: radius, ...paint }}>
      {brand.mono}
    </div>
  );
}

/**
 * Model providers: "My providers" is every user's personal (BYOK) list — their own API key,
 * visible only to them (/providers/mine). Admins additionally manage the shared providers
 * every user sees (/admin/providers). Both sections share one table + form (ProviderSection);
 * only the endpoints and copy differ.
 */
export function ProvidersPage() {
  const me = useQuery(meQuery());
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1 className="page-title">Providers</h1>
      <ProviderSection
        title="My providers"
        hint="Personal providers use your own API key and are visible only to you."
        listKey={['providers', 'mine']}
        basePath="/providers/mine"
      />
      {me.data?.role === 'ADMIN' && (
        <ProviderSection
          title="Shared providers"
          hint="Available to every user on this deployment. Admin only."
          listKey={['admin', 'providers']}
          basePath="/admin/providers"
        />
      )}
    </div>
  );
}

function ProviderSection({
  title,
  hint,
  listKey,
  basePath,
}: {
  title: string;
  hint: string;
  listKey: string[];
  basePath: string;
}) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: listKey, queryFn: () => api<ProviderRow[]>(basePath) });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderRow | null>(null);
  // null = show the vendor gallery (create only); a preset slug or '__custom__' = show the form.
  const [chosen, setChosen] = useState<string | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [models, setModels] = useState<DraftModel[]>([]);

  // Stateless pre-save probe of the endpoint + typed key (POST /providers/test).
  const testMut = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; status?: number; message: string }>('/providers/test', {
        method: 'POST',
        body: {
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          model: defaultModel.trim() || models.find((m) => m.value.trim())?.value || '',
        },
      }),
  });

  // Both this section's list and the de-sensitized ['providers'] catalog the pickers read
  // must refresh on any change.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: listKey });
    void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
  };

  const resetFields = () => {
    setSlug('');
    setLabel('');
    setBaseUrl('');
    setApiKey('');
    setDefaultModel('');
    setEnabled(true);
    setModels([]);
  };

  // Create: open the modal at the vendor gallery.
  const openCreate = () => {
    setEditing(null);
    setChosen(null);
    setAdvOpen(false);
    resetFields();
    testMut.reset();
    setOpen(true);
  };

  // Pick a vendor (from the modal gallery or the empty state). A preset pre-fills every field and
  // keeps the advanced block collapsed; '__custom__' starts blank with advanced expanded.
  const pickVendor = (key: string) => {
    setEditing(null);
    testMut.reset();
    if (key === '__custom__') {
      resetFields();
      setChosen('__custom__');
      setAdvOpen(true);
    } else {
      const p = PROVIDER_PRESETS.find((x) => x.slug === key);
      if (!p) return;
      setChosen(key);
      setAdvOpen(false);
      setSlug(p.slug);
      setLabel(p.label);
      setBaseUrl(p.baseUrl);
      setApiKey('');
      setDefaultModel(p.defaultModel);
      setEnabled(true);
      setModels(
        p.models.map((m) => ({ value: m.value, label: m.label, contextWindow: m.contextWindow ?? null })),
      );
    }
    setOpen(true);
  };

  const openEdit = (p: ProviderRow) => {
    setEditing(p);
    testMut.reset();
    setChosen(PROVIDER_PRESETS.some((x) => x.slug === p.slug) ? p.slug : '__custom__');
    setAdvOpen(false);
    setSlug(p.slug);
    setLabel(p.label);
    setBaseUrl(p.baseUrl);
    setApiKey(''); // never round-trips the stored key; blank keeps it
    setDefaultModel(p.defaultModel ?? '');
    setEnabled(p.enabled);
    setModels(
      (p.models ?? []).map((m) => ({
        value: m.value,
        label: m.label,
        contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
      })),
    );
    setOpen(true);
  };

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
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          models: modelPayload,
          defaultModel: dm,
          enabled,
        },
      });
    },
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEditing(null);
      message.success(editing ? 'Provider updated' : 'Provider created');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`${basePath}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      message.success('Provider deleted');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  // Create needs a key; edit keeps the stored one when left blank. slug/label/baseUrl always required.
  const canSave =
    label.trim() !== '' &&
    baseUrl.trim() !== '' &&
    (editing ? true : slug.trim() !== '' && apiKey.trim() !== '');

  const columns: TableColumnsType<ProviderRow> = [
    {
      title: 'Provider',
      key: 'provider',
      render: (_, p) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ProviderTile brand={brandFor(p.slug, p.label)} size={32} />
          <div>
            <div style={{ fontWeight: 600 }}>{p.label}</div>
            <code style={{ fontSize: 12, color: 'var(--text-3)' }}>{p.slug}</code>
          </div>
        </div>
      ),
    },
    {
      title: 'Models',
      key: 'models',
      render: (_, p) => (p.models?.length ? `${p.models.length}` : '—'),
    },
    {
      title: 'Endpoint',
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      render: (u: string) => <code style={{ fontSize: 12, color: 'var(--text-3)' }}>{u}</code>,
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (on: boolean) => <Tag color={on ? 'green' : 'default'}>{on ? 'Enabled' : 'Disabled'}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      align: 'right',
      render: (_, p) => (
        <Space>
          <Button size="small" onClick={() => openEdit(p)}>
            Edit
          </Button>
          <Popconfirm title={`Delete ${p.label}?`} onConfirm={() => deleteMut.mutate(p.id)}>
            <Button size="small" danger>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const preset =
    chosen && chosen !== '__custom__' ? PROVIDER_PRESETS.find((p) => p.slug === chosen) : undefined;
  const isCustom = chosen === '__custom__';
  const showGallery = chosen === null && !editing;
  // A test needs somewhere to send it, a key to send, and a model to probe with.
  const canTest =
    baseUrl.trim() !== '' &&
    apiKey.trim() !== '' &&
    (defaultModel.trim() !== '' || models.some((m) => m.value.trim() !== ''));

  const modalTitle = editing
    ? `Edit ${editing.label}`
    : showGallery
      ? 'Add provider'
      : isCustom
        ? 'Add custom provider'
        : `Connect ${preset?.label ?? ''}`;

  // The vendor gallery — shared by the modal's first step and the empty state.
  const gallery = (inModal: boolean) => (
    <div className={`provider-gallery${inModal ? ' in-modal' : ''}`}>
      {PROVIDER_PRESETS.map((p) => (
        <button key={p.slug} type="button" className="provider-card" onClick={() => pickVendor(p.slug)}>
          <ProviderTile brand={p.brand} />
          <div style={{ minWidth: 0 }}>
            <div className="pc-name">{p.label}</div>
            <div className="pc-sub">Anthropic-compatible</div>
          </div>
        </button>
      ))}
      <button type="button" className="provider-card custom" onClick={() => pickVendor('__custom__')}>
        <ProviderTile brand={{ mono: '+', from: '', to: '' }} muted />
        <div style={{ minWidth: 0 }}>
          <div className="pc-name">Custom</div>
          <div className="pc-sub">Manual endpoint</div>
        </div>
      </button>
    </div>
  );

  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <span style={{ color: 'var(--text-3)', fontSize: 12, textAlign: 'left', lineHeight: 1.4 }}>
        {showGallery
          ? "Can't find your provider? Choose Custom to enter an endpoint."
          : preset && !editing
            ? 'Everything else uses sensible defaults.'
            : ''}
      </span>
      <Space>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        {!showGallery && (
          <Button
            type="primary"
            disabled={!canSave}
            loading={saveMut.isPending}
            onClick={() => canSave && saveMut.mutate()}
          >
            {editing ? 'Save' : 'Create'}
          </Button>
        )}
      </Space>
    </div>
  );

  const body = showGallery ? (
    <>
      <div style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 16 }}>
        Pick a model provider to get started. Each uses your own key, visible only to you.
      </div>
      {gallery(true)}
    </>
  ) : (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {!editing && (
        <span
          className="provider-back"
          onClick={() => {
            testMut.reset();
            setChosen(null);
          }}
        >
          ‹ All providers
        </span>
      )}

      {preset && (
        <div className="provider-idbar">
          <ProviderTile brand={preset.brand} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{preset.label}</div>
            <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
              Anthropic-compatible · {preset.models.length} model{preset.models.length === 1 ? '' : 's'}{' '}
              included
            </div>
          </div>
        </div>
      )}

      {isCustom && (
        <Field label="Label">
          <Input placeholder="e.g. My provider" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      )}

      <Field
        label={
          <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <span>{preset ? `Paste your ${preset.label} API key` : 'API key'}</span>
            {preset?.keyUrl && (
              <a
                href={preset.keyUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, fontWeight: 500 }}
              >
                Get your API key ↗
              </a>
            )}
          </span>
        }
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
        <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>
          Stored encrypted — never sent back to your browser.
        </div>
      </Field>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: -6 }}>
        <Button size="small" onClick={() => testMut.mutate()} disabled={!canTest} loading={testMut.isPending}>
          Test connection
        </Button>
        {!testMut.isPending && testMut.data?.ok && (
          <span style={{ color: 'var(--success)', fontSize: 13, fontWeight: 500 }}>✓ {testMut.data.message}</span>
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

      <div className="provider-adv">
        <div
          className={`provider-adv-head${advOpen ? ' open' : ''}`}
          onClick={() => setAdvOpen((v) => !v)}
        >
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
                    'An Anthropic-compatible endpoint (the one the vendor documents for Claude Code).'}
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Switch checked={enabled} onChange={setEnabled} />
        <span>Enabled</span>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
          Disabled providers are hidden from the pickers.
        </span>
      </div>
    </Space>
  );

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ marginBottom: 0 }}>{title}</h2>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{hint}</div>
        </div>
        <Button type="primary" onClick={openCreate}>
          Add provider
        </Button>
      </div>

      {providers.isLoading ? (
        <Table
          rowKey="id"
          style={{ marginTop: 12 }}
          loading
          dataSource={[]}
          columns={columns}
          pagination={false}
        />
      ) : (providers.data?.length ?? 0) === 0 ? (
        <div className="provider-empty">
          <h3>Connect your first provider</h3>
          <p>Pick a provider and paste your API key — that's it.</p>
          {gallery(false)}
        </div>
      ) : (
        <Table
          rowKey="id"
          style={{ marginTop: 12 }}
          dataSource={providers.data ?? []}
          columns={columns}
          pagination={false}
        />
      )}

      <Modal
        title={modalTitle}
        open={open}
        onCancel={() => setOpen(false)}
        footer={footer}
        width={560}
        destroyOnClose
      >
        {body}
      </Modal>
    </div>
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
