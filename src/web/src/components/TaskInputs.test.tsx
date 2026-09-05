// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uploadAttachment = vi.fn(async () => ({ id: 'new-id' }));
const deleteAttachment = vi.fn(async () => {});
// Thumbnails fetch their bytes in an effect; a promise that never settles keeps the image path
// from racing assertions that are about scope and metadata, not about pixels.
const fetchAttachmentObjectUrl = vi.fn(() => new Promise<string>(() => {}));

vi.mock('../api', () => ({
  uploadAttachment: (...a: unknown[]) => uploadAttachment(...(a as [])),
  deleteAttachment: (...a: unknown[]) => deleteAttachment(...(a as [])),
  fetchAttachmentObjectUrl: (...a: unknown[]) => fetchAttachmentObjectUrl(...(a as [])),
}));
const toast = { error: vi.fn(), success: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const { TaskInputs } = await import('./TaskInputs');
type TaskInput = Parameters<typeof TaskInputs>[0]['inputs'][number];

const TASK = '0195c0de-0000-7000-8000-0000000000a1';

const input = (over: Partial<TaskInput> = {}): TaskInput => ({
  id: 'att-1',
  mimeType: 'image/png',
  sizeBytes: 2048,
  fileName: 'login-mock.png',
  createdAt: '2026-09-05T00:00:00.000Z',
  ...over,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  uploadAttachment.mockClear();
  deleteAttachment.mockClear();
  toast.error.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function mount(node: ReactElement): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = () => container.textContent ?? '';

describe('TaskInputs', () => {
  it('lists what every run will be given, with a count and a readable size', async () => {
    await mount(<TaskInputs taskId={TASK} inputs={[
      input(),
      input({ id: 'att-2', fileName: 'spec.pdf', mimeType: 'application/pdf', sizeBytes: 3 * 1024 * 1024 }),
    ]} />);
    expect(text()).toContain('Inputs (2)');
    expect(text()).toContain('login-mock.png');
    expect(text()).toContain('2 KB');
    expect(text()).toContain('spec.pdf');
    expect(text()).toContain('3.0 MB');
  });

  it('says these are copied per run, which is what makes them not a transcript image', async () => {
    await mount(<TaskInputs taskId={TASK} inputs={[]} />);
    expect(text()).toContain('Each run gets its own copy.');
  });

  it('names the task when uploading, so the file becomes an input and not a session blob', async () => {
    await mount(<TaskInputs taskId={TASK} inputs={[]} />);
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'mock.png', { type: 'image/png' });
    Object.defineProperty(picker, 'files', { value: [file] });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(uploadAttachment).toHaveBeenCalled();
    // The third argument is the whole point. Passed as the second (`sessionId`) the blob would be
    // scoped to a conversation — refused by the server for not being one — and the design mock the
    // author attached would never reach a single run.
    expect(uploadAttachment.mock.calls[0][1]).toBeUndefined();
    expect(uploadAttachment.mock.calls[0][2]).toBe(TASK);
  });

  it('falls back to the mime type when an upload carried no filename', async () => {
    await mount(<TaskInputs taskId={TASK} inputs={[input({ fileName: null, mimeType: 'image/webp' })]} />);
    expect(text()).toContain('image/webp');
  });

  it('offers no removal when the task has no inputs', async () => {
    await mount(<TaskInputs taskId={TASK} inputs={[]} />);
    expect(text()).toContain('Inputs (0)');
    expect(container.querySelector('[aria-label="Remove input"]')).toBeNull();
  });
});
