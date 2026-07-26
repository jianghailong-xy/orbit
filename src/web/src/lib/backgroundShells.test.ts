import { describe, expect, it } from 'vitest';
import type { BgShell } from '@orbit/shared';
import { mergeBackgroundShells } from './backgroundShells';

const shell = (over: Partial<BgShell> = {}): BgShell => ({
  shellId: 'sh1',
  toolUseId: 'tu1',
  command: 'npm run build',
  outputPath: '/tmp/sh1.output',
  startedSeq: 10,
  status: 'running',
  ...over,
});

describe('mergeBackgroundShells', () => {
  it('takes the live row for a running shell', () => {
    const merged = mergeBackgroundShells(
      [shell({ status: 'exited', latestOutput: 'old', latestOutputSeq: 20 })],
      [shell({ status: 'running', latestOutput: 'new', latestOutputSeq: 30 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('running');
    expect(merged[0].latestOutput).toBe('new');
  });

  it('keeps the server snapshot when it is at least as recent — the client copy may be clipped', () => {
    const merged = mergeBackgroundShells(
      [shell({ latestOutput: 'the whole 8KB poll', latestOutputSeq: 30, latestOutputTs: 't-server' })],
      [shell({ status: 'running', latestOutput: 'first 2KB only', latestOutputSeq: 30 })],
    );
    expect(merged[0].status).toBe('running'); // still the live row…
    expect(merged[0].latestOutput).toBe('the whole 8KB poll'); // …but the server's output
    expect(merged[0].latestOutputTs).toBe('t-server');
  });

  it('keeps the live tail once it has advanced past the server snapshot', () => {
    const merged = mergeBackgroundShells(
      [shell({ latestOutput: 'server', latestOutputSeq: 30 })],
      [shell({ status: 'running', latestOutput: 'fresher live tail', latestOutputSeq: 31 })],
    );
    expect(merged[0].latestOutput).toBe('fresher live tail');
  });

  it('leaves the live row alone when the server has no snapshot at all', () => {
    const merged = mergeBackgroundShells(
      [shell({ latestOutput: undefined, latestOutputSeq: undefined })],
      [shell({ status: 'running', latestOutput: 'live only', latestOutputSeq: 5 })],
    );
    expect(merged[0].latestOutput).toBe('live only');
  });

  it('prefers the server row for a shell that already terminated, and keeps single-source rows', () => {
    const merged = mergeBackgroundShells(
      [shell({ shellId: 'done', startedSeq: 1, status: 'exited', latestOutput: 'server' })],
      [
        shell({ shellId: 'done', startedSeq: 1, status: 'exited', latestOutput: 'stale live' }),
        shell({ shellId: 'brand-new', startedSeq: 99, status: 'running' }),
      ],
    );
    expect(merged.map((s) => s.shellId)).toEqual(['done', 'brand-new']);
    expect(merged[0].latestOutput).toBe('server');
  });
});
