import { claudeRegionRefusedError, claudeRegionStoppedError, CLAUDE_REGION_UNSUPPORTED, CLAUDE_REGIONS_SOURCE_URL } from '@orbit/shared';
import { describe, expect, it } from 'vitest';
import {
  claudeRegionBlocked,
  claudeRegionErrorLine,
  claudeRegionHeld,
  claudeRegionHeldWords,
  isClaudeRegionError,
} from './claudeRegion';
import {
  CLAUDE_REGION_SUPPORTED_REGIONS_URL,
  claudeRegionChecked,
  claudeRegionConnectionIsIn,
  claudeRegionSubject,
} from './claudeRegionCopy';

/**
 * What the web reads of the Claude region check (docs/claude-region-check-contract.md): the runner's
 * verdict from `runner.region`, and a held session from the code its error starts with.
 */

const REFUSAL = claudeRegionRefusedError('HPC', 'mainland China');
const STOPPED = claudeRegionStoppedError('HPC', 'mainland China');
const REGION = { country: 'CN', regionCode: null, name: 'mainland China', viaProxy: false, checkedAt: '2026-10-31T11:58:00.000Z' };

describe('the runner verdict', () => {
  it('is blocked only where runner.region says blocked', () => {
    expect(claudeRegionBlocked({ region: { ...REGION, verdict: 'blocked' } })).toBe(true);
    expect(claudeRegionBlocked({ region: { ...REGION, verdict: 'allowed' } })).toBe(false);
    // A runner that does not check, one no check has decided yet, an older control plane.
    expect(claudeRegionBlocked({ region: null })).toBe(false);
    expect(claudeRegionBlocked({})).toBe(false);
    expect(claudeRegionBlocked(null)).toBe(false);
  });
});

describe('a region refusal in an error', () => {
  it('is recognised by its code alone', () => {
    expect(isClaudeRegionError(REFUSAL)).toBe(true);
    expect(isClaudeRegionError(STOPPED)).toBe(true);
    expect(isClaudeRegionError(`  ${REFUSAL}\n`)).toBe(true);
    expect(isClaudeRegionError('runner offline')).toBe(false);
    expect(isClaudeRegionError(`${CLAUDE_REGION_UNSUPPORTED}`)).toBe(false);
    expect(isClaudeRegionError(null)).toBe(false);
  });

  it('draws no transcript line for a refusal, and a stopped turn’s sentence without its code', () => {
    expect(claudeRegionErrorLine(REFUSAL)).toBeNull();
    expect(claudeRegionErrorLine(STOPPED)).toBe(
      'Claude Code stopped on HPC: its connection to Anthropic is now in mainland China, where Anthropic doesn’t offer Claude.',
    );
    // A runner whose name is the stopped sentence's words still reads as a refusal.
    expect(claudeRegionErrorLine(claudeRegionRefusedError('Claude Code stopped on x', 'Russia'))).toBeNull();
    expect(claudeRegionErrorLine('Claude Code needs authentication')).toBeUndefined();
  });
});

describe('a held session', () => {
  it('is one in the queue whose error is a region refusal', () => {
    expect(claudeRegionHeld({ runState: 'QUEUED', error: REFUSAL })).toBe(true);
    // Queued again after a stop, its next turn waits under the same hold.
    expect(claudeRegionHeld({ runState: 'QUEUED', error: STOPPED })).toBe(true);
    expect(claudeRegionHeld({ status: 'PENDING', error: REFUSAL })).toBe(true);
    // A control plane that predates the hold failed the run: that is not a hold.
    expect(claudeRegionHeld({ runState: 'FAILED', error: REFUSAL })).toBe(false);
    // The stopped turn itself has ended.
    expect(claudeRegionHeld({ runState: 'AWAITING_INPUT', error: STOPPED })).toBe(false);
    expect(claudeRegionHeld({ runState: 'QUEUED', error: 'runner offline' })).toBe(false);
    expect(claudeRegionHeld({ runState: 'QUEUED', error: null })).toBe(false);
    expect(claudeRegionHeld(null)).toBe(false);
  });

  it('reads Anthropic unavailable on its machine, where the machine is known', () => {
    expect(claudeRegionHeldWords({ runState: 'QUEUED', error: REFUSAL }, 'HPC')).toBe('Anthropic unavailable on HPC');
    expect(claudeRegionHeldWords({ runState: 'QUEUED', error: REFUSAL }, null)).toBeNull();
    expect(claudeRegionHeldWords({ runState: 'QUEUED', error: null }, 'HPC')).toBeNull();
  });
});

describe('the copy', () => {
  it('says the refusal sentence behind its code, from the shared writer', () => {
    expect(claudeRegionConnectionIsIn('HPC', 'mainland China')).toBe(
      'HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.',
    );
    expect(`${CLAUDE_REGION_UNSUPPORTED}: ${claudeRegionConnectionIsIn('HPC', 'mainland China')}`).toBe(REFUSAL);
  });

  it('names the code, the place and the connection as board 04 does', () => {
    expect(claudeRegionSubject('CN')).toBe('CLAUDE_REGION_UNSUPPORTED · CN');
    expect(claudeRegionSubject(null)).toBe('CLAUDE_REGION_UNSUPPORTED');
    expect(claudeRegionChecked('19:58', 'mainland China', false)).toBe(
      'Checked 19:58 · Claude’s connection: mainland China (no proxy)',
    );
    expect(claudeRegionChecked('2m ago', 'Russia', true)).toBe('Checked 2m ago · Claude’s connection: Russia (through a proxy)');
    expect(CLAUDE_REGION_SUPPORTED_REGIONS_URL).toBe(CLAUDE_REGIONS_SOURCE_URL);
  });
});
