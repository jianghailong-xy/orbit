// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoordinatorQuestionCard,
  questionAttachments,
  type ProjectOpenItemRow,
} from './CoordinatorQuestionCard';
import { AttachmentResolverContext } from '../lib/attachmentResolver';

/**
 * The pictures a coordinator attaches to a question. `file_upload` answers an `orbit-attachment:`
 * link to put in a reply, and a question is often a choice between the mocks those links carry —
 * the ids alone say nothing to the person answering.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT_ID = '34ODoUKJGEsfbgcJDGS4q';
const ITEM_ID = '4BLRNxGq7TOI1lIiOh4g1j';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');

const A = '354FYvqAYfCe18PmyjskL';
const B = '354FYxERKqRJdsLqG6U5c';

const ASKED = [
  'Which layout should the Plan usage popover use?',
  '',
  '- Option A:',
  `\n![Option A — three accounts](orbit-attachment:${A})`,
  '',
  '- Option B:',
  `\n![Option B — compact rows](orbit-attachment:${B} "option-b.png")`,
  '',
  'In both options, an account with 0 credits shows no card.',
].join('\n');

function row(question = ASKED): ProjectOpenItemRow {
  return {
    itemId: ITEM_ID,
    kind: 'COORDINATOR_QUESTION',
    title: 'Coordinator asks: which layout?',
    detailLine: 'Blocks 1 task · If you don’t answer: the task stays blocked',
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    escalateAt: null,
    escalatedAt: null,
    taskId: null,
    sessionId: null,
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [],
    facts: null,
    waitingSince: new Date(NOW - 44 * 1000).toISOString(),
    question: {
      question,
      options: [
        { label: 'Option A', description: 'Keeps the iOS stacking' },
        { label: 'Option B', description: 'A shorter popover' },
      ],
      recommendedOption: 0,
      blocksTaskIds: [],
      ifUnanswered: 'the task stays blocked',
    },
  };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function markup(ui: JSX.Element): string {
  return renderToStaticMarkup(<QueryClientProvider client={client()}>{ui}</QueryClientProvider>);
}

describe('questionAttachments', () => {
  it('takes the pictures out of the words, in the order they were written', () => {
    const { text, images } = questionAttachments(ASKED);
    expect(images).toEqual([
      { id: A, alt: 'Option A — three accounts' },
      { id: B, alt: 'Option B — compact rows' },
    ]);
    expect(text).not.toContain('orbit-attachment:');
    expect(text).not.toContain('![');
    expect(text).toContain('- Option A:');
    expect(text).toContain('In both options, an account with 0 credits shows no card.');
  });

  it('reads the pictures from the question as asked, whatever the translation did to the words', () => {
    // What a translated card carries when the Markdown was flattened: the id became prose.
    const shown = `哪种布局？\n\n- 选项 A: orbit-attachment:${A}\n- 选项 B: orbit-attachment:${B}\n\n两者都不显示额度为 0 的账号。`;
    const { text, images } = questionAttachments(ASKED, shown);
    expect(images.map((image) => image.id)).toEqual([A, B]);
    expect(text).toContain('选项 A:');
    expect(text).toContain('额度为 0');
    expect(text).not.toContain('orbit-attachment:');
  });

  it('leaves an id alone when the question never drew it as a picture', () => {
    const { text, images } = questionAttachments(`see orbit-attachment:${A} for the mock`);
    expect(images).toEqual([]);
    expect(text).toContain(`orbit-attachment:${A}`);
  });

  it('drops a list item the picture was the whole of', () => {
    const { text } = questionAttachments(`first\n\n- ![the mock](orbit-attachment:${A})\n\nlast`);
    expect(text).toBe('first\n\nlast');
  });
});

describe('the card with pictures', () => {
  it('draws them as tiles under the words, not as ids in them', () => {
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);
    expect(html).toContain('coordinator-question-images');
    expect(html).not.toContain('is-single');
    expect(html).toContain('2 images · tap any to open it full size');
    expect(html).not.toContain('orbit-attachment:');
    expect(html).not.toContain('![');
    expect(html).toContain('<p>Option A:</p>');
  });

  it('draws a lone picture full width', () => {
    const one = `Which one?\n\n![the only mock](orbit-attachment:${A})`;
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row(one)} now={NOW} />);
    expect(html).toContain('coordinator-question-images is-single');
    expect(html).toContain('1 image · tap to open it full size');
  });

  it('says nothing about pictures when the question has none', () => {
    const plain = row('Which one starts first?');
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={plain} now={NOW} />);
    expect(html).not.toContain('coordinator-question-images');
  });
});

describe('the pictures themselves', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function draw(resolve: (id: string) => Promise<string>) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client()}>
          <AttachmentResolverContext.Provider value={resolve}>
            <CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />
          </AttachmentResolverContext.Provider>
        </QueryClientProvider>,
      );
    });
  }

  async function until(held: () => boolean, what: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (held()) return;
      if (Date.now() >= deadline) throw new Error(`never became true within 10000ms: ${what}`);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it('fetches each one by its attachment id and opens the viewer from the tile', async () => {
    const asked: string[] = [];
    await draw((id) => {
      asked.push(id);
      return Promise.resolve(`blob:${id}`);
    });
    await until(() => host.querySelectorAll('.coordinator-question-images img').length === 2, 'both pictures');
    const images = [...host.querySelectorAll<HTMLImageElement>('.coordinator-question-images img')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual([`blob:${A}`, `blob:${B}`]);
    expect(images.map((image) => image.getAttribute('alt'))).toEqual([
      'Option A — three accounts',
      'Option B — compact rows',
    ]);
    expect(asked).toEqual([A, B]);
    // Each tile is the viewer's own button, named by the picture.
    expect(
      [...host.querySelectorAll('.coordinator-question-images [role="button"]')].map((tile) =>
        tile.getAttribute('aria-label'),
      ),
    ).toEqual(['Option A — three accounts', 'Option B — compact rows']);
  });

  it('keeps a chip saying what the picture was when its bytes cannot be read', async () => {
    await draw(() => Promise.reject(new Error('gone')));
    await until(() => host.querySelector('.md-image-unavailable') !== null, 'the unavailable chip');
    expect(host.querySelector('.md-image-unavailable')?.textContent).toContain('Option A — three accounts');
  });
});
