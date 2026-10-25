import { describe, expect, it } from 'vitest';
import type { RunnerModelCatalog } from './dto';
import {
  AgentProvider,
  CURSOR_DEFAULT_PERMISSION_MODE,
  CURSOR_PERMISSION_MODES,
  DSH_PERMISSION_MODES,
  PermissionMode,
} from './enums';
import { DEFAULT_MODEL_BY_PROVIDER, fastModeAvailable, modelForProvider } from './models';
import {
  autoAvailable,
  derivePermissionSemantics,
  runtimeApprovalSupport,
} from './permissionSemantics';
import {
  ALL_ENGINES,
  ENGINE_CLI_NAMES,
  credentialEngines,
  defaultEngineOf,
  isEngine,
  isEngineCompatible,
  type EngineCredential,
} from './providerEngines';
import {
  PROVIDER_TRANSPORTS,
  SESSION_CLAUDE_STEER_WITHDRAW_V1,
  SESSION_CODEX_STEER_V1,
  SESSION_CURRENT_WORK_ROUTING_V1,
  runtimeTakesMidTurnSteer,
  supportsMidTurnSteer,
  supportsSteerWithdraw,
  supportsTargetBoundCurrentWorkSteer,
} from './providerTransport';

// Cursor CLI registered as the seventh engine (docs/cursor-runtime-contract.md; project P1). The
// acceptance script (scripts/test-cursor-engine.mjs) runs every case below by name.

const SIX = [
  AgentProvider.CLAUDE,
  AgentProvider.CODEX,
  AgentProvider.KIMI,
  AgentProvider.ANTIGRAVITY,
  AgentProvider.OPENCODE,
  AgentProvider.DSH,
];

const key = (
  runtime: string | null,
  presetSlug: string | null,
  baseUrl: string,
  subscriptionToken = false,
): EngineCredential => ({ kind: 'key', runtime, presetSlug, baseUrl, subscriptionToken });

/** Every credential that is not Cursor CLI's own sign-in, one of each kind and dialect. */
const OTHER_CREDENTIALS: EngineCredential[] = [
  ...(['claude', 'codex', 'kimi', 'antigravity'] as const).map(
    (engine): EngineCredential => ({ kind: 'login', engine }),
  ),
  { kind: 'pool', engine: AgentProvider.CLAUDE },
  { kind: 'pool', engine: AgentProvider.CODEX },
  { kind: 'opencode' },
  key('claude', 'glm', 'https://api.z.ai/api/anthropic'),
  key('claude', 'deepseek', 'https://api.deepseek.com/anthropic'),
  key('dsh', 'deepseek-harness', 'https://api.deepseek.com/anthropic'),
  key('claude', 'anthropic', 'https://api.anthropic.com', true),
  key('codex', 'openai', 'https://api.openai.com/v1'),
  key('kimi', 'moonshot', 'https://api.moonshot.ai/v1'),
  key('antigravity', 'gemini', 'https://generativelanguage.googleapis.com'),
];

const MODES = Object.values(PermissionMode);

describe('P1 Cursor CLI in the shared engine tables', () => {
  it('P1 cursor is the seventh engine under its CLI name, with an opaque model space defaulting to Auto', () => {
    expect(AgentProvider.CURSOR).toBe('cursor');
    // Appended: the six keep their order, which every picker lists them in.
    expect(ALL_ENGINES).toEqual([...SIX, AgentProvider.CURSOR]);
    expect(ENGINE_CLI_NAMES[AgentProvider.CURSOR]).toBe('Cursor CLI');
    expect(isEngine('cursor')).toBe(true);
    for (const near of ['Cursor', 'cursor-cli', 'cursor-agent', 'agent', ' cursor']) expect(isEngine(near)).toBe(false);
    // No static model: a blank pick leaves Cursor CLI on Auto (`default[]`, contract §10, §16.3).
    expect(DEFAULT_MODEL_BY_PROVIDER[AgentProvider.CURSOR]).toBe('');
    expect(modelForProvider(AgentProvider.CURSOR)).toBe('');
    // Its ACP model values are opaque variants, and it runs other vendors' models: none is coerced.
    for (const model of [
      'default[]',
      'gpt-5.5[context=272k,reasoning=medium,fast=false]',
      'claude-opus-5-5',
      'gpt-5.6-sol',
      'kimi-code/kimi-for-coding',
      'gemini-3.8-flash',
    ]) {
      expect(modelForProvider(AgentProvider.CURSOR, model)).toBe(model);
    }
  });

  it('P1 a runner sign-in to cursor runs on cursor alone, and no other credential runs on cursor', () => {
    const login: EngineCredential = { kind: 'login', engine: 'cursor' };
    expect(credentialEngines(login)).toEqual([AgentProvider.CURSOR]);
    expect(defaultEngineOf(login)).toBe(AgentProvider.CURSOR);
    expect(isEngineCompatible(AgentProvider.CURSOR, login)).toBe(true);
    for (const engine of SIX) expect(isEngineCompatible(engine, login)).toBe(false);
    for (const credential of OTHER_CREDENTIALS) {
      expect(credentialEngines(credential)).not.toContain(AgentProvider.CURSOR);
      expect(isEngineCompatible(AgentProvider.CURSOR, credential)).toBe(false);
    }
    // Cursor CLI's own API key (P2) is the one key that runs on it: cursor-api-key.spec.ts.
  });

  it('P1 cursor is one resident JSON-RPC process per session with no mid-turn steer and no fast lane', () => {
    expect(PROVIDER_TRANSPORTS[AgentProvider.CURSOR]).toBe('json-rpc');
    const every = [SESSION_CODEX_STEER_V1, SESSION_CURRENT_WORK_ROUTING_V1, SESSION_CLAUDE_STEER_WITHDRAW_V1];
    for (const capabilities of [undefined, [], every]) {
      expect(supportsMidTurnSteer(AgentProvider.CURSOR, capabilities)).toBe(false);
      expect(supportsTargetBoundCurrentWorkSteer(AgentProvider.CURSOR, capabilities)).toBe(false);
      expect(supportsSteerWithdraw(AgentProvider.CURSOR, capabilities)).toBe(false);
    }
    expect(runtimeTakesMidTurnSteer(AgentProvider.CURSOR)).toBe(false);
    // A catalogue row claiming a fast lane does not give Cursor CLI one.
    const catalog = {
      cursor: [{ value: 'gpt-5.5', label: 'GPT-5.5', fastMode: true, serviceTiers: ['priority'] }],
    } as unknown as RunnerModelCatalog;
    expect(fastModeAvailable(AgentProvider.CURSOR, 'gpt-5.5', catalog)).toBe(false);
    expect(fastModeAvailable(AgentProvider.CURSOR, 'gpt-5.5')).toBe(false);
  });

  it('P5c cursor keeps Accept Edits, Plan, Auto, Don’t Ask and Bypass, and refuses Default with a note', () => {
    expect(CURSOR_PERMISSION_MODES).toEqual([
      PermissionMode.ACCEPT_EDITS,
      PermissionMode.PLAN,
      PermissionMode.AUTO,
      PermissionMode.DONT_ASK,
      PermissionMode.BYPASS,
    ]);
    // A session nobody named a mode for starts in one Cursor CLI keeps.
    expect(CURSOR_DEFAULT_PERMISSION_MODE).toBe(PermissionMode.ACCEPT_EDITS);
    expect(CURSOR_PERMISSION_MODES).toContain(CURSOR_DEFAULT_PERMISSION_MODE);
    expect(runtimeApprovalSupport(AgentProvider.CURSOR)).toBe('partial');
    // Auto is the runner's review of each request, on any model.
    expect(autoAvailable(AgentProvider.CURSOR, 'default[]')).toBe(true);
    expect(autoAvailable(AgentProvider.CURSOR, 'gpt-5.5', true)).toBe(true);

    const of = (mode: PermissionMode, runsAsRoot?: boolean) =>
      derivePermissionSemantics(AgentProvider.CURSOR, mode, 'default[]', runsAsRoot);
    const refusedDefault = of(PermissionMode.DEFAULT);
    expect(refusedDefault).toMatchObject({ mode: 'default', unapproved: 'deny', approvalSupport: 'partial', honored: false });
    expect(refusedDefault.note).toMatch(/cannot ask before it edits a file/);
    expect(refusedDefault.note).toMatch(/Session configuration is rejected; use Accept Edits, Plan, Auto, Don’t Ask or Bypass\.$/);
    expect(refusedDefault.shortNote).toBe('unsupported on Cursor CLI; session configuration is rejected');

    const acceptEdits = of(PermissionMode.ACCEPT_EDITS);
    expect(acceptEdits).toMatchObject({ unapproved: 'ask', honored: true });
    expect(of(PermissionMode.PLAN)).toMatchObject({ unapproved: 'deny', honored: true });
    const auto = of(PermissionMode.AUTO);
    expect(auto).toMatchObject({ mode: 'auto', unapproved: 'allow', honored: true });
    expect(auto.note).toMatch(/^Edits inside the workspace and in temporary directories run without asking and are not reviewed\. Orbit allows a routine command itself/);
    // Plan: Cursor's plan mode, every request refused but Orbit's own tools, and the turn stopped when the
    // model switches out of it (measured: an edit after the switch is written otherwise).
    expect(of(PermissionMode.PLAN).note).toMatch(/If it switches itself out of Plan, Orbit stops the turn\.$/);
    // Don't Ask holds commands, MCP tools and fetches, but not a write inside the workspace: disclosed.
    const dontAsk = of(PermissionMode.DONT_ASK);
    expect(dontAsk).toMatchObject({ unapproved: 'deny', honored: false });
    expect(dontAsk.note).toMatch(/edits files inside the workspace and in temporary directories without asking in every mode/);
    expect(dontAsk.shortNote).toBe('partly enforced, edits inside the workspace still run');
    // `--force` runs as root: Bypass is not Claude Code's root refusal here. When the account's team turns
    // Run Everything off, Cursor asks anyway, and Orbit asks the person.
    for (const root of [undefined, false, true]) {
      expect(of(PermissionMode.BYPASS, root)).toMatchObject({
        mode: 'bypassPermissions', unapproved: 'allow', approvalSupport: 'partial', honored: true,
      });
      expect(of(PermissionMode.BYPASS, root).note).toMatch(/Run Everything/);
    }

    for (const mode of MODES) {
      const semantics = of(mode);
      // A short note exactly when the mode is not kept as written (PermissionSemantics.shortNote).
      expect(!!semantics.shortNote).toBe(!semantics.honored);
      // What the semantics call rejected is exactly what the server refuses (CURSOR_PERMISSION_MODES).
      expect(/rejected/.test(semantics.note ?? '')).toBe(!CURSOR_PERMISSION_MODES.includes(mode));
    }
  });

  it('P1 the six existing engines keep their names, transports, steer and permission tables', () => {
    expect(ALL_ENGINES.slice(0, 6)).toEqual(SIX);
    expect(SIX.map((engine) => ENGINE_CLI_NAMES[engine])).toEqual([
      'Claude Code', 'Codex', 'Kimi Code', 'Antigravity CLI', 'OpenCode', 'DeepSeek Harness',
    ]);
    expect(SIX.map((engine) => PROVIDER_TRANSPORTS[engine])).toEqual([
      'stream-json', 'json-rpc', 'json-rpc', 'stream-json', 'one-shot', 'json-rpc',
    ]);
    expect(supportsMidTurnSteer(AgentProvider.CLAUDE)).toBe(true);
    expect(supportsMidTurnSteer(AgentProvider.CODEX, [SESSION_CODEX_STEER_V1])).toBe(true);
    expect(SIX.map((engine) => runtimeApprovalSupport(engine))).toEqual([
      'full', 'partial', 'partial', 'full', 'none', 'partial',
    ]);
    expect(DSH_PERMISSION_MODES).toEqual([PermissionMode.DEFAULT, PermissionMode.AUTO, PermissionMode.DONT_ASK]);
    for (const engine of [AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.ANTIGRAVITY, AgentProvider.OPENCODE, AgentProvider.DSH]) {
      expect(autoAvailable(engine, 'any-model')).toBe(true);
    }
    expect(derivePermissionSemantics(AgentProvider.CLAUDE, PermissionMode.DEFAULT)).toEqual({
      mode: 'default', unapproved: 'ask', approvalSupport: 'full', honored: true,
    });
    expect(DEFAULT_MODEL_BY_PROVIDER[AgentProvider.CLAUDE]).toBe('claude-opus-5');
    expect(modelForProvider(AgentProvider.CODEX, 'claude-opus-5')).toBe('gpt-5.6-sol');
    for (const engine of ['claude', 'codex', 'kimi', 'antigravity'] as const) {
      expect(credentialEngines({ kind: 'login', engine })).toEqual([engine]);
    }
    expect(credentialEngines(key('claude', 'deepseek', 'https://api.deepseek.com/anthropic'))).toEqual([
      'claude', 'opencode', 'dsh',
    ]);
  });
});
