import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_REGION_CARRY_OVER_MS,
  claudeRegionRefusedError,
  claudeRegionStoppedError,
  credentialIsAnthropicBound,
  effectiveRegionVerdict,
  regionVerdictFor,
  type AnthropicBoundCredential,
} from './claude-region-check';
import {
  CLAUDE_REGION_REFUSED_SUBTYPE,
  CLAUDE_REGION_STOPPED_SUBTYPE,
  CLAUDE_REGION_UNSUPPORTED,
  CLAUDE_REGION_V1,
  type ClaudeRegionDecidedVerdict,
  type RunnerRegion,
} from './dto';
import { AgentProvider } from './enums';
import type { EngineCredential } from './providerEngines';

describe('the wire names', () => {
  it('are the contract’s strings', () => {
    expect(CLAUDE_REGION_V1).toBe('claude-region/v1');
    expect(CLAUDE_REGION_UNSUPPORTED).toBe('CLAUDE_REGION_UNSUPPORTED');
    expect(CLAUDE_REGION_REFUSED_SUBTYPE).toBe('region_refused');
    expect(CLAUDE_REGION_STOPPED_SUBTYPE).toBe('region_stopped');
  });
});

describe('regionVerdictFor', () => {
  it.each([
    ['CN', 'mainland China'],
    ['HK', 'Hong Kong'],
    ['MO', 'Macau'],
    ['RU', 'Russia'],
    ['BY', 'Belarus'],
    ['IR', 'Iran'],
    ['KP', 'North Korea'],
    ['SY', 'Syria'],
    ['CU', 'Cuba'],
    ['VE', 'Venezuela'],
    ['AF', 'Afghanistan'],
    ['MM', 'Myanmar'],
  ])('blocks %s (%s): Anthropic does not list it', (country, name) => {
    expect(regionVerdictFor(country, null)).toEqual({ verdict: 'blocked', country, regionCode: null, name });
  });

  it.each([
    ['TW', null, null, 'Taiwan'],
    ['SG', null, null, 'Singapore'],
    // Kyiv and Lviv: Ukraine outside the excluded regions.
    ['UA', '30', 'UA-30', 'Ukraine'],
    ['UA', 'UA-46', 'UA-46', 'Ukraine'],
  ])('allows %s (region %s)', (country, regionCode, iso, name) => {
    expect(regionVerdictFor(country, regionCode)).toEqual({ verdict: 'allowed', country, regionCode: iso, name });
  });

  it.each([
    ['43', 'UA-43', 'Crimea'],
    ['40', 'UA-40', 'Sevastopol'],
    ['14', 'UA-14', 'Donetsk'],
    ['65', 'UA-65', 'Kherson'],
    ['09', 'UA-09', 'Luhansk'],
    ['23', 'UA-23', 'Zaporizhzhia'],
  ])('blocks Ukraine’s excluded region %s (%s, %s), however the code is written', (cloudflare, iso, name) => {
    const blocked = { verdict: 'blocked', country: 'UA', regionCode: iso, name };
    expect(regionVerdictFor('UA', cloudflare)).toEqual(blocked);
    expect(regionVerdictFor('UA', iso)).toEqual(blocked);
    expect(regionVerdictFor('ua', ` ${iso.toLowerCase()} `)).toEqual(blocked);
  });

  it.each([null, undefined, '', ' ', 'RU-43', 'UA-1234', 'Kyiv'])(
    'cannot decide Ukraine from region %j: the country alone does not tell Kyiv from Crimea',
    (regionCode) => {
      expect(regionVerdictFor('UA', regionCode)).toEqual({ verdict: 'unknown', country: null, regionCode: null, name: null });
    },
  );

  it.each(['XX', 'T1', '', ' ', null, undefined, 'ZZ', 'EU', 'USA', 'U', '__proto__'])(
    'reads %j as unknown: it names no country',
    (country) => {
      expect(regionVerdictFor(country, '43')).toEqual({ verdict: 'unknown', country: null, regionCode: null, name: null });
    },
  );

  it.each([
    ['PR', 'Puerto Rico'],
    ['GU', 'Guam'],
    ['GL', 'Greenland'],
    ['RE', 'Réunion'],
    ['GI', 'Gibraltar'],
  ])('allows the territory %s (%s) of a listed country', (country, name) => {
    expect(regionVerdictFor(country)).toEqual({ verdict: 'allowed', country, regionCode: null, name });
  });

  it('reports a region only where the list splits a country by region', () => {
    expect(regionVerdictFor('US', 'CA')).toEqual({ verdict: 'allowed', country: 'US', regionCode: null, name: 'United States' });
    expect(regionVerdictFor('RU', '43')).toEqual({ verdict: 'blocked', country: 'RU', regionCode: null, name: 'Russia' });
  });

  it('reads the country without case or surrounding space', () => {
    expect(regionVerdictFor(' sg ')).toEqual({ verdict: 'allowed', country: 'SG', regionCode: null, name: 'Singapore' });
    expect(regionVerdictFor('cn')).toEqual({ verdict: 'blocked', country: 'CN', regionCode: null, name: 'mainland China' });
  });
});

describe('effectiveRegionVerdict', () => {
  const now = new Date('2026-10-31T12:00:00.000Z');
  const HOUR = 60 * 60 * 1000;
  const stored = (verdict: ClaudeRegionDecidedVerdict, decidedMsAgo: number): RunnerRegion => ({
    verdict,
    country: verdict === 'blocked' ? 'CN' : 'SG',
    regionCode: null,
    name: verdict === 'blocked' ? 'mainland China' : 'Singapore',
    viaProxy: false,
    decidedAt: new Date(now.getTime() - decidedMsAgo).toISOString(),
    checkedAt: now.toISOString(),
    blockedChecks: verdict === 'blocked' ? 2 : 0,
  });

  it('carries a decided verdict over for 24 hours', () => {
    expect(CLAUDE_REGION_CARRY_OVER_MS).toBe(24 * HOUR);
  });

  it.each<[string, ClaudeRegionDecidedVerdict, RunnerRegion | null | undefined]>([
    ['no row', 'allowed', null],
    ['no row (absent)', 'allowed', undefined],
    ['allowed', 'allowed', stored('allowed', HOUR)],
    ['allowed long ago', 'allowed', stored('allowed', 30 * HOUR)],
    ['blocked under 24 hours', 'blocked', stored('blocked', 23 * HOUR)],
    ['blocked just now', 'blocked', stored('blocked', 0)],
    ['blocked a millisecond short of 24 hours', 'blocked', stored('blocked', 24 * HOUR - 1)],
    ['blocked exactly 24 hours ago', 'allowed', stored('blocked', 24 * HOUR)],
    ['blocked over 24 hours', 'allowed', stored('blocked', 25 * HOUR)],
  ])('%s → %s', (_, expected, region) => {
    expect(effectiveRegionVerdict(region, now)).toBe(expected);
  });
});

describe('credentialIsAnthropicBound', () => {
  const key = (presetSlug: string | null, baseUrl: string): EngineCredential => ({
    kind: 'key',
    runtime: 'claude',
    presetSlug,
    baseUrl,
    subscriptionToken: false,
  });

  it.each<[string, boolean, AnthropicBoundCredential]>([
    ['own sign-in', true, { kind: 'login', engine: AgentProvider.CLAUDE }],
    ['Anthropic key', true, key('anthropic', 'https://api.anthropic.com')],
    ['Claude pool', true, { kind: 'pool', engine: AgentProvider.CLAUDE }],
    ['DeepSeek key', false, key('deepseek', 'https://api.deepseek.com/anthropic')],
    ['local vLLM key', false, key(null, 'http://127.0.0.1:8000')],
  ])('%s → %s', (_, expected, credential) => {
    expect(credentialIsAnthropicBound(credential)).toBe(expected);
  });

  it.each<[string, boolean, AnthropicBoundCredential]>([
    ['a custom key on api.anthropic.com', true, key(null, 'https://api.anthropic.com/v1')],
    ['a custom key on anthropic.com itself', true, key(null, 'https://anthropic.com')],
    ['a host written in capitals with a trailing dot', true, key(null, 'https://API.Anthropic.COM./')],
    ['a web picker row: preset known, endpoint not', true, { kind: 'key', presetSlug: 'anthropic' }],
    ['a look-alike that ends in another domain', false, key(null, 'https://anthropic.com.example.test')],
    ['a look-alike that only ends in the same letters', false, key(null, 'https://myanthropic.com')],
    ['a Moonshot key', false, key('moonshot', 'https://api.moonshot.ai/anthropic')],
    ['a key whose base URL does not parse', false, key(null, 'not a url')],
    ['a web picker row for another vendor', false, { kind: 'key', presetSlug: 'glm' }],
    ['Codex sign-in', false, { kind: 'login', engine: AgentProvider.CODEX }],
    ['Kimi sign-in', false, { kind: 'login', engine: AgentProvider.KIMI }],
    ['a Codex pool', false, { kind: 'pool', engine: AgentProvider.CODEX }],
    ['OpenCode’s own configuration', false, { kind: 'opencode' }],
  ])('%s → %s', (_, expected, credential) => {
    expect(credentialIsAnthropicBound(credential)).toBe(expected);
  });
});

describe('refusal words', () => {
  it('writes the code, then the sentence', () => {
    expect(claudeRegionRefusedError('HPC', 'mainland China')).toBe(
      'CLAUDE_REGION_UNSUPPORTED: HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.',
    );
    expect(claudeRegionStoppedError('HPC', 'Crimea')).toBe(
      'CLAUDE_REGION_UNSUPPORTED: Claude Code stopped on HPC: its connection to Anthropic is now in Crimea, where Anthropic doesn’t offer Claude.',
    );
    // The shape a client already reads a coded session.error with (RunNeverStartedCard).
    for (const error of [claudeRegionRefusedError('HPC', 'Iran'), claudeRegionStoppedError('HPC', 'Iran')]) {
      expect(/^([A-Z][A-Z_]+): ([\s\S]+)$/.exec(error)?.[1]).toBe(CLAUDE_REGION_UNSUPPORTED);
    }
  });

  it('uses board 04’s copy word for word', () => {
    const board = readFileSync(path.resolve(__dirname, '../../../docs/mocks/claude-region-check/01-board.html'), 'utf8');
    const copy = [...board.matchAll(/<td class="en">([\s\S]*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());
    const sentence = (error: string) => error.slice(`${CLAUDE_REGION_UNSUPPORTED}: `.length);
    // The session card's body is the refusal sentence and its link.
    expect(copy).toContain(`${sentence(claudeRegionRefusedError('{machine}', '{region}'))} Supported regions`);
    expect(copy).toContain(sentence(claudeRegionStoppedError('{machine}', '{region}')));
  });
});
