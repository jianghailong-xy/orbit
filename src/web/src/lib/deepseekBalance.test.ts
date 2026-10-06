import { describe, expect, it } from 'vitest';
import type { ProviderBalance } from '@orbit/shared';
import { balanceAgo, balanceSplit, balanceView, formatBalance, hasDeepSeekBalance } from './deepseekBalance';

const key = { hasApiKey: true };

describe('which provider rows show a DeepSeek account balance', () => {
  it('both DeepSeek presets, whatever their endpoint says', () => {
    expect(hasDeepSeekBalance({ ...key, presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(true);
    expect(hasDeepSeekBalance({ ...key, presetSlug: 'deepseek-harness', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(true);
  });

  it('a custom provider only when its endpoint is DeepSeek’s own host', () => {
    expect(hasDeepSeekBalance({ ...key, presetSlug: null, baseUrl: 'https://api.deepseek.com/v1' })).toBe(true);
    expect(hasDeepSeekBalance({ ...key, presetSlug: null, baseUrl: 'https://API.DEEPSEEK.COM/anthropic' })).toBe(true);
    expect(hasDeepSeekBalance({ ...key, presetSlug: null, baseUrl: 'https://deepseek-proxy.example.com/v1' })).toBe(false);
    expect(hasDeepSeekBalance({ ...key, presetSlug: null, baseUrl: 'https://api.deepseek.com.example.com/v1' })).toBe(false);
    expect(hasDeepSeekBalance({ ...key, presetSlug: null, baseUrl: 'api.deepseek.com' })).toBe(false);
  });

  it('never another vendor’s preset, nor a row with no key to ask with', () => {
    expect(hasDeepSeekBalance({ ...key, presetSlug: 'moonshot', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(false);
    expect(hasDeepSeekBalance({ ...key, presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(false);
    expect(hasDeepSeekBalance({ hasApiKey: false, presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(false);
  });
});

describe('what a read comes to on screen', () => {
  const read: ProviderBalance = {
    ok: true,
    balances: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' }],
    isAvailable: true,
    fetchedAt: '2026-10-06T08:00:00.000Z',
    sharedWith: [],
  };

  it('is loading until an answer arrives — never a number', () => {
    expect(balanceView(undefined, null)).toEqual({ kind: 'loading' });
  });

  it('is the read when DeepSeek answered', () => {
    expect(balanceView(read, null)).toEqual({ kind: 'read', balance: read });
  });

  it('is failed, with the reason and when it was tried, when DeepSeek did not', () => {
    const failed: ProviderBalance = {
      ok: false,
      reason: 'KEY_REJECTED',
      message: 'DeepSeek rejected this API key (401 Authentication Fails).',
      fetchedAt: '2026-10-06T08:00:00.000Z',
      sharedWith: [],
    };
    expect(balanceView(failed, null)).toEqual({
      kind: 'failed',
      reason: 'KEY_REJECTED',
      label: 'API key rejected',
      message: 'DeepSeek rejected this API key (401 Authentication Fails).',
      triedAt: '2026-10-06T08:00:00.000Z',
    });
    expect(balanceView({ ...failed, reason: 'NETWORK' }, null)).toMatchObject({ kind: 'failed', label: 'network error' });
    expect(balanceView({ ...failed, reason: 'UPSTREAM_ERROR' }, null)).toMatchObject({ kind: 'failed', label: 'DeepSeek error' });
  });

  it('is failed too when the request never reached the server, and keeps a read it already had', () => {
    expect(balanceView(undefined, new Error('Bad Gateway'))).toEqual({
      kind: 'failed',
      reason: null,
      label: "couldn't load",
      message: 'Bad Gateway',
      triedAt: null,
    });
    expect(balanceView(read, new Error('Bad Gateway'))).toEqual({ kind: 'read', balance: read });
  });
});

describe('amounts, shares and times', () => {
  it('writes DeepSeek’s amounts with their currency’s sign and two decimals', () => {
    expect(formatBalance('110.00', 'CNY')).toBe('¥110.00');
    expect(formatBalance('5', 'USD')).toBe('$5.00');
    expect(formatBalance('0.42', 'CNY')).toBe('¥0.42');
    expect(formatBalance('12345.6', 'CNY')).toBe('¥12,345.60');
    expect(formatBalance('12.30', 'EUR')).toBe('12.30 EUR');
  });

  it('splits a currency’s bar into granted and topped-up shares', () => {
    expect(balanceSplit({ currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' })).toEqual({
      granted: (10 / 110) * 100,
      toppedUp: (100 / 110) * 100,
    });
    expect(balanceSplit({ currency: 'CNY', totalBalance: '0.42', grantedBalance: '0.00', toppedUpBalance: '0.42' })).toEqual({
      granted: 0,
      toppedUp: 100,
    });
    expect(balanceSplit({ currency: 'CNY', totalBalance: '0.00', grantedBalance: '0.00', toppedUpBalance: '0.00' })).toBeNull();
  });

  it('says when the server last asked DeepSeek', () => {
    const now = Date.parse('2026-10-06T08:00:00.000Z');
    expect(balanceAgo('2026-10-06T07:59:30.000Z', now)).toBe('just now');
    expect(balanceAgo('2026-10-06T07:58:00.000Z', now)).toBe('2 min ago');
    expect(balanceAgo('2026-10-06T05:00:00.000Z', now)).toBe('3 h ago');
    expect(balanceAgo('2026-10-04T08:00:00.000Z', now)).toBe('2 d ago');
  });
});
