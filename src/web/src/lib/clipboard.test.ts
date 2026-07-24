import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

// vitest runs these in the node environment (no DOM), so fake the bits of <textarea> +
// document that the execCommand fallback touches. `execCommandResult` decides whether the
// legacy path "succeeds".
function stubDom(execCommandResult: boolean) {
  const el = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
  };
  vi.stubGlobal('document', {
    createElement: vi.fn(() => el),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    execCommand: vi.fn(() => execCommandResult),
  });
  return el;
}

afterEach(() => vi.unstubAllGlobals());

describe('copyText', () => {
  it('returns false for empty text without touching the clipboard', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('')).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns true when the async Clipboard API resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  // The reported bug: a rejected write must NOT be reported as success.
  it('does not report success when the clipboard write rejects and the fallback also fails', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    stubDom(false);
    expect(await copyText('hello')).toBe(false);
  });

  // Insecure context (HTTP / bare IP): navigator.clipboard is undefined. Must not falsely succeed.
  it('does not report success when the Clipboard API is unavailable and the fallback fails', async () => {
    vi.stubGlobal('navigator', {});
    stubDom(false);
    expect(await copyText('hello')).toBe(false);
  });

  it('falls back to execCommand when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const el = stubDom(true);
    expect(await copyText('hello')).toBe(true);
    expect(el.value).toBe('hello');
  });
});
