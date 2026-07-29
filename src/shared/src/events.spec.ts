import { describe, expect, it } from 'vitest';
import { isApiErrorText, isAsyncAgentLaunchAck, isAuthErrorText, toolResultText } from './events';

describe('toolResultText', () => {
  it('passes a plain string through', () => {
    expect(toolResultText('running in background with ID: abc')).toBe(
      'running in background with ID: abc',
    );
  });

  it('flattens an array of text blocks', () => {
    expect(toolResultText([{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }])).toBe(
      'hello world',
    );
  });

  it('is empty for null / non-text content', () => {
    expect(toolResultText(null)).toBe('');
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText([{ type: 'image' }])).toBe('');
  });
});

describe('isAsyncAgentLaunchAck', () => {
  it('flags the async-agent launch acknowledgement (array form)', () => {
    const ack = [
      {
        type: 'text',
        text: 'Async agent launched successfully. (This tool result is internal metadata …) agentId: a56fe4c708d8c5292',
      },
    ];
    expect(isAsyncAgentLaunchAck(ack)).toBe(true);
  });

  it('does not flag a synchronous sub-agent completion report', () => {
    const report = [{ type: 'text', text: 'I now have a complete picture. Here is my research report.' }];
    expect(isAsyncAgentLaunchAck(report)).toBe(false);
  });

  it('does not flag an ordinary tool result', () => {
    expect(isAsyncAgentLaunchAck('/path/to/file.swift')).toBe(false);
    expect(isAsyncAgentLaunchAck(null)).toBe(false);
  });
});

describe('isApiErrorText', () => {
  it('flags an API Error prefix', () => {
    expect(isApiErrorText('API Error: 500')).toBe(true);
    expect(isApiErrorText('   API Error: overloaded')).toBe(true);
  });
  it('ignores normal text', () => {
    expect(isApiErrorText('all good')).toBe(false);
    expect(isApiErrorText(null)).toBe(false);
  });
});

describe('isAuthErrorText', () => {
  it('flags the expired-OAuth text the runtime emits', () => {
    expect(
      isAuthErrorText('Failed to authenticate: OAuth session expired and could not be refreshed'),
    ).toBe(true);
    expect(isAuthErrorText('  Failed to authenticate: invalid API key')).toBe(true);
  });
  it('ignores normal text', () => {
    expect(isAuthErrorText('all good')).toBe(false);
    expect(isAuthErrorText(null)).toBe(false);
  });
  // The two are disjoint: each drives a different UI (bare error line vs sign-in guidance).
  it('does not overlap with isApiErrorText', () => {
    expect(isApiErrorText('Failed to authenticate: OAuth session expired')).toBe(false);
    expect(isAuthErrorText('API Error: 500')).toBe(false);
  });
});
