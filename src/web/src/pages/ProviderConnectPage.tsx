import { type ReactNode, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { api } from '../api';
import { presetModelsQuery, providersQuery, type PresetCatalogEntry } from '../lib/queries';
import {
  AgentProvider,
  ENGINE_CLI_NAMES,
  PROVIDER_PRESETS,
  providerPreset,
  type ProviderKeyUsage,
  type ProviderPreset,
} from '@orbit/shared';
import {
  PROVIDERS_BASE,
  PROVIDERS_LIST_KEY,
  suggestProviderName,
  type ProviderModelRow,
  type ProviderRow,
} from '../lib/providerAdmin';
import { EngineTile, newKeyEngines, ProviderGallery, ProviderTile, vendorName, vendorOf } from '../components/ProviderGallery';
import { DeepSeekBalanceSection } from '../components/DeepSeekBalance';
import { KeyImpact, keyInUse, KeyUse, keyUsageQuery } from '../components/KeyImpact';
import { hasDeepSeekBalance } from '../lib/deepseekBalance';
import { DSH_PRESET_SLUG } from '../lib/dshRuntime';
import { Button } from '../components/ui/Button';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { Input } from '../components/ui/Input';
import { NumberInput } from '../components/ui/NumberInput';
import { PasswordInput } from '../components/ui/PasswordInput';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { runtimeSummary } from '../lib/sessionProviderChoices';
import { useToast } from '../lib/toast';

// A model row while it's being edited in the form. contextWindow is a free number field (null when
// blank) rather than the wire's optional number, so an empty cell round-trips cleanly.
interface DraftModel {
  value: string;
  label: string;
  contextWindow: number | null;
}

/** The protocol a key's endpoint speaks, named by the engine that speaks it natively
 *  (ProviderPreset.runtime, and apiserver providers/dto.ts). */
type Runtime = NonNullable<ProviderPreset['runtime']>;

/** "Claude Code, OpenCode and DeepSeek Harness": engines named in a sentence. */
const engineList = (engines: AgentProvider[]): string => {
  const names = engines.map((engine) => ENGINE_CLI_NAMES[engine]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
};

/** A key's models as one line, its default first: "DeepSeek V4 Pro, V4 Flash" — the rest drop the
 *  first one's leading word they share, which only repeats the vendor. */
function modelLine(models: Pick<ProviderModelRow, 'value' | 'label'>[], defaultModel: string | null | undefined, emphasize: boolean): ReactNode {
  const first = models.find((m) => m.value === defaultModel) ?? models[0];
  if (!first) return null;
  const head = first.label || first.value;
  const lead = `${head.split(' ')[0]} `;
  const rest = models
    .filter((m) => m !== first)
    .map((m) => {
      const name = m.label || m.value;
      return name.startsWith(lead) ? name.slice(lead.length) : name;
    });
  return (
    <>
      {emphasize ? <b>{head}</b> : head}
      {rest.length > 0 && `, ${rest.join(', ')}`}
    </>
  );
}

/**
 * The engines a DeepSeek key works with and how each uses it (docs/mocks/provider-engine-decoupling,
 * boards 2 and 3): its models on Claude Code and OpenCode, Harness's own catalogue on each machine —
 * and on a saved key's page, what uses it on each right now (`usage`). The engine is picked when a
 * session starts; nothing is ticked here.
 */
function WorksWith({ engines, models, defaultModel, usage }: {
  engines: AgentProvider[];
  models: Pick<ProviderModelRow, 'value' | 'label'>[];
  defaultModel: string | null | undefined;
  /** A saved key's use, per engine; absent while connecting one. */
  usage?: { data?: ProviderKeyUsage };
}) {
  const connecting = !usage;
  return (
    <div className={`provider-works${connecting ? '' : ' with-use'}`}>
      <div className="provider-works-head">
        Works with
        <small>
          {connecting
            ? '— pick the engine when you start a session; this key is one of its providers'
            : '— pick it in the Provider menu of a session on any of these'}
        </small>
      </div>
      {engines.map((engine) => {
        // How the engine reaches DeepSeek, said while connecting; then the models it offers there.
        const how = !connecting
          ? null
          : engine === AgentProvider.DSH
            ? "DeepSeek's own agent"
            : engine === AgentProvider.OPENCODE
              ? 'as an OpenCode provider'
              : "DeepSeek's Anthropic-compatible API";
        const offers = engine === AgentProvider.DSH ? 'models from its catalogue on each machine' : modelLine(models, defaultModel, connecting);
        return (
          <div className="provider-works-row" key={engine}>
            <span className="provider-works-engine">
              <EngineTile engine={engine} size={18} />
              {ENGINE_CLI_NAMES[engine]}
            </span>
            <span className="provider-works-how">
              {how}
              {how && offers && ' · '}
              {offers}
            </span>
            {!connecting && (
              <span className="provider-works-use">
                {usage.data && (
                  <KeyUse use={usage.data.engines.find((e) => e.engine === engine)} separator=" · " idle="Not in use" />
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Step 1 of adding a provider (/providers/new): pick a vendor. Its own page rather than a modal
 * step, so picking a vendor is a normal navigation — back button included.
 */
export function ProviderPickPage() {
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/infrastructure#keys">
        ‹ Infrastructure
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
 * list Infrastructure fills and picks its id out of it.
 */
export function ProviderConnectPage() {
  const { slug, id } = useParams();

  // Read on both paths: editing needs the row itself, and connecting needs to know which vendors
  // are already set up — the form seeds its name from that. Same cached list Infrastructure
  // fills, so arriving from there costs nothing.
  const providers = useQuery({
    queryKey: PROVIDERS_LIST_KEY,
    queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE),
  });
  // A vendor's list is refreshed server-side, so the form asks for the current one rather than
  // seeding from the copy compiled into this bundle — otherwise the page that promises new models
  // "appear here on their own" would be the one place they don't. Waited for (it seeds state at
  // mount); a failed fetch falls through to the shipped list.
  const presetModels = useQuery(presetModelsQuery());

  if (presetModels.isPending || providers.isPending) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spinner />
      </div>
    );
  }

  const rows = providers.data ?? [];
  // The other providers this one shares a vendor with (vendorOf): a key from the retired DeepSeek
  // Harness preset is a DeepSeek key's sibling. Custom endpoints have no vendor and name themselves
  // anyway, so they are nobody's sibling.
  const siblingsOf = (presetSlug: string | null | undefined, selfId?: string) =>
    presetSlug ? rows.filter((p) => p.presetSlug && vendorOf(p.presetSlug) === vendorOf(presetSlug) && p.id !== selfId) : [];

  if (id) {
    const row = rows.find((p) => p.id === id);
    if (!row) {
      return (
        <div className="provider-form">
          <Link className="provider-back" to="/infrastructure#keys">
            ‹ Infrastructure
          </Link>
          <div style={{ marginTop: 16, color: 'var(--text-3)' }}>That provider no longer exists.</div>
        </div>
      );
    }
    // The vendor a row was created from is recorded on the row, not guessed from its slug — a
    // second key for the same vendor lands on "anthropic-2" and is still an Anthropic provider. A row
    // from the retired DeepSeek Harness preset is a DeepSeek key, and is edited as one.
    const rowPreset = providerPreset(vendorOf(row.presetSlug));
    return (
      <ProviderForm
        key={row.id}
        editing={row}
        preset={rowPreset}
        catalog={rowPreset && presetModels.data?.[rowPreset.slug]}
        siblings={siblingsOf(row.presetSlug, row.id)}
      />
    );
  }

  // DeepSeek Harness is an engine now, and runs on a DeepSeek key: its old connect address (older
  // apps' "Add API key" links to it) connects one.
  if (slug === DSH_PRESET_SLUG) return <Navigate to="/providers/new/deepseek" replace />;
  const preset = PROVIDER_PRESETS.find((p) => p.slug === slug);
  if (!preset && slug !== 'custom') return <Navigate to="/providers/new" replace />;
  return (
    <ProviderForm
      key={slug}
      preset={preset}
      catalog={preset && presetModels.data?.[preset.slug]}
      siblings={siblingsOf(preset?.slug)}
    />
  );
}

/**
 * The connect/edit form. Mounted fresh per vendor (or per edited row), so its fields seed from the
 * preset — or the stored row — once, at mount.
 */
function ProviderForm({
  preset,
  catalog,
  editing,
  siblings = [],
}: {
  preset?: ProviderPreset;
  /** What the preset offers as the server resolves it today; falls back to the shipped catalogue. */
  catalog?: PresetCatalogEntry;
  editing?: ProviderRow;
  /** The user's other providers from this same vendor — what makes the name worth asking about. */
  siblings?: ProviderRow[];
}) {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, confirmHolder] = useConfirm();
  // A custom provider names itself and declares its own endpoint; a preset ships every field but
  // the key, so those fields live behind Advanced.
  const isCustom = !preset;
  // The company the key is from, as the gallery names it.
  const vendor = preset ? vendorName(preset.slug) : null;
  const presetModels = catalog?.models ?? preset?.models ?? [];
  // The vendor's current pick, which a following provider dispatches with — not the one this
  // bundle was built with, or the form would probe the key against a model the session won't use.
  const presetDefault = catalog?.defaultModel ?? preset?.defaultModel;

  // Where the name lives: a step of its own, or Advanced. Connecting a vendor for the first time is
  // a walkthrough the preset can answer by itself, so it stays out of the way there — but editing
  // is a settings form, not a walkthrough, and renaming a provider is one of the few things it is
  // for. From the second key of a vendor on, the name is also the only thing telling them apart in
  // the model picker, so it leads the connect flow too.
  const named = isCustom || !!editing || siblings.length > 0;

  const [advOpen, setAdvOpen] = useState(isCustom && !editing);
  const [label, setLabel] = useState(
    editing
      ? editing.label
      : preset
        ? suggestProviderName(vendorName(preset.slug), siblings.map((s) => s.label))
        : '',
  );
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? preset?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  // The stored key once it's been read back, so a revealed-but-untouched field still counts as
  // "keep the current key" — showing what you configured shouldn't turn Save into a re-write.
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [models, setModels] = useState<DraftModel[]>(
    (editing?.models ?? presetModels).map((m) => ({
      value: m.value,
      label: m.label,
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
    })),
  );
  // Which runtime CLI this endpoint is driven by, and with it the dialect it has to speak:
  // Anthropic-compatible (claude), OpenAI-compatible (codex), Moonshot's own API (kimi), or
  // Google's Gemini API (antigravity). A preset knows its own, so only a custom provider is asked —
  // and only about the two dialects a hand-typed endpoint can implement. An edit sends the row's
  // runtime back as it is, so every one of them has to survive the round trip.
  const [runtime, setRuntime] = useState<Runtime>(
    editing
      ? editing.runtime === 'codex' || editing.runtime === 'kimi' || editing.runtime === 'antigravity' || editing.runtime === 'dsh'
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
  // Why the server refused the save — a key in use on an engine its new endpoint can't serve among the
  // reasons (PROVIDER_DIALECT_IN_USE) — shown above the buttons, as the server worded it.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Which engines the key runs on: a saved key's are the server's; one being connected, what its
  // vendor or typed endpoint gets by the shared table (newKeyEngines).
  const engines = editing ? editing.engines : newKeyEngines({ runtime, presetSlug: preset?.slug ?? null, baseUrl });
  // A DeepSeek key — the one key DeepSeek Harness runs on — says which engines get it, and how
  // (docs/mocks/provider-engine-decoupling, boards 2 and 3).
  const harness = engines.includes(AgentProvider.DSH);
  // What uses a saved DeepSeek key on each engine, beside each in Works with.
  const usage = useQuery({ ...keyUsageQuery(editing?.id ?? ''), enabled: !!editing && harness });

  // What Save has to carry: a key that came back from Reveal is the one already stored, so only a
  // typed change is a new key — and only a new key is worth probing.
  const newKey = apiKey.trim() && apiKey !== storedKey ? apiKey.trim() : '';

  const saveMut = useMutation({
    onMutate: () => setSaveError(null),
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
            ...(newKey ? { apiKey: newKey } : {}),
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
          apiKey: newKey,
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
      navigate('/infrastructure#keys');
    },
    onError: (e: Error) => setSaveError(e.message),
  });

  // Create needs a key; edit keeps the stored one when left blank. label/baseUrl always required.
  const canSave = label.trim() !== '' && baseUrl.trim() !== '' && (editing ? true : newKey !== '');
  // The model the probe pings with: the one a session would get by default.
  const probeModel = (
    presetDefault ||
    editing?.defaultModel ||
    models.find((m) => m.value.trim())?.value ||
    ''
  ).trim();

  /**
   * Load the stored key into the field. It's the caller's own key, and nothing else on this page
   * can say *which* key a provider holds — without this, checking one means re-pasting it from the
   * vendor. Fetched on demand rather than with the row, so a key reaches the browser only when
   * someone asks to see it.
   */
  const reveal = async () => {
    if (!editing) return;
    setRevealing(true);
    try {
      const r = await api<{ apiKey: string }>(`${PROVIDERS_BASE}/${editing.id}/key`);
      setStoredKey(r.apiKey);
      setApiKey(r.apiKey);
      setKeyVisible(true);
    } catch (e) {
      message.error("Couldn't load the key", (e as Error).message);
    } finally {
      setRevealing(false);
    }
  };

  /**
   * The single commit action. Connecting a provider *is* checking it works, so the probe rides
   * along with the save instead of sitting in its own step: one tiny request to the endpoint, then
   * the write. A failed probe stops short of saving and offers "Save anyway" — some endpoints
   * refuse a bare ping. Without a fresh key (an edit that keeps the stored one) there's nothing to
   * probe with, so it saves directly.
   */
  const connect = async () => {
    setProbeError(null);
    if (newKey && probeModel) {
      setProbing(true);
      try {
        const r = await api<{ ok: boolean; message: string }>('/providers/test', {
          method: 'POST',
          body: { baseUrl: baseUrl.trim(), apiKey: newKey, model: probeModel, runtime },
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

  /**
   * Save, after asking first when the save turns a key off that something uses (board 3 ②, the owner's
   * choice A): it stops on every engine it works with. Nothing using it, nothing to ask.
   */
  const save = async () => {
    if (editing?.enabled && !enabled) {
      const used = await qc.fetchQuery(keyUsageQuery(editing.id)).catch(() => null);
      if (!used || keyInUse(used)) {
        void confirm({
          title: `Turn off ${editing.label}?`,
          description: <KeyImpact row={editing} action="turnOff" />,
          confirmText: 'Turn off',
          width: 440,
          onConfirm: connect,
        });
        return;
      }
    }
    await connect();
  };

  /** Delete the key, once asked what that does to whatever uses it. */
  const deleteKey = () =>
    editing &&
    void confirm({
      title: `Delete ${editing.label}?`,
      description: <KeyImpact row={editing} action="delete" />,
      confirmText: 'Delete key',
      danger: true,
      width: 440,
      onConfirm: async () => {
        await api(`${PROVIDERS_BASE}/${editing.id}`, { method: 'DELETE' });
        void qc.invalidateQueries({ queryKey: PROVIDERS_LIST_KEY });
        void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
        message.success('Provider deleted');
        navigate('/infrastructure#keys');
      },
    });

  const title = editing
    ? `Edit ${editing.label}`
    : preset
      ? `Connect ${vendor}`
      : 'Add a custom provider';
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
      ? { ...preset, label: vendor!, runtime: preset.runtime ?? 'claude', count: presetModels.length, counted: 'included' }
      : null;

  return (
    <div className="provider-form">
      <Link className="provider-back" to={editing ? '/infrastructure#keys' : '/providers/new'}>
        {editing ? '‹ Infrastructure' : '‹ All providers'}
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
          they lead the walkthrough. A preset already knows all three — until a second key for the
          same vendor makes the name a decision again. */}
      {named && (
        <Step
          num={1}
          title={editing ? 'Name' : 'Name this provider'}
          hideNum={!isCustom || !!editing}
        >
          <Input
            placeholder="e.g. My provider"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          {preset && siblings.length > 0 && (
            <div className="ps-hint">
              {siblings.length === 1
                ? `You already have one ${vendor} key`
                : `You already have ${siblings.length} ${vendor} keys`}{' '}
              — the name is what tells them apart when picking a model.
            </div>
          )}
        </Step>
      )}

      {isCustom && (
        <Step num={2} title="Endpoint" hideNum={!!editing}>
          <div className="provider-stack" style={{ gap: 8 }}>
            <Select<Runtime>
              aria-label="API dialect"
              value={runtime}
              onValueChange={(v) => {
                if (!v) return;
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
          </div>
          <div className="ps-hint">
            {runtime === 'codex'
              ? 'The API dialect this endpoint speaks, and its base URL (e.g. up to /v1).'
              : 'The API dialect this endpoint speaks, and its base URL (the one the vendor documents for Claude Code).'}
          </div>
        </Step>
      )}

      <Step
        num={isCustom ? 3 : 1}
        title={preset ? `Paste your ${vendor} API key` : 'API key'}
        link={
          preset?.keyUrl && (
            <a href={preset.keyUrl} target="_blank" rel="noreferrer">
              Get your API key ↗
            </a>
          )
        }
        hideNum={!isCustom || !!editing}
      >
        {/* The field starts blank even when a key is stored — reading one back is a request of its
            own — so whether one exists is said by the placeholder, and Show fills it in. */}
        <PasswordInput
          placeholder={editing?.hasApiKey ? 'Leave blank to keep the current key' : 'Provider API key'}
          value={apiKey}
          visible={keyVisible}
          // On an empty field the eye means "show me the key this provider has", not "show me
          // nothing" — it loads the stored one, same as the link below.
          onVisibleChange={(v) => (v && !apiKey && editing?.hasApiKey ? void reveal() : setKeyVisible(v))}
          onChange={(e) => {
            setApiKey(e.target.value);
            setProbeError(null);
          }}
          autoComplete="new-password"
        />
        <div className="ps-hint">
          Stored encrypted — only you can see it.
          {editing?.hasApiKey && !apiKey ? (
            <>
              {' '}
              <a onClick={() => !revealing && void reveal()}>
                {revealing ? 'Loading…' : 'Show the current key'}
              </a>
            </>
          ) : (
            ''
          )}
          {newKey ? ` ${editing ? 'Saving' : 'Connecting'} sends one tiny test request first.` : ''}
        </div>
        {/* What agy does with the key, which the owner should know before handing it over
            (docs/antigravity-runtime-contract.md §3.2 and §7; docs/provider-engine-contract.md §4.6). */}
        {runtime === 'antigravity' && (
          <div className="ps-hint">
            Sessions on the Antigravity CLI and OpenCode hand this key to the CLI in its environment, where
            commands the agent runs can read it. agy also sends usage statistics (not your conversations)
            to Google; it has no setting that turns them off.
          </div>
        )}
      </Step>

      {/* Right under the key: the balance is the account's that key belongs to. Only a saved key has
          one — the server asks DeepSeek with what is stored, never with what is being typed. */}
      {editing && hasDeepSeekBalance(editing) && <DeepSeekBalanceSection row={editing} />}

      {harness && (
        <section className="provider-step">
          <WorksWith
            engines={engines}
            models={models.filter((m) => m.value.trim())}
            defaultModel={editing ? editing.defaultModel : presetDefault}
            usage={editing ? usage : undefined}
          />
          {/* Which processes the key reaches, measured per engine (docs/provider-engine-contract.md
              §4.6): every CLI but Harness lets the commands its agent runs read it. */}
          {!editing && (
            <div className="provider-who">
              <b>Who gets this key</b>
              <ul>
                <li>
                  Sessions on {engineList(engines.filter((engine) => engine !== AgentProvider.DSH))} hand this key
                  to the CLI in its environment, where commands the agent runs can read it.
                </li>
                <li>
                  DeepSeek Harness keeps it out of the commands it runs, but any program running as the runner's
                  user can still read it from the Harness process.
                </li>
                <li>
                  Orbit's server uses it to test it when you connect and to read this DeepSeek account's balance.
                </li>
              </ul>
            </div>
          )}
        </section>
      )}

      <div className="provider-adv" style={{ marginTop: 20 }}>
        <div className={`provider-adv-head${advOpen ? ' open' : ''}`} onClick={() => setAdvOpen((v) => !v)}>
          <span className="pa-chev">▸</span>
          <span>Advanced</span>
          {preset && <span className="provider-adv-badge">{editing ? 'From preset' : 'Auto-filled'}</span>}
        </div>
        {advOpen && (
          <div className="provider-adv-body">
            <div className="provider-stack" style={{ gap: 16 }}>
              {preset && (
                <>
                  {/* Only when it isn't already a step of its own above. */}
                  {!named && (
                    <Field label="Name">
                      <Input value={label} onChange={(e) => setLabel(e.target.value)} />
                    </Field>
                  )}
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
                          ? `${vendor}'s OpenAI-compatible endpoint.`
                          : preset.runtime === 'kimi'
                            ? `${vendor}'s own API, which the Kimi CLI speaks natively.`
                            : preset.runtime === 'antigravity'
                              ? `${vendor}'s own API, which the Antigravity CLI speaks natively.`
                              : harness
                                ? `${vendor}'s Anthropic-compatible API — ${engineList(engines)} all call it.`
                                : `The endpoint ${vendor} documents for Claude Code.`)}
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
                      Provided by the{' '}
                      {runtime === 'codex' ? 'Codex' : runtime === 'antigravity' ? 'Antigravity' : 'Claude Code'}{' '}
                      CLI on each runner, refreshed automatically — new models appear without any
                      change here.
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
                        {presetModels
                          .map((m) => (m.value === presetDefault ? `${m.label || m.value} (default)` : m.label || m.value))
                          .join(' · ')}
                      </div>
                      <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 6 }}>
                        {harness ? (
                          <>
                            For {engineList(engines.filter((engine) => engine !== AgentProvider.DSH))} — maintained by
                            Orbit from the official {vendor} catalogue. DeepSeek Harness lists its own models on each
                            machine.
                          </>
                        ) : (
                          <>
                            Maintained by Orbit from the official {vendor} catalogue and refreshed automatically — new
                            models appear on their own, and the newest becomes the default.
                          </>
                        )}
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
                        <NumberInput
                          aria-label="Context window"
                          placeholder="200000"
                          value={m.contextWindow}
                          min={0}
                          style={{ width: 140, flex: 'none' }}
                          onValueChange={(v) =>
                            setModels(models.map((r, j) => (j === i ? { ...r, contextWindow: v } : r)))
                          }
                        />
                        <Button
                          variant="text"
                          icon={<DeleteOutlined />}
                          aria-label="Delete"
                          onClick={() => setModels(models.filter((_, j) => j !== i))}
                        />
                      </div>
                    ))}
                    <Button
                      variant="dashed"
                      icon={<PlusOutlined />}
                      onClick={() => setModels([...models, { value: '', label: '', contextWindow: null }])}
                      style={{ width: '100%' }}
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
                      Follow the {vendor} catalogue again
                    </a>
                  </div>
                )}
              </Field>
            </div>
          </div>
        )}
      </div>

      {/* Nobody adds a provider they want switched off, so this is an edit-time control. Off is the
          key's, not an engine's: every engine it works with stops on it. */}
      {editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20 }}>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
          <span>Enabled</span>
          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
            {editing.engines.length > 0
              ? `Off stops it on ${engineList(editing.engines)}, and hides it from their Provider menus.`
              : 'Disabled providers are hidden from the pickers.'}
          </span>
        </div>
      )}

      {saveError && (
        <div className="provider-save-error" role="alert">
          <b>{editing ? "Couldn't save the provider." : "Couldn't connect the provider."}</b> {saveError}
        </div>
      )}

      <div className="provider-actions">
        <span className="provider-actions-start">
          {editing && (
            <Button danger onClick={deleteKey}>
              Delete key
            </Button>
          )}
          <span style={{ color: 'var(--error)', fontSize: 12, lineHeight: 1.4 }}>
            {probing ? <span style={{ color: 'var(--text-3)' }}>Testing the connection…</span> : probeError}
          </span>
        </span>
        <span className="prov-actions" style={{ gap: 8 }}>
          {probeError && (
            <Button loading={saveMut.isPending} onClick={() => saveMut.mutate()}>
              Save anyway
            </Button>
          )}
          <Button onClick={() => navigate('/infrastructure#keys')}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canSave}
            loading={probing || saveMut.isPending}
            onClick={() => canSave && void save()}
          >
            {editing ? 'Save' : 'Connect'}
          </Button>
        </span>
      </div>
      {confirmHolder}
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
