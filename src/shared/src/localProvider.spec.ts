import { describe, expect, it } from 'vitest';
import { AgentProvider } from './enums';
import {
  declaresLocalProbe,
  isCloudModelId,
  LOCAL_PROBE_STALE_MS,
  localProviderStatus,
  sanitizeInstanceModels,
  sanitizeLocalProviderProbe,
  OLLAMA_PRESET_SLUG,
  OLLAMA_PROBE_CAPABILITY,
} from './localProvider';
import { credentialEngines } from './providerEngines';

const row = (over: Partial<Parameters<typeof localProviderStatus>[0]> = {}) => ({
  enabled: true,
  probeState: 'READY',
  probedAt: '2026-11-13T00:00:00.000Z',
  probeVersion: '0.40.16',
  instanceModels: [{ value: 'qwen3.8:27b', contextWindow: 65536, tools: true }],
  ...over,
});
const probing = { capabilities: [OLLAMA_PROBE_CAPABILITY], capabilitiesReportedAt: '2026-11-13T00:00:00.000Z' };
/** A minute after the row's probe: fresh. */
const NOW = Date.parse('2026-11-13T00:01:00.000Z');

describe('localProviderStatus', () => {
  it('reads READY only from a runner that can probe and a probe that said so', () => {
    expect(localProviderStatus(row({ probeLatencyMs: 12 }), probing, NOW)).toEqual({
      state: 'READY',
      capability: 'SUPPORTED',
      probedAt: '2026-11-13T00:00:00.000Z',
      version: '0.40.16',
      latencyMs: 12,
      models: [{ value: 'qwen3.8:27b', contextWindow: 65536, tools: true }],
    });
  });

  it('marks a runner that never declared the probe as capability UNKNOWN, never healthy', () => {
    // An old runner reports no capabilities at all (capabilitiesReportedAt NULL); a newer one without the
    // probe reports others. Neither may turn a stale READY into a health claim.
    for (const runner of [
      { capabilities: [], capabilitiesReportedAt: null },
      { capabilities: ['dir-probe/v1'], capabilitiesReportedAt: '2026-11-13T00:00:00.000Z' },
      { capabilities: [OLLAMA_PROBE_CAPABILITY], capabilitiesReportedAt: null },
    ]) {
      const status = localProviderStatus(row(), runner, NOW);
      expect(status.capability).toBe('UNKNOWN');
      expect(status.state).toBe('UNKNOWN');
    }
  });

  it('reads UNKNOWN until a probe has answered, and ignores a state it does not know', () => {
    expect(localProviderStatus(row({ probeState: null, probedAt: null }), probing).state).toBe('UNKNOWN');
    expect(localProviderStatus(row({ probeState: 'HEALTHY-ISH' }), probing).state).toBe('UNKNOWN');
    expect(localProviderStatus(row({ instanceModels: null }), probing).models).toBeNull();
  });

  it('puts the row\'s own reasons first: switched off, then no runner of the owner\'s', () => {
    expect(localProviderStatus(row({ enabled: false }), probing).state).toBe('DISABLED');
    expect(localProviderStatus(row(), null).state).toBe('NO_RUNNER');
    expect(localProviderStatus(row({ probeState: 'UNREACHABLE' }), probing, NOW).state).toBe('UNREACHABLE');
  });

  it('tells unavailable states apart, and reads any probe older than the stale window as STALE', () => {
    for (const state of ['NO_MODELS', 'MODEL_MISSING', 'CAPABILITY_MISSING', 'REFUSED', 'MALFORMED'] as const) {
      expect(localProviderStatus(row({ probeState: state }), probing, NOW).state).toBe(state);
    }
    const probedAt = Date.parse('2026-11-13T00:00:00.000Z');
    expect(localProviderStatus(row(), probing, probedAt + LOCAL_PROBE_STALE_MS).state).toBe('READY');
    expect(localProviderStatus(row(), probing, probedAt + LOCAL_PROBE_STALE_MS + 1).state).toBe('STALE');
    expect(localProviderStatus(row({ probeState: 'UNREACHABLE' }), probing, probedAt + LOCAL_PROBE_STALE_MS + 1).state).toBe('STALE');
    // Unknown stays unknown, and the row's own reasons still come first.
    expect(localProviderStatus(row({ probeState: null, probedAt: null }), probing, NOW).state).toBe('UNKNOWN');
    expect(localProviderStatus(row({ enabled: false }), probing, probedAt + 10 * LOCAL_PROBE_STALE_MS).state).toBe('DISABLED');
    expect(localProviderStatus(row(), probing, NOW).latencyMs).toBeNull();
  });
});

describe('the runner\'s probe report', () => {
  const PRIVATE = 'PRIVATE SYSTEM PROMPT sk-live-secret';
  it('keeps well-formed names and bounded fields only', () => {
    expect(sanitizeInstanceModels([
      { value: 'qwen3.8:27b', contextWindow: 131072, tools: true, parameterSize: '27.3B', quantization: 'Q4_K_M', template: PRIVATE },
      { value: 'qwen3.8:27b', tools: false },
      { value: 'library/llama3:latest', label: 'llama3:latest' },
      { value: 'gpt-oss:20b-cloud', tools: true },
      { value: `bad name ${PRIVATE}` },
      { value: 'x:1', contextWindow: -1, tools: 'yes', parameterSize: PRIVATE.repeat(3), quantization: 'Q4\u0000' },
      null,
    ])).toEqual([
      { value: 'qwen3.8:27b', contextWindow: 131072, tools: true, parameterSize: '27.3B', quantization: 'Q4_K_M' },
      { value: 'library/llama3:latest', label: 'llama3:latest' },
      { value: 'x:1' },
    ]);
    expect(sanitizeInstanceModels('nope')).toBeNull();
  });

  it('drops a report it cannot trust, and bounds the rest', () => {
    const ok = { providerId: 'p', baseUrl: 'http://127.0.0.1:11434', state: 'READY', checkedAt: '2026-11-13T00:00:00Z', latencyMs: 3.6, version: '0.40.16' };
    expect(sanitizeLocalProviderProbe(ok)).toEqual({
      providerId: 'p', baseUrl: 'http://127.0.0.1:11434', state: 'READY', version: '0.40.16',
      checkedAt: new Date('2026-11-13T00:00:00Z'), latencyMs: 4, reason: null, models: null,
    });
    expect(sanitizeLocalProviderProbe({ ...ok, state: 'HEALTHY' })).toBeNull();
    expect(sanitizeLocalProviderProbe({ ...ok, providerId: '' })).toBeNull();
    expect(sanitizeLocalProviderProbe({ ...ok, baseUrl: undefined })).toBeNull();
    const odd = sanitizeLocalProviderProbe({ ...ok, version: PRIVATE.repeat(5), reason: `x\n${PRIVATE}`, latencyMs: -1, checkedAt: 'never' })!;
    expect(odd.version).toBeNull();
    expect(odd.reason).toBeNull();
    expect(odd.latencyMs).toBeNull();
    expect(odd.checkedAt).toBeNull();
  });
});

describe('local provider rules', () => {
  it('recognizes Ollama cloud model ids, whatever the case', () => {
    for (const id of ['gpt-oss:20b-cloud', 'kimi-k2:1t-cloud', 'deepseek-v3.1:671B-CLOUD', 'glm-4.6:cloud']) {
      expect(isCloudModelId(id)).toBe(true);
    }
    for (const id of ['qwen3.8:27b', 'qwen3-coder:30b', 'cloudy:7b', 'llama3']) expect(isCloudModelId(id)).toBe(false);
  });

  it('reads the probe capability case- and space-insensitively', () => {
    expect(declaresLocalProbe([` ${OLLAMA_PROBE_CAPABILITY.toUpperCase()} `])).toBe(true);
    expect(declaresLocalProbe(undefined)).toBe(false);
  });

  it('runs a local key on Claude Code alone — never OpenCode, DeepSeek Harness or Codex', () => {
    const local = { kind: 'key' as const, presetSlug: OLLAMA_PRESET_SLUG, baseUrl: 'http://127.0.0.1:11434', subscriptionToken: false, local: true };
    expect(credentialEngines({ ...local, runtime: 'claude' })).toEqual([AgentProvider.CLAUDE]);
    expect(credentialEngines({ ...local, runtime: 'codex' }, { anthropicGateway: true })).toEqual([]);
    // The same row without the flag is what an older reader sees: the ordinary table, unchanged.
    expect(credentialEngines({ ...local, runtime: 'claude', local: undefined })).toEqual([AgentProvider.CLAUDE, AgentProvider.OPENCODE]);
  });
});
