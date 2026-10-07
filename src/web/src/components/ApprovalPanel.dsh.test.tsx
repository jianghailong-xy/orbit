import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApprovalInfo } from '../api';
import { approvalRememberOffered } from '../lib/dshRuntime';
import { ApprovalPanel } from './ApprovalPanel';

// A file-sandbox escalation as DeepSeek Harness's approval bridge files it (P4): one write.
const write: ApprovalInfo = {
  id: 'ap1',
  sessionId: 's1',
  toolName: 'write_file',
  toolUseId: 'c2',
  status: 'PENDING',
  createdAt: '2026-10-06T00:00:00.000Z',
  input: { path: 'NOTES.md', content: '# Notes\n' },
};
const render = (rememberable?: boolean) =>
  renderToStaticMarkup(<ApprovalPanel approval={write} onDecide={() => {}} {...(rememberable === undefined ? {} : { rememberable })} />);

describe('approval card remember on DeepSeek Harness', () => {
  it('offers remember on every runtime but Harness, whose bridge answers once', () => {
    expect(approvalRememberOffered('dsh')).toBe(false);
    for (const runtime of ['claude', 'codex', 'kimi', 'opencode', 'antigravity']) {
      expect(approvalRememberOffered(runtime)).toBe(true);
    }
  });

  it('draws Approve and Reject only for a Harness session', () => {
    const html = render(false);
    expect(html).toContain('Approve');
    expect(html).toContain('Reject');
    expect(html).not.toContain('Always allow');
  });

  it('keeps Always allow for the other runtimes (the default)', () => {
    expect(render()).toContain('Always allow');
    expect(render(true)).toContain('Always allow');
  });
});
