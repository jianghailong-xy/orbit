import { describe, expect, it } from 'vitest';
import { AgentProvider } from './enums';
import {
  declaresLocalProbe,
  isCloudModelId,
  localProviderStatus,
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

describe('localProviderStatus', () => {
  it('reads READY only from a runner that can probe and a probe that said so', () => {
    expect(localProviderStatus(row(), probing)).toEqual({
      state: 'READY',
      capability: 'SUPPORTED',
      probedAt: '2026-11-13T00:00:00.000Z',
      version: '0.40.16',
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
      const status = localProviderStatus(row(), runner);
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
    expect(localProviderStatus(row({ probeState: 'UNREACHABLE' }), probing).state).toBe('UNREACHABLE');
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
