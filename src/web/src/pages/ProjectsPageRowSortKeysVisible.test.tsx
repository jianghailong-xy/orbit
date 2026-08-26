import { writeFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ProjectsPage } from './ProjectsPage';

/**
 * ACCEPTANCE — assertion 6: the value a section sorts on must be ON the row it sorts.
 *
 * Needs attention is ordered by the reason chip and task activity. Running, Ready and Waiting use
 * task activity; Needs definition uses the visible title. If those values are absent, the order
 * the header promises is indistinguishable from no order at all.
 *
 * Renders the same 2026-08-23 production snapshot as ProjectsPageProductionSnapshot.test.tsx and
 * reads the rows off the markup. Nothing here imports projectAttention; it reads only what the
 * page draws.
 */

vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

/** The 2026-08-23 production snapshot, verbatim (see ProjectsPageProductionSnapshot.test.tsx). */
const SNAPSHOT = [
  { id: '01a02d83-7c58-708c-8d7c-103d15523d70', title: 'FineWeb × Common Crawl → RocksDB 语料库', status: 'OPEN', running: 0, ready: 6118, blocked: 17324, done: 0, cancelled: 0, tasks: 23442, lastActivityAt: '2026-08-23T15:11:35.859Z' },
  { id: '01a02787-b031-7116-8525-bf9ffe87aeb2', title: 'Runner 多用户免 root:hostd 机器壳 + 每用户 runner', status: 'OPEN', running: 0, ready: 4, blocked: 3, done: 19, cancelled: 0, tasks: 26, lastActivityAt: '2026-08-23T16:05:04.912Z' },
  { id: '01a026c6-2ed9-7102-9ab5-c5da3070c899', title: 'Session 列表重设计：注意力收件箱 + 项目上卷', status: 'OPEN', running: 0, ready: 0, blocked: 0, done: 12, cancelled: 0, tasks: 12, lastActivityAt: '2026-08-22T01:48:02.685Z' },
  { id: '01a02683-b415-7003-96d4-157636e3c26b', title: 'Session 状态模型正交化与兼容收敛', status: 'OPEN', running: 0, ready: 2, blocked: 14, done: 8, cancelled: 0, tasks: 24, lastActivityAt: '2026-08-23T17:56:53.866Z' },
  { id: '01a024e7-71ec-7d42-a0a3-dd4dd1cb7111', title: 'iOS 客户端性能与内存优化', status: 'OPEN', running: 0, ready: 9, blocked: 1, done: 1, cancelled: 1, tasks: 12, lastActivityAt: '2026-08-21T17:20:21.286Z' },
  { id: '01a02405-bdd1-7741-8f5c-67515bcc3ec8', title: 'Project 公平调度域改造', status: 'OPEN', running: 1, ready: 1, blocked: 9, done: 5, cancelled: 0, tasks: 16, lastActivityAt: '2026-08-21T16:04:25.546Z' },
  { id: '01a02344-a4c7-76f0-8ae7-c98341f36db5', title: 'Orbit Agent Contract 与渐进式使用指南', status: 'OPEN', running: 0, ready: 1, blocked: 8, done: 0, cancelled: 0, tasks: 9, lastActivityAt: '2026-08-21T07:43:17.268Z' },
  { id: '01a01d36-eb94-7620-b5ef-625d986cdeb8', title: 'Linux From Scratch：Docker 构建与 QEMU 启动', status: 'OPEN', running: 1, ready: 0, blocked: 117, done: 0, cancelled: 0, tasks: 118, lastActivityAt: '2026-08-23T18:48:17.244Z' },
  { id: '01a01ab8-c9cc-71d3-88b6-01dadc00969c', title: 'Orbit 成熟开源项目品牌化建设', status: 'OPEN', running: 1, ready: 3, blocked: 10, done: 2, cancelled: 0, tasks: 16, lastActivityAt: '2026-08-20T15:58:14.024Z' },
  { id: '01a017b6-5a3e-7fb0-b21a-3ad88a8dbcc3', title: 'Project Coordinator 持续推进控制环', status: 'OPEN', running: 0, ready: 6, blocked: 9, done: 92, cancelled: 3, tasks: 110, lastActivityAt: '2026-08-23T14:29:18.129Z' },
  { id: '01a01785-1ea6-73d3-8ff2-f28d08b1da89', title: 'Project 多 Agent 协作与 Agent 级 Provider 调度', status: 'OPEN', running: 0, ready: 1, blocked: 24, done: 23, cancelled: 0, tasks: 48, lastActivityAt: '2026-08-21T18:52:34.353Z' },
  { id: '01a01520-b6f6-7250-88b9-cfbac53aff8a', title: 'Orbit iOS Project 支持', status: 'OPEN', running: 0, ready: 4, blocked: 30, done: 5, cancelled: 0, tasks: 39, lastActivityAt: '2026-08-19T15:15:03.687Z' },
] as const;

const byTitle = new Map(SNAPSHOT.map((p) => [p.title, p]));
const SNAPSHOT_AT = Date.parse('2026-08-23T18:55:05.000Z');

function render(): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(
    ['projects', 'ALL'],
    SNAPSHOT.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      goal: null,
      createdAt: p.lastActivityAt,
      updatedAt: p.lastActivityAt,
      _count: { tasks: p.tasks },
      buckets: {
        running: p.running, ready: p.ready, blocked: p.blocked,
        done: p.done, cancelled: p.cancelled,
      },
      lastActivityAt: p.lastActivityAt,
    })),
  );
  const clock = vi.spyOn(Date, 'now').mockReturnValue(SNAPSHOT_AT);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  } finally {
    clock.mockRestore();
  }
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&middot;|&#183;/g, '·')
    .replace(/\s+/g, ' ')
    .trim();

/** The whole `<li>` block of one row, tags stripped — the row as a reader reads it. */
function rowTextOf(html: string, title: string): string {
  const li = [...html.matchAll(/<li [\s\S]*?<\/li>/g)]
    .map((m) => m[0])
    .find((block) => block.includes(title));
  if (!li) throw new Error(`no rendered row for "${title}"`);
  return decode(li);
}

const html = render();

describe('projects index — the sort keys are on the rows they sort', () => {
  it('shows the reason on every Needs attention row', () => {
    const expected = new Map<string, string>([
      ['Orbit 成熟开源项目品牌化建设', 'Running · no activity 3d'],
      ['Project 公平调度域改造', 'Running · no activity 2d'],
      ['Orbit iOS Project 支持', 'Ready · no activity 4d'],
      ['Orbit Agent Contract 与渐进式使用指南', 'Ready · no activity 2d'],
      ['iOS 客户端性能与内存优化', 'Ready · no activity 2d'],
      ['Project 多 Agent 协作与 Agent 级 Provider 调度', 'Ready · no activity 2d'],
      ['Session 列表重设计：注意力收件箱 + 项目上卷', '12/12 settled · still open'],
    ]);
    for (const [title, reason] of expected) {
      expect(rowTextOf(html, title)).toContain(reason);
    }
  });

  it('shows each row\'s last activity — the value every header\'s tie-break and order uses', () => {
    for (const p of SNAPSHOT) {
      const row = rowTextOf(html, p.title);
      // The instant itself (ISO) or an age derived from it — either makes the order checkable.
      const hasInstant = row.includes(p.lastActivityAt);
      const hasAge = /\d+[smhd] ago/i.test(row);
      expect(
        hasInstant || hasAge,
        `row of "${p.title}" must carry its last activity (${p.lastActivityAt}); rendered: "${row}"`,
      ).toBe(true);
    }
  });

  it('dumps the rendered rows to /tmp so the report can cite them', () => {
    const sections = [...html.matchAll(/data-section="([^"]+)"/g)];
    const lines: string[] = [];
    for (const [i, m] of sections.entries()) {
      const start = m.index;
      const end = i + 1 < sections.length ? sections[i + 1].index : html.length;
      const block = html.slice(start, end);
      const title = decode(/<h3[^>]*>([^]*?)<\/h3>/.exec(block)?.[1] ?? '');
      const note = decode([...block.matchAll(/<span[^>]*>([^]*?)<\/span>/g)].map((s) => s[1])[1] ?? '');
      lines.push(`SECTION ${m[1]} — ${title} — note: ${note}`);
      for (const rowTitle of [...block.matchAll(/class="project-row-title">([^]*?)<\/span>/g)].map((r) => decode(r[1]))) {
        lines.push(`  ROW | ${decode(rowTextOf(html, rowTitle))}`);
      }
    }
    writeFileSync('/tmp/v5-chip-render-dump.txt', lines.join('\n') + '\n');
    expect(lines.length).toBeGreaterThan(0);
  });
});
