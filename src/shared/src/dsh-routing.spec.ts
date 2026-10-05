import { describe, expect, it } from 'vitest';
import type { RunnerModelCatalog } from './dto';
import { AgentProvider, PermissionMode } from './enums';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  fastModeAvailable,
  modelForProvider,
  runnerCatalogRow,
} from './models';
import {
  autoAvailable,
  derivePermissionSemantics,
  runtimeApprovalSupport,
} from './permissionSemantics';
import { PROVIDER_PRESETS, providerPreset } from './providerPresets';
import {
  PROVIDER_TRANSPORTS,
  SESSION_CODEX_STEER_V1,
  SESSION_CURRENT_WORK_ROUTING_V1,
  supportsMidTurnSteer,
  supportsTargetBoundCurrentWorkSteer,
} from './providerTransport';

describe('P1a dsh shared routing', () => {
  it('P1a registers a resident ACP runtime without claiming steer support', () => {
    expect(Object.values(AgentProvider)).toContain('dsh');
    expect(PROVIDER_TRANSPORTS[AgentProvider.DSH]).toBe('json-rpc');
    for (const capabilities of [
      undefined,
      [],
      [SESSION_CODEX_STEER_V1, SESSION_CURRENT_WORK_ROUTING_V1],
    ]) {
      expect(supportsMidTurnSteer(AgentProvider.DSH, capabilities)).toBe(false);
      expect(supportsTargetBoundCurrentWorkSteer(AgentProvider.DSH, capabilities)).toBe(false);
    }
  });

  it('P1a keeps the legacy DeepSeek preset on Claude and adds an explicit Harness API Key preset', () => {
    const legacy = providerPreset('deepseek')!;
    expect(legacy.runtime ?? AgentProvider.CLAUDE).toBe(AgentProvider.CLAUDE);
    expect(legacy.defaultModel).toBe('deepseek-v4-pro');
    expect(legacy.models.map((model) => model.value)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
    expect(legacy.modelsFromRuntime).toBeUndefined();
    expect(legacy.catalog?.source).toBe('deepseek');

    const harness = providerPreset('deepseek-harness')!;
    expect(harness.label).toBe('DeepSeek Harness');
    expect(harness.runtime).toBe(AgentProvider.DSH);
    expect(harness.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(harness.keyUrl).toBe('https://platform.deepseek.com');
    expect(harness.modelsFromRuntime).toBe(true);
    expect(harness.models).toEqual([]);
    expect(harness.defaultModel).toBe('');
    expect(harness.catalog).toBeUndefined();
    expect(PROVIDER_PRESETS.some((preset) => preset.slug === AgentProvider.DSH)).toBe(false);
  });

  it('P1a preserves opaque Harness model and reasoning options with unknown context windows', () => {
    const token = '["deepseek", "deepseek-v4-pro"]';
    const row = {
      value: token,
      label: 'DeepSeek V4 Pro',
      reasoningLevels: ['off', 'low', 'high', 'max'],
      defaultReasoningLevel: 'max',
    };
    const catalog: RunnerModelCatalog = {
      [AgentProvider.DSH]: [row],
      [AgentProvider.CLAUDE]: [{ value: token, label: 'wrong runtime', contextWindow: 1_000_000 }],
    };
    expect(modelForProvider(AgentProvider.DSH, token)).toBe(token);
    // This is an opaque token, so a built-in-looking spelling must not be silently rewritten.
    expect(modelForProvider(AgentProvider.DSH, 'claude-compatible-token')).toBe(
      'claude-compatible-token',
    );
    expect(modelForProvider(AgentProvider.DSH, undefined)).toBe('');
    expect(DEFAULT_MODEL_BY_PROVIDER[AgentProvider.DSH]).toBe('');
    expect(runnerCatalogRow(AgentProvider.DSH, token, catalog)).toBe(row);
    expect(runnerCatalogRow(AgentProvider.DSH, token, catalog)?.reasoningLevels).toEqual([
      'off', 'low', 'high', 'max',
    ]);
    expect(runnerCatalogRow(AgentProvider.DSH, token, catalog)?.contextWindow).toBeUndefined();
    expect(runnerCatalogRow(AgentProvider.DSH, token, {
      [AgentProvider.CLAUDE]: catalog.claude,
    })).toBeUndefined();
  });

  it('P1a refuses unsupported Harness permission and fast-mode claims including defaults', () => {
    expect(runtimeApprovalSupport(AgentProvider.DSH)).toBe('partial');
    for (const mode of [undefined, null, ...Object.values(PermissionMode), 'unknown-mode']) {
      for (const runsAsRoot of [undefined, false, true]) {
        const semantics = derivePermissionSemantics(
          AgentProvider.DSH, mode, 'opaque-model', runsAsRoot,
        );
        expect(semantics.honored).toBe(false);
        expect(semantics.unapproved).toBe('deny');
        expect(semantics.mode).toBe(mode ?? PermissionMode.DONT_ASK);
        expect(semantics.approvalSupport).toBe('partial');
        expect(semantics.note).toContain('does not support these permission modes');
        expect(semantics.note).toContain('rejected until an enforced file policy is available');
        expect(semantics.shortNote).toContain('session configuration is rejected');
        expect(semantics.note).not.toMatch(/runs as Default|runs as Don't Ask/);
      }
    }
    const catalog: RunnerModelCatalog = {
      [AgentProvider.DSH]: [{
        value: 'opaque-model', label: 'Model', permissionModes: [PermissionMode.AUTO], fastMode: true,
      }],
    };
    expect(autoAvailable(AgentProvider.DSH, 'opaque-model', true, catalog)).toBe(false);
    expect(fastModeAvailable(AgentProvider.DSH, 'opaque-model', catalog)).toBe(false);
  });

  it('P1a preserves other built-in model and transport routes', () => {
    expect(PROVIDER_TRANSPORTS).toEqual({
      claude: 'stream-json',
      codex: 'json-rpc',
      kimi: 'json-rpc',
      opencode: 'one-shot',
      antigravity: 'stream-json',
      dsh: 'json-rpc',
    });
    expect(modelForProvider(AgentProvider.CLAUDE, 'deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(modelForProvider(AgentProvider.CLAUDE)).toBe('claude-opus-5');
    expect(modelForProvider(AgentProvider.CODEX)).toBe('gpt-5.6-sol');
    expect(modelForProvider(AgentProvider.KIMI)).toBe('kimi-code/kimi-for-coding');
    expect(modelForProvider(AgentProvider.OPENCODE, 'anthropic/claude-sonnet-5')).toBe(
      'anthropic/claude-sonnet-5',
    );
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(supportsMidTurnSteer(AgentProvider.CLAUDE)).toBe(true);
    expect(supportsMidTurnSteer(AgentProvider.CODEX, [SESSION_CODEX_STEER_V1])).toBe(true);
  });
});
