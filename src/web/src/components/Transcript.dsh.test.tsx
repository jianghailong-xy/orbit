import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthErrorCtx, type AuthErrorHelp, Transcript } from './Transcript';

// What WorkspaceView hands a Harness session's transcript: its engine, and the DeepSeek key it runs on.
const help: AuthErrorHelp = {
  provider: 'deepseek-2',
  keyName: 'the DeepSeek key “DeepSeek 2”',
  runtime: 'dsh',
  runnerName: 'HPC',
  runnerVersion: '0.1.209',
  onEditDshKey: () => {},
  onInstallDsh: () => {},
  onRetry: () => {},
  retryText: 'fix the bug',
};
const render = (events: unknown[], context: AuthErrorHelp | null = help) =>
  renderToStaticMarkup(
    <AuthErrorCtx.Provider value={context}>
      <Transcript events={events as never} />
    </AuthErrorCtx.Provider>,
  );

describe('DeepSeek Harness transcript', () => {
  it('renders blocks as they arrived: thinking, text, a tool and its result, then the reply', () => {
    // The runner's dshEventMapper output: one event per committed ACP block, never a token stream.
    const html = render([
      { seq: 1, type: 'user', turnId: 't1', payload: { text: 'list the repo' } },
      { seq: 2, type: 'thinking', turnId: 't1', payload: { text: 'I should run ls first.', messageId: 'm1' } },
      { seq: 3, type: 'assistant', turnId: 't1', payload: { text: 'Listing the files.', messageId: 'm2' } },
      {
        seq: 4,
        type: 'tool_use',
        turnId: 't1',
        payload: { id: 'call-1', toolCallId: 'call-1', name: 'bash', input: { command: 'ls' }, kind: 'execute', status: 'pending' },
      },
      {
        seq: 5,
        type: 'tool_result',
        turnId: 't1',
        payload: { toolUseId: 'call-1', toolCallId: 'call-1', status: 'completed', content: 'README.md\nsrc', isError: false },
      },
      { seq: 6, type: 'assistant', turnId: 't1', payload: { text: 'Two entries: README.md and src.', messageId: 'm3' } },
    ]);
    expect(html).toContain('list the repo');
    expect(html).toContain('Listing the files.');
    expect(html).toContain('Two entries: README.md and src.');
    expect(html.indexOf('Listing the files.')).toBeLessThan(html.indexOf('Two entries'));
    expect(html).toContain('ls');
  });

  it('turns a missing or rejected key into a fix on the key, with the retry — and calls it a DeepSeek key (board 8)', () => {
    const missing = render([
      { seq: 1, type: 'error', payload: { message: 'DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key for this session; runner and workspace .env credentials are not used' } },
    ]);
    expect(missing).toContain('data-dsh-repair="needsKey"');
    expect(missing).toContain('DeepSeek Harness needs a DeepSeek key');
    expect(missing).toContain(
      'This session has no DeepSeek key to run on. Add or re-enable a DeepSeek key in Infrastructure, then send your message again.',
    );
    expect(missing).not.toContain('DeepSeek Harness key');
    expect(missing).toContain('Update the API key</button>');
    expect(missing).toContain('Retry — re-send my last message</button>');

    const invalid = render([{ seq: 1, type: 'error', payload: { message: 'dsh session/prompt (-32603): Invalid API key' } }]);
    expect(invalid).toContain('DeepSeek rejected this API key');
    // Which of the DeepSeek keys, by its own name; and no longer the claim that connecting checks nothing.
    expect(invalid).toContain('Update the DeepSeek key “DeepSeek 2” in Infrastructure, then send your message again.');
    expect(invalid).not.toContain('Connecting a key does not check it');
    expect(invalid).toContain('Update the API key</button>');

    // A key that is gone has no name to give.
    const unnamed = render([{ seq: 1, type: 'error', payload: { message: 'dsh session/prompt (-32603): Invalid API key' } }], { ...help, keyName: undefined });
    expect(unnamed).toContain('Update the DeepSeek key in Infrastructure, then send your message again.');
  });

  it('names the machine for an old runner, a missing CLI and an unsupported platform', () => {
    const old = render([
      { seq: 1, type: 'error', payload: { message: 'DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first' } },
    ]);
    expect(old).toContain('Waiting for a newer runner');
    expect(old).toContain('HPC runs Orbit runner 0.1.209');
    expect(old).not.toContain('</button>');

    const missing = render([{ seq: 1, type: 'error', payload: { message: 'DSH_NOT_INSTALLED: DeepSeek Harness 0.2.0-rc.2 is not installed in Orbit&#x27;s version directory' } }]);
    expect(missing).toContain('DeepSeek Harness isn&#x27;t installed on HPC');
    expect(missing).toContain('Install</button>');

    const platform = render([{ seq: 1, type: 'error', payload: { message: 'DSH_PLATFORM_UNSUPPORTED: darwin/arm64' } }]);
    expect(platform).toContain('DeepSeek Harness can&#x27;t run on HPC');
    expect(platform).toContain('Linux x64 runners with Node 26 only');
  });

  it('leaves other runtimes and context-free views to the plain error line', () => {
    const message = 'DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key for this session';
    expect(render([{ seq: 1, type: 'error', payload: { message } }], { ...help, runtime: 'claude' })).not.toContain('data-dsh-repair');
    expect(render([{ seq: 1, type: 'error', payload: { message } }], null)).not.toContain('data-dsh-repair');
  });
});
