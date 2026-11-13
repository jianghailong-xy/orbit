import { describe, expect, it } from 'vitest';
import { isRetryableApiErrorText } from './events';
import {
  LOCAL_PROBE_STALE_MS,
  LOCAL_PROVIDER_RUN_CAPABILITY,
  LOCAL_PROVIDER_ERROR_PREFIX,
  LOCAL_PROVIDER_REFUSAL_CODES,
  LOCAL_PROVIDER_TRANSIENT_REFUSALS,
  localInstanceModel,
  localProviderReadiness,
  localTargetModel,
  OLLAMA_PROBE_CAPABILITY,
} from './localProvider';

const RUNNER = 'runner-a';
const NOW = Date.parse('2026-11-14T00:00:00Z');
const row = {
  slug: 'ollama',
  enabled: true,
  runnerId: RUNNER,
  probeState: 'READY',
  probedAt: new Date(NOW - 30_000),
  instanceModels: [
    { value: 'qwen3.8:27b', tools: true, contextWindow: 262_144 },
    { value: 'llama3:latest', tools: true, contextWindow: 131_072 },
    { value: 'notools:8b', tools: false, contextWindow: 131_072 },
    { value: 'tiny:1b', tools: true, contextWindow: 8_192 },
    { value: 'unsure:4b', tools: true },
  ],
};
const runner = { capabilities: [OLLAMA_PROBE_CAPABILITY, LOCAL_PROVIDER_RUN_CAPABILITY], capabilitiesReportedAt: new Date(NOW - 60_000) };
const target = { runnerId: RUNNER, runner, model: 'qwen3.8:27b' };
const code = (r: Partial<typeof row> & Record<string, unknown>, t: Partial<typeof target> & Record<string, unknown> = {}) =>
  localProviderReadiness({ ...row, ...r } as never, { ...target, ...t } as never, NOW)?.code ?? 'READY';

describe('localProviderReadiness', () => {
  it('runs a fresh, answering instance with the model, on its own probing runner', () => {
    expect(code({})).toBe('READY');
    expect(code({}, { model: 'llama3' })).toBe('READY');
  });

  it('refuses every other runner, and a row with none', () => {
    expect(code({}, { runnerId: 'runner-b' })).toBe('LOCAL_PROVIDER_ELSEWHERE');
    expect(code({}, { runnerId: undefined })).toBe('LOCAL_PROVIDER_ELSEWHERE');
    expect(code({ runnerId: null as never })).toBe('LOCAL_PROVIDER_NO_RUNNER');
    expect(code({ enabled: false })).toBe('LOCAL_PROVIDER_DISABLED');
  });

  it('refuses a runner that cannot say: no report, or no probe capability', () => {
    expect(code({}, { runner: null })).toBe('LOCAL_PROVIDER_RUNNER_OUTDATED');
    expect(code({}, { runner: { capabilities: [], capabilitiesReportedAt: new Date(NOW) } })).toBe('LOCAL_PROVIDER_RUNNER_OUTDATED');
    expect(code({}, { runner: { capabilities: [OLLAMA_PROBE_CAPABILITY, LOCAL_PROVIDER_RUN_CAPABILITY], capabilitiesReportedAt: null } })).toBe('LOCAL_PROVIDER_RUNNER_OUTDATED');
    // A phase 2 runner probes, but does not isolate the run (ollama-run/v1).
    expect(code({}, { runner: { capabilities: [OLLAMA_PROBE_CAPABILITY], capabilitiesReportedAt: new Date(NOW) } })).toBe('LOCAL_PROVIDER_RUNNER_OUTDATED');
  });

  it('refuses no probe, an old probe, and an instance that does not answer', () => {
    expect(code({ probeState: null as never })).toBe('LOCAL_PROVIDER_UNPROBED');
    expect(code({ probedAt: null as never })).toBe('LOCAL_PROVIDER_UNPROBED');
    expect(code({ probedAt: new Date(NOW - LOCAL_PROBE_STALE_MS - 1) })).toBe('LOCAL_PROVIDER_STALE');
    expect(code({ probeState: 'UNREACHABLE' })).toBe('LOCAL_PROVIDER_UNREACHABLE');
    for (const state of ['MALFORMED', 'REFUSED', 'CLOUD_ENABLED']) expect(code({ probeState: state })).toBe('LOCAL_PROVIDER_MISCONFIGURED');
    expect(code({ probeState: 'NO_MODELS' })).toBe('LOCAL_PROVIDER_NO_MODELS');
  });

  it('judges the model the session runs by its own catalogue entry', () => {
    expect(code({}, { model: 'mistral:7b' })).toBe('LOCAL_PROVIDER_MODEL_MISSING');
    expect(code({}, { model: null })).toBe('LOCAL_PROVIDER_MODEL_MISSING');
    expect(code({ instanceModels: null })).toBe('LOCAL_PROVIDER_MODEL_MISSING');
    expect(code({}, { model: 'notools:8b' })).toBe('LOCAL_PROVIDER_CAPABILITY_MISSING');
    expect(code({}, { model: 'tiny:1b' })).toBe('LOCAL_PROVIDER_CAPABILITY_MISSING');
    expect(code({}, { model: 'unsure:4b' })).toBe('LOCAL_PROVIDER_CAPABILITY_MISSING');
    expect(code({}, { model: 'gpt-oss:20b-cloud' })).toBe('LOCAL_PROVIDER_MISCONFIGURED');
    // A row-level MODEL_MISSING about another model the row names does not refuse this one.
    expect(code({ probeState: 'MODEL_MISSING' })).toBe('READY');
    expect(code({ probeState: 'CAPABILITY_MISSING' }, { model: 'notools:8b' })).toBe('LOCAL_PROVIDER_CAPABILITY_MISSING');
  });

  it('says which refusals clear on their own, in sentences that begin with the prefix and name no endpoint', () => {
    expect([...LOCAL_PROVIDER_TRANSIENT_REFUSALS].sort()).toEqual(
      ['LOCAL_PROVIDER_STALE', 'LOCAL_PROVIDER_UNPROBED', 'LOCAL_PROVIDER_UNREACHABLE'],
    );
    const refusal = localProviderReadiness({ ...row, probeState: 'UNREACHABLE' }, target, NOW)!;
    expect(refusal.transient).toBe(true);
    expect(refusal.message.startsWith(LOCAL_PROVIDER_ERROR_PREFIX)).toBe(true);
    expect(localProviderReadiness(row, { ...target, model: 'tiny:1b' }, NOW)!.transient).toBe(false);
    expect(LOCAL_PROVIDER_REFUSAL_CODES).toHaveLength(11);
    expect(refusal.message).not.toMatch(/127\.0\.0\.1|11434/);
  });

  it('matches a tagless name to its :latest, and picks the session model, then the row default, then its first', () => {
    expect(localInstanceModel(row.instanceModels, 'llama3')?.value).toBe('llama3:latest');
    expect(localInstanceModel(row.instanceModels, 'qwen3.8')).toBeUndefined();
    expect(localTargetModel({ defaultModel: 'b', models: [{ value: 'c' }] }, ' a ')).toBe('a');
    expect(localTargetModel({ defaultModel: 'b', models: [{ value: 'c' }] }, null)).toBe('b');
    expect(localTargetModel({ defaultModel: '', models: [{ value: 'c' }] }, '')).toBe('c');
    expect(localTargetModel({ defaultModel: null, models: [] }, undefined)).toBeNull();
  });
});

describe('a local model server\'s failures', () => {
  it('does not re-send what cannot succeed: out of memory, a crashed runner, a missing model', () => {
    expect(isRetryableApiErrorText('API Error: 500 {"error":{"message":"model requires more system memory (31.2 GiB) than is available (12.0 GiB)"}}')).toBe(false);
    expect(isRetryableApiErrorText('API Error: 500 {"error":"llama runner process has terminated: exit status 2"}')).toBe(false);
    expect(isRetryableApiErrorText('API Error: 500 {"error":"cudaMalloc failed: out of memory"}')).toBe(false);
    expect(isRetryableApiErrorText('API Error: 404 {"error":{"message":"model \\"x\\" not found, try pulling it first"}}')).toBe(false);
  });

  it('leaves every cloud provider\'s 500 as it was, even one that mentions memory or a missing model', () => {
    expect(isRetryableApiErrorText('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error: out of memory"}}')).toBe(true);
    expect(isRetryableApiErrorText('API Error: 500 {"error":{"message":"upstream worker out of memory, retry"}}')).toBe(true);
    expect(isRetryableApiErrorText('API Error: 502 {"error":{"message":"model not found on this replica"}}')).toBe(true);
    expect(isRetryableApiErrorText('API Error: 503 {"error":{"message":"CUDA out of memory on shard 3"}}')).toBe(true);
  });

  it('still re-sends what clears on its own: busy, overloaded, a timeout, a bare 500', () => {
    expect(isRetryableApiErrorText('API Error: 503 {"error":"server busy, please try again.  maximum pending requests exceeded"}')).toBe(true);
    expect(isRetryableApiErrorText('API Error: Request timed out.')).toBe(true);
    expect(isRetryableApiErrorText('API Error: 500 Internal server error')).toBe(true);
    expect(isRetryableApiErrorText('API Error: 529 {"type":"overloaded_error"}')).toBe(true);
  });
});
