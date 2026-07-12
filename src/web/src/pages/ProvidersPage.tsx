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
  Select,
  Space,
  Switch,
  Table,
  Tag,
  type TableColumnsType,
} from 'antd';
import { api } from '../api';
import { meQuery, providersQuery } from '../lib/queries';
import { PROVIDER_PRESETS } from '../lib/providerPresets';

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
  // Selected official template (create only): picking one pre-fills the form below;
  // every field stays editable afterwards. '' = start from a blank custom provider.
  const [preset, setPreset] = useState('');
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [models, setModels] = useState<DraftModel[]>([]);

  // Both this section's list and the de-sensitized ['providers'] catalog the pickers read
  // must refresh on any change.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: listKey });
    void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
  };

  const applyPreset = (slugKey: string) => {
    setPreset(slugKey);
    const p = PROVIDER_PRESETS.find((x) => x.slug === slugKey);
    if (!p) return; // '' = Custom: keep whatever is typed
    setSlug(p.slug);
    setLabel(p.label);
    setBaseUrl(p.baseUrl);
    setDefaultModel(p.defaultModel);
    setModels(
      p.models.map((m) => ({ value: m.value, label: m.label, contextWindow: m.contextWindow ?? null })),
    );
  };

  const openCreate = () => {
    setEditing(null);
    setPreset('');
    setSlug('');
    setLabel('');
    setBaseUrl('');
    setApiKey('');
    setDefaultModel('');
    setEnabled(true);
    setModels([]);
    setOpen(true);
  };
  const openEdit = (p: ProviderRow) => {
    setEditing(p);
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
        <div>
          <div>{p.label}</div>
          <code style={{ fontSize: 12, color: 'var(--text-3)' }}>{p.slug}</code>
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
      render: (u: string) => (
        <code style={{ fontSize: 12, color: 'var(--text-3)' }}>{u}</code>
      ),
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (on: boolean) => (
        <Tag color={on ? 'green' : 'default'}>{on ? 'Enabled' : 'Disabled'}</Tag>
      ),
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

      <Table
        rowKey="id"
        style={{ marginTop: 12 }}
        loading={providers.isLoading}
        dataSource={providers.data ?? []}
        columns={columns}
        pagination={false}
      />

      <Modal
        title={editing ? `Edit ${editing.label}` : 'Add provider'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => canSave && saveMut.mutate()}
        okButtonProps={{ disabled: !canSave }}
        confirmLoading={saveMut.isPending}
        okText={editing ? 'Save' : 'Create'}
        width={640}
        destroyOnClose
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {!editing && (
            <Field label="Template">
              <Select
                value={preset}
                onChange={applyPreset}
                style={{ width: '100%' }}
                options={[
                  { value: '', label: 'Custom (blank)' },
                  ...PROVIDER_PRESETS.map((p) => ({ value: p.slug, label: p.label })),
                ]}
              />
              <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>
                {PROVIDER_PRESETS.find((p) => p.slug === preset)?.note ??
                  'Official presets pre-fill an Anthropic-compatible endpoint and models — just add your API key.'}
              </div>
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
              Lowercase letters, digits and hyphens, starting with a letter. Can't be claude or
              codex. Fixed once created.
            </div>
          </Field>
          <Field label="Label">
            <Input
              placeholder="e.g. DeepSeek"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label="Base URL">
            <Input
              placeholder="https://api.example.com/anthropic"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>
              An Anthropic-compatible endpoint (the one the vendor documents for Claude Code).
            </div>
          </Field>
          <Field label="API key">
            <Input.Password
              placeholder={editing ? 'Leave blank to keep the current key' : 'Provider API key'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
            />
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Switch checked={enabled} onChange={setEnabled} />
            <span>Enabled</span>
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
              Disabled providers are hidden from the pickers.
            </span>
          </div>
        </Space>
      </Modal>
    </div>
  );
}

// One labelled form row: a small label above its control.
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
