// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { currentProviderChoice, providerChoices } from '../lib/sessionProviderChoices';
import { RunnerEngines } from './RunnerEngines';
import { RunnerEnginesSection } from './RunnerEnginesSection';
import { probeReportsSignedIn } from './RunnerSignIn';
import { AuthErrorCtx, Transcript } from './Transcript';
import type { Runner } from './TasksSidePanel';

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const fixtures = JSON.parse(readFileSync('../../docs/evidence/antigravity-google-login/clients/fixtures.json', 'utf8')) as Record<string, Runner>;

function wrap(child: React.ReactNode, runner: Runner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['runners'], [runner]);
  return <QueryClientProvider client={client}><MemoryRouter>{child}</MemoryRouter></QueryClientProvider>;
}

describe('Antigravity Google login across client surfaces', () => {
  beforeEach(() => {
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([fixtures.google.id]));
    vi.mocked(api).mockResolvedValue({ status: null });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

  function row(state: string) {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(wrap(<RunnerEngines />, fixtures[state]));
    return container.querySelector('[data-engine="antigravity"]')!;
  }

  it('offers Google sign-in with a linked terms warning when signed out', () => {
    const rendered = row('signed-out');
    expect(rendered.textContent).toContain('Signed out');
    expect(rendered.textContent).toContain('Sign in with Google');
    expect(rendered.textContent).toContain('personal account sign-in through third-party tools; your account may be suspended.');
    expect(rendered.querySelector('a')?.getAttribute('href')).toBe('https://antigravity.google/terms');
  });

  it('shows Google identity, each remaining quota and reset, and re-login', () => {
    const rendered = row('google');
    expect(rendered.textContent).toContain('Google account');
    expect(rendered.textContent).toContain('Weekly72% remaining');
    expect(rendered.textContent).toContain('5-hour18% remaining');
    expect(rendered.querySelectorAll('.re-reset')).toHaveLength(2);
    expect(rendered.querySelector('[aria-label="Re-sign in"]')).not.toBeNull();
    const summary = renderToStaticMarkup(wrap(<RunnerEnginesSection runner={fixtures.google} />, fixtures.google));
    expect(summary).toContain('Google account');
    expect(summary).toContain('72% remaining');
    expect(summary).toContain('resets');
  });

  it.each([['macos', 'not supported on macOS runners yet'], ['old', 'Update this runner']])('gates %s runners without offering Google sign-in', (state, hint) => {
    const rendered = row(state);
    expect(rendered.textContent).toContain(hint);
    expect(rendered.textContent).not.toContain('Sign in with Google');
  });

  it('keeps the env-key explanation and never treats unknown as signed in', () => {
    expect(row('env-key').textContent).toContain('env key · runs on your Gemini key');
    const unknown = row('unknown');
    expect(unknown.textContent).toContain('Unknown');
    expect(unknown.querySelector('[aria-label="Re-sign in"]')).toBeNull();
    expect(unknown.textContent).not.toContain('remaining');
    expect(probeReportsSignedIn([fixtures['env-key']], fixtures.google.id, 'antigravity')).toBe(false);
    expect(probeReportsSignedIn([fixtures.google], fixtures.google.id, 'antigravity')).toBe(true);
  });

  it('shows zero remaining as spent, preserves buckets and suppresses signed-out quota', () => {
    const r = structuredClone(fixtures.google);
    r.engines![0].planUsage!.buckets![0].remainingFraction = 0;
    const html = renderToStaticMarkup(wrap(<RunnerEngines />, r));
    expect(html).toContain('0% remaining');
    expect(html).toContain('Spent');
    r.engines![0].auth = 'no';
    expect(renderToStaticMarkup(wrap(<RunnerEngines />, r))).not.toContain('% remaining');
  });

  it('offers the Google account in the selector and blocks a lapsed login while Gemini keys still work', () => {
    const choices = (r: Runner) => providerChoices([{ slug: 'gemini-key', label: 'Gemini', runtime: 'antigravity', presetSlug: 'gemini', models: [] }], undefined, undefined, r.engines, [], undefined, r.antigravity);
    expect(choices(fixtures.google).find(c => c.slug === 'antigravity')).toMatchObject({ kind: 'engine', labelDetail: 'Google account' });
    expect(choices(fixtures.expired).find(c => c.slug === 'antigravity')).toMatchObject({ unavailable: 'Not signed in', fixEngine: 'antigravity' });
    expect(choices(fixtures.expired).find(c => c.slug === 'gemini-key')?.unavailable).toBeUndefined();
    const signedOut = structuredClone(fixtures.google);
    signedOut.engines![0].auth = 'no';
    expect(choices(signedOut).find(c => c.slug === 'antigravity')?.unavailable).toBe('Not signed in');
    expect(choices(fixtures['env-key']).find(c => c.slug === 'antigravity')?.labelDetail).toBe('env key');
    expect(currentProviderChoice('antigravity', [], undefined, [], undefined, fixtures.expired.antigravity).unavailable).toBe('Not signed in');
  });

  it('puts the Google sign-in button and warning on an unauthenticated transcript card', () => {
    const html = renderToStaticMarkup(wrap(<AuthErrorCtx.Provider value={{ provider: 'antigravity', runnerId: fixtures.google.id, googleLogin: 'available' }}>
      <Transcript events={[{ seq: 1, type: 'error', payload: { message: 'Failed to authenticate: Antigravity is not signed in — sign in with Google.' } }]} />
    </AuthErrorCtx.Provider>, fixtures['signed-out']));
    expect(html).toContain('Antigravity needs authentication');
    expect(html).toContain('Sign in with Google');
    expect(html).toContain('https://antigravity.google/terms');
    expect(html).not.toContain('Antigravity needs a Gemini API key');
  });

  it.each(['signed-out', 'google'])('submits the pasted Google authorization code from the %s row', async (state) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const popup = { document: { write: vi.fn(), close: vi.fn() }, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    vi.mocked(api).mockImplementation(async (path, options) => (path.endsWith('/login') || path.endsWith('/login/code')) && options?.method === 'POST'
      ? { status: 'awaiting_code', engine: 'antigravity', url: 'https://example.test/authorize' } : { status: null });
    try {
      await act(async () => { root.render(wrap(<RunnerEngines />, fixtures[state])); });
      await act(async () => container.querySelector<HTMLButtonElement>('[data-engine="antigravity"] .re-act button')!.click());
      await act(async () => container.querySelector<HTMLButtonElement>('.rsi-btn')!.click());
      await vi.waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(`/runners/${fixtures.google.id}/login`, { method: 'POST', body: { engine: 'antigravity' } }));
      await vi.waitFor(() => expect(container.querySelector('.rsi-input')).not.toBeNull());
      expect(popup.location.replace).toHaveBeenCalledWith('https://example.test/authorize');
      const input = container.querySelector<HTMLInputElement>('.rsi-input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'google-authorization-code');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => container.querySelector<HTMLButtonElement>('.rsi-form .rsi-btn')!.click());
      await vi.waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(`/runners/${fixtures.google.id}/login/code`, { method: 'POST', body: { code: 'google-authorization-code' } }));
      await vi.waitFor(() => expect(container.textContent).toContain('Signing in with your code…'));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
