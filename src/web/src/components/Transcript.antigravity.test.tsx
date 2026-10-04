import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AntigravityRepairCard, antigravityRepair, AuthErrorCtx, type AuthErrorHelp, Transcript } from './Transcript';

const help: AuthErrorHelp = {
  provider: 'antigravity', runtime: 'antigravity', runnerName: 'HPC', runnerVersion: '0.1.208',
  onConnectGemini: () => {}, onSwitchToGemini: () => {}, onOpenProviders: () => {}, onInstall: () => {},
};
const renderError = (message: string, context = help) => renderToStaticMarkup(
  <AuthErrorCtx.Provider value={context}>
    <Transcript events={[{ seq: 1, type: 'error', payload: { message } }]} />
  </AuthErrorCtx.Provider>,
);

describe('Antigravity session remedies', () => {
  it('connects an encrypted Gemini key and offers the same-runtime switch', () => {
    const html = renderError('Failed to authenticate: Antigravity needs GEMINI_API_KEY');
    expect(html).toContain('Antigravity needs a Gemini API key');
    expect(html).toContain('Connect Gemini in Providers. Orbit stores the key encrypted, and this conversation can continue on it.');
    expect(html).toContain('Connect Gemini</button>');
    expect(html).toContain('Switch to Gemini</button>');
    expect(html).not.toContain('environment variables');
    expect(html).not.toContain('GEMINI_API_KEY');
    expect(html).not.toContain('Retry — re-send');
  });

  it('names the runner, current version, required version and idle update for the queue refusal', () => {
    const error = 'Antigravity requires a newer Orbit runner; update this runner first';
    expect(antigravityRepair(error)).toBe('updateRunner');
    const html = renderError(error, { ...help, provider: 'gemini-key' });
    expect(html).toContain('Waiting for a newer runner');
    expect(html).toContain('HPC runs Orbit runner 0.1.208; Antigravity needs 0.1.209 or newer.');
    expect(html).toContain('The runner updates itself when no session is running on it, and this session starts then.');
    expect(html).toContain('Open in Providers</button>');
    expect(html).not.toContain('Install</button>');
  });

  it('keeps an old missing-key error actionable after switching to Gemini without blaming its new key', () => {
    const error = 'Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), and neither this session nor the runner has one. Set it in the workspace environment.';
    expect(antigravityRepair(error)).toBe('needsKey');
    const context = { ...help, provider: 'gemini-key' };
    const html = renderError(error, context);
    expect(html).toContain('Antigravity needs a Gemini API key');
    expect(html).not.toContain('workspace environment');
    expect(html).not.toContain('Provider authentication failed');
    expect(renderError('Failed to authenticate: invalid API key', context)).toContain('Provider authentication failed');
  });

  it('recognizes the actual runner missing-binary message for Gemini and the built-in engine', () => {
    const error = 'Antigravity CLI ("agy") not found on this runner\'s PATH — run `orbit doctor` on the runner to install it and sign in.';
    for (const provider of ['antigravity', 'gemini-key']) {
      const html = renderError(error, { ...help, provider });
      expect(html).toContain('Antigravity CLI isn&#x27;t installed on HPC');
      expect(html).toContain('Install it from Providers, then send your message again.');
      expect(html).toContain('Install</button>');
      expect(html).toContain('Open in Providers</button>');
      expect(html).not.toContain('orbit doctor');
    }
    expect(renderError('API Error: bad input')).toContain('chat-error');
    expect(antigravityRepair('Codex CLI ("codex") not found')).toBeNull();
  });

  it('keeps the raw diagnosis on a shared transcript without repair context', () => {
    const html = renderToStaticMarkup(<Transcript events={[{ seq: 1, type: 'error', payload: { message: 'Antigravity CLI ("agy") not found' } }]} />);
    expect(html).toContain('chat-error');
    expect(html).not.toContain('Open in Providers');
  });

  it('runs the connect, switch, install and provider actions and disables an unavailable switch', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.getElementById('root')!);
    const connect = vi.fn(), switchProvider = vi.fn(), install = vi.fn(), providers = vi.fn();
    const context = { ...help, onConnectGemini: connect, onSwitchToGemini: switchProvider, onInstall: install, onOpenProviders: providers };
    try {
      await act(async () => { root.render(<AntigravityRepairCard repair="needsKey" help={context} />); });
      for (const button of document.querySelectorAll<HTMLButtonElement>('button')) await act(async () => button.click());
      expect(connect).toHaveBeenCalledOnce();
      expect(switchProvider).toHaveBeenCalledOnce();
      await act(async () => { root.render(<AntigravityRepairCard repair="notInstalled" help={context} />); });
      for (const button of document.querySelectorAll<HTMLButtonElement>('button')) await act(async () => button.click());
      expect(install).toHaveBeenCalledOnce();
      expect(providers).toHaveBeenCalledOnce();
      await act(async () => { root.render(<AntigravityRepairCard repair="needsKey" help={{ ...context, onSwitchToGemini: undefined }} />); });
      expect([...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Switch to Gemini')?.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });
});
