import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ProjectsPage } from './ProjectsPage';

/**
 * ACCEPTANCE — the projects index against the 2026-08-23 production snapshot.
 *
 * Independent of `projectAttention.test.ts` and `ProjectsPage.test.tsx`: those name their fixtures
 * "Ledger Migration" and "FineWeb Corpus" and pick the numbers that make the rule visible. This one
 * takes the numbers back out of the deployment — every row below is `readProjectListRollups`' own
 * aggregate re-run against orbit-postgres for owner 5ccdf9b9 — and asks whether the page a real
 * reader loads puts the right projects at the top.
 *
 * Nothing here imports `projectAttention`. Sections, header notes and row order are all read back
 * out of the rendered markup, so a rule that is right in the module and wrong on the page fails.
 */

vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

interface Snapshot {
  id: string;
  title: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  running: number;
  ready: number;
  blocked: number;
  done: number;
  cancelled: number;
  tasks: number;
  lastActivityAt: string | null;
  createdAt: string;
}

const SNAPSHOT_AT = Date.parse('2026-08-23T18:55:05.000Z');

/**
 * The snapshot, verbatim from production, in `createdAt desc` — the order the endpoint still
 * returns and the order the page used to render. Reading down this list is reading the old page.
 *
 * `Linux From Scratch` is the one row not read live: it kept running after the snapshot was taken
 * (it now reports 0/2/112/4), so its buckets are the task's certified numbers and its
 * `lastActivityAt` is `max(task.updated_at)` restricted to writes at or before the snapshot
 * instant, 2026-08-23T18:55:05Z. Every other row matched the live aggregate field for field.
 */
const SNAPSHOT: Snapshot[] = [
  {
    id: '01a02d83-7c58-708c-8d7c-103d15523d70',
    title: 'FineWeb × Common Crawl → RocksDB 语料库',
    status: 'OPEN',
    running: 0, ready: 6118, blocked: 17324, done: 0, cancelled: 0, tasks: 23442,
    lastActivityAt: '2026-08-23T15:11:35.859Z',
    createdAt: '2026-08-23T07:26:26.904Z',
  },
  {
    id: '01a02787-b031-7116-8525-bf9ffe87aeb2',
    title: 'Runner 多用户免 root:hostd 机器壳 + 每用户 runner',
    status: 'OPEN',
    running: 0, ready: 4, blocked: 3, done: 19, cancelled: 0, tasks: 26,
    lastActivityAt: '2026-08-23T16:05:04.912Z',
    createdAt: '2026-08-22T03:33:19.025Z',
  },
  {
    id: '01a026c6-2ed9-7102-9ab5-c5da3070c899',
    title: 'Session 列表重设计：注意力收件箱 + 项目上卷',
    status: 'OPEN',
    running: 0, ready: 0, blocked: 0, done: 12, cancelled: 0, tasks: 12,
    lastActivityAt: '2026-08-22T01:48:02.685Z',
    createdAt: '2026-08-22T00:01:57.465Z',
  },
  {
    id: '01a02683-b415-7003-96d4-157636e3c26b',
    title: 'Session 状态模型正交化与兼容收敛',
    status: 'OPEN',
    running: 0, ready: 2, blocked: 14, done: 8, cancelled: 0, tasks: 24,
    lastActivityAt: '2026-08-23T17:56:53.866Z',
    createdAt: '2026-08-21T22:49:20.662Z',
  },
  {
    id: '01a024e7-71ec-7d42-a0a3-dd4dd1cb7111',
    title: 'iOS 客户端性能与内存优化',
    status: 'OPEN',
    running: 0, ready: 9, blocked: 1, done: 1, cancelled: 1, tasks: 12,
    lastActivityAt: '2026-08-21T17:20:21.286Z',
    createdAt: '2026-08-21T15:19:02.892Z',
  },
  {
    id: '01a02405-bdd1-7741-8f5c-67715bcc3ec8',
    title: 'Project 公平调度域改造',
    status: 'OPEN',
    running: 1, ready: 1, blocked: 9, done: 5, cancelled: 0, tasks: 16,
    lastActivityAt: '2026-08-21T16:04:25.546Z',
    createdAt: '2026-08-21T11:12:31.185Z',
  },
  {
    id: '01a02344-a4c7-76f0-8ae7-c98341f36db5',
    title: 'Orbit Agent Contract 与渐进式使用指南',
    status: 'OPEN',
    running: 0, ready: 1, blocked: 8, done: 0, cancelled: 0, tasks: 9,
    lastActivityAt: '2026-08-21T07:43:17.268Z',
    createdAt: '2026-08-21T07:41:36.327Z',
  },
  {
    id: '01a01d36-eb94-7620-b5ef-625d986cdeb8',
    title: 'Linux From Scratch：Docker 构建与 QEMU 启动',
    status: 'OPEN',
    running: 1, ready: 0, blocked: 117, done: 0, cancelled: 0, tasks: 118,
    lastActivityAt: '2026-08-23T18:48:17.244Z',
    createdAt: '2026-08-20T03:28:53.652Z',
  },
  {
    id: '01a01ab8-c9cc-71d3-88b6-01dadc00969c',
    title: 'Orbit 成熟开源项目品牌化建设',
    status: 'OPEN',
    running: 1, ready: 3, blocked: 10, done: 2, cancelled: 0, tasks: 16,
    lastActivityAt: '2026-08-20T15:58:14.024Z',
    createdAt: '2026-08-19T15:51:53.036Z',
  },
  {
    id: '01a017b6-5a3e-7fb0-b21a-3ad88a8dbcc3',
    title: 'Project Coordinator 持续推进控制环',
    status: 'OPEN',
    running: 0, ready: 6, blocked: 9, done: 92, cancelled: 3, tasks: 110,
    lastActivityAt: '2026-08-23T14:29:18.129Z',
    createdAt: '2026-08-19T01:50:21.759Z',
  },
  {
    id: '01a01785-1ea6-73d3-8ff2-f28d08b1da89',
    title: 'Project 多 Agent 协作与 Agent 级 Provider 调度',
    status: 'OPEN',
    running: 0, ready: 1, blocked: 24, done: 23, cancelled: 0, tasks: 48,
    lastActivityAt: '2026-08-21T18:52:34.353Z',
    createdAt: '2026-08-19T00:56:35.239Z',
  },
  {
    id: '01a01520-b6f6-7250-88b9-cfbac53aff8a',
    title: 'Orbit iOS Project 支持',
    status: 'OPEN',
    running: 0, ready: 4, blocked: 30, done: 5, cancelled: 0, tasks: 39,
    lastActivityAt: '2026-08-19T15:15:03.687Z',
    createdAt: '2026-08-18T13:47:40.662Z',
  },
];

/** Short handles, so an assertion below names a project rather than repeating 30 characters of it. */
const NAME = {
  fineweb: 'FineWeb × Common Crawl → RocksDB 语料库',
  runner: 'Runner 多用户免 root:hostd 机器壳 + 每用户 runner',
  sessionList: 'Session 列表重设计：注意力收件箱 + 项目上卷',
  sessionState: 'Session 状态模型正交化与兼容收敛',
  ios: 'iOS 客户端性能与内存优化',
  fairSched: 'Project 公平调度域改造',
  agentContract: 'Orbit Agent Contract 与渐进式使用指南',
  lfs: 'Linux From Scratch：Docker 构建与 QEMU 启动',
  brand: 'Orbit 成熟开源项目品牌化建设',
  coordinator: 'Project Coordinator 持续推进控制环',
  multiAgent: 'Project 多 Agent 协作与 Agent 级 Provider 调度',
  iosProject: 'Orbit iOS Project 支持',
} as const;

const byTitle = new Map(SNAPSHOT.map((p) => [p.title, p]));

/** The wire shape GET /projects returns, built from the snapshot row. */
function wireRow(p: Snapshot) {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    goal: null,
    createdAt: p.createdAt,
    updatedAt: p.createdAt,
    _count: { tasks: p.tasks },
    buckets: {
      running: p.running, ready: p.ready, blocked: p.blocked,
      done: p.done, cancelled: p.cancelled,
    },
    lastActivityAt: p.lastActivityAt,
  };
}

function render(rows: Snapshot[], now = SNAPSHOT_AT): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['projects', 'ALL'], rows.map(wireRow));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
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

interface RenderedSection {
  key: string;
  title: string;
  count: number;
  note: string;
  rows: string[];
  collapsed: boolean;
}

const decode = (s: string) =>
  s
    .replace(/<!--[^]*?-->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&middot;|&#183;/g, '·');

/**
 * The sections as the browser gets them: sliced out of the markup at `data-section`, with the
 * header's count and small print read off the header and the row titles read off the rows.
 *
 * A collapsed section draws pills instead of rows, so both spellings are collected — otherwise
 * "Completed is folded" and "Completed is ordered by activity" could not both be checked.
 */
function sectionsOf(html: string): RenderedSection[] {
  const out: RenderedSection[] = [];
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)];
  for (const [i, m] of marks.entries()) {
    const start = m.index;
    const end = i + 1 < marks.length ? marks[i + 1].index : html.length;
    const block = html.slice(start, end);
    const title = decode(/<h3[^>]*>([^]*?)<\/h3>/.exec(block)?.[1] ?? '').trim();
    const spans = [...block.matchAll(/<span[^>]*>([^]*?)<\/span>/g)].map((s) => decode(s[1]).trim());
    const count = Number(spans[0]);
    const note = spans[1] ?? '';
    const collapsed = /aria-expanded="false"/.test(block);
    const rows = collapsed
      ? [...block.matchAll(/<a[^>]*href="\/projects\/[^"]*"[^>]*>([^<]*)</g)].map((r) =>
          decode(r[1]).trim(),
        )
      : [...block.matchAll(/class="project-row-title">([^]*?)<\/span>/g)].map((r) =>
          decode(r[1]).trim(),
        );
    out.push({ key: m[1], title, count, note, rows, collapsed });
  }
  return out;
}

function sectionOf(html: string, key: string): RenderedSection {
  const found = sectionsOf(html).find((s) => s.key === key);
  if (!found) throw new Error(`no section "${key}" in the render; got ${sectionsOf(html).map((s) => s.key).join(', ')}`);
  return found;
}

describe('projects index — 2026-08-23 production snapshot', () => {
  const html = render(SNAPSHOT);

  it('renders every snapshot project exactly once, in some section', () => {
    const placed = sectionsOf(html).flatMap((s) => s.rows);
    expect(placed.slice().sort()).toEqual(SNAPSHOT.map((p) => p.title).sort());
    expect(new Set(placed).size).toBe(SNAPSHOT.length);
    for (const s of sectionsOf(html)) expect(s.count).toBe(s.rows.length);
  });

  it('leads with the seven projects that need intervention, ordered by reason then age', () => {
    expect(sectionOf(html, 'attention').rows).toEqual([
      NAME.brand,
      NAME.fairSched,
      NAME.iosProject,
      NAME.agentContract,
      NAME.ios,
      NAME.multiAgent,
      NAME.sessionList,
    ]);
  });

  it('keeps the genuinely active project in Running', () => {
    expect(sectionOf(html, 'running').rows).toEqual([NAME.lfs]);
  });

  it('keeps fresh queues in Ready and orders them by age, not queue size', () => {
    const ready = sectionOf(html, 'ready').rows;
    expect(ready).toEqual([
      NAME.coordinator,
      NAME.fineweb,
      NAME.runner,
      NAME.sessionState,
    ]);
    // FineWeb's 6,118 shards do not make it outrank the older six-task queue.
    expect(ready.map((title) => byTitle.get(title)!.ready)).toEqual([6, 6118, 4, 2]);
  });

  it('holds that order whatever order the endpoint returned the rows in', () => {
    const permutations: Record<string, Snapshot[]> = {
      'as returned': SNAPSHOT,
      reversed: [...SNAPSHOT].reverse(),
      'by title': [...SNAPSHOT].sort((a, b) => a.title.localeCompare(b.title)),
      'createdAt asc': [...SNAPSHOT].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      'ready asc': [...SNAPSHOT].sort((a, b) => a.ready - b.ready),
      rotated: [...SNAPSHOT.slice(7), ...SNAPSHOT.slice(0, 7)],
    };
    const expected = sectionsOf(html).map((s) => [s.key, s.rows] as const);
    for (const [name, rows] of Object.entries(permutations)) {
      const got = sectionsOf(render(rows)).map((s) => [s.key, s.rows] as const);
      expect(got, `input order: ${name}`).toEqual(expected);
    }
  });

  it('renders byte-identical markup on repeated renders', () => {
    const again = Array.from({ length: 5 }, () => render(SNAPSHOT));
    for (const [i, h] of again.entries()) expect(h, `render #${i + 2}`).toBe(html);
  });

  it('renders only the non-empty lanes and states each lane’s ordering', () => {
    const rendered = sectionsOf(html);
    expect(rendered.map((s) => s.key)).toEqual(['attention', 'running', 'ready']);
    expect(sectionOf(html, 'attention').note).toContain('reason/severity first, then oldest signal');
    expect(sectionOf(html, 'running').note).toContain('newest task activity first');
    expect(sectionOf(html, 'ready').note).toContain('oldest task activity first');
    for (const s of rendered) expect(s.collapsed).toBe(false);
  });
});

/**
 * The same page over the account as it stands NOW — all 19 projects, DONE ones included, straight
 * off the same aggregate. The snapshot above has no finished project in it, so on its own it never
 * renders Completed and never proves the fold.
 */
describe('projects index — the live account, including its finished projects', () => {
  const FINISHED: Snapshot[] = [
    {
      id: '01a02a15-1cbf-770b-8987-cb5b8d311c67',
      title: 'Project 详情页全景重做：从任务树到注意力路由',
      status: 'DONE',
      running: 0, ready: 0, blocked: 0, done: 16, cancelled: 0, tasks: 16,
      lastActivityAt: '2026-08-22T19:05:54.346Z', createdAt: '2026-08-22T15:27:01.823Z',
    },
    {
      id: '01a022e0-781a-78b3-b7fd-acf5877a4acc',
      title: 'Codex 运行中 Prompt（turn/steer）接入',
      status: 'DONE',
      running: 0, ready: 0, blocked: 0, done: 17, cancelled: 25, tasks: 43,
      lastActivityAt: '2026-08-22T19:55:20.349Z', createdAt: '2026-08-21T05:52:11.284Z',
    },
    {
      // A DONE project that still has a task IN_PROGRESS — Completed must win over `running > 0`,
      // or a finished project reappears at the top of the page.
      id: '01a01ef2-9b0c-7cb2-a7e5-8244a6b3df06',
      title: 'Claude Code 运行中 Prompt 接入改造',
      status: 'DONE',
      running: 1, ready: 0, blocked: 0, done: 10, cancelled: 1, tasks: 12,
      lastActivityAt: '2026-08-21T00:31:57.964Z', createdAt: '2026-08-20T11:33:31.020Z',
    },
  ];

  it('folds Completed by default and leaves the attention sections open', () => {
    const html = render([...SNAPSHOT, ...FINISHED]);
    const rendered = sectionsOf(html);
    expect(rendered.map((s) => s.key)).toEqual(['attention', 'running', 'ready', 'completed']);
    expect(rendered.filter((s) => s.collapsed).map((s) => s.key)).toEqual(['completed']);
    expect(sectionOf(html, 'completed').rows).toEqual(
      [...FINISHED].sort((a, b) => Date.parse(b.lastActivityAt!) - Date.parse(a.lastActivityAt!)).map((p) => p.title),
    );
    // The finished project with a task still running stayed finished.
    expect(sectionOf(html, 'running').rows).not.toContain('Claude Code 运行中 Prompt 接入改造');
    // Its task-count remainder looks like one FAILED task, but closed project status still wins.
    expect(sectionOf(html, 'completed').rows).toContain('Codex 运行中 Prompt（turn/steer）接入');
    expect(sectionOf(html, 'attention').rows).not.toContain('Codex 运行中 Prompt（turn/steer）接入');
  });
});

/**
 * Ready-to-close work, with more than one row in Needs attention.
 *
 * The live account holds exactly one all-settled OPEN project, and one row cannot disagree with a
 * header that says "newest activity first" — so the check above records that section as
 * unexercised rather than counting it as passed. The two rows added here are NOT invented: they
 * are `Project 详情页全景重做` and `Kimi ACP stdio MCP 断裂修复`, with their real buckets and their
 * real `max(task.updated_at)`, held at the status each of them genuinely had for the window
 * between its last task closing and somebody marking the project DONE. That window is precisely
 * what this section exists to render.
 */
describe('projects index — ready-to-close work inside Needs attention', () => {
  const BEFORE_CLOSING: Snapshot[] = [
    {
      id: '01a02a15-1cbf-770b-8987-cb5b8d311c67',
      title: 'Project 详情页全景重做：从任务树到注意力路由',
      status: 'OPEN',
      running: 0, ready: 0, blocked: 0, done: 16, cancelled: 0, tasks: 16,
      lastActivityAt: '2026-08-22T19:05:54.346Z', createdAt: '2026-08-22T15:27:01.823Z',
    },
    {
      id: '01a029fb-587d-7593-84e4-2c1a1bf34ced',
      title: 'Kimi ACP stdio MCP 断裂修复（方案 A：KIMI_CODE_HOME 覆盖层）',
      status: 'OPEN',
      running: 0, ready: 0, blocked: 0, done: 8, cancelled: 0, tasks: 8,
      lastActivityAt: '2026-08-22T18:09:30.167Z', createdAt: '2026-08-22T14:58:53.181Z',
    },
  ];

  it('puts closure after operational faults and orders closure peers oldest first', () => {
    const rows = [...SNAPSHOT, ...BEFORE_CLOSING];
    const extra = new Map(BEFORE_CLOSING.map((p) => [p.title, p]));
    const html = render(rows);
    const attention = sectionOf(html, 'attention');
    expect(attention.note).toContain('reason/severity first, then oldest signal');
    const closing = attention.rows.filter((title) => title === NAME.sessionList || extra.has(title));
    expect(closing).toEqual([
      NAME.sessionList, // 08-22T01:48
      'Kimi ACP stdio MCP 断裂修复（方案 A：KIMI_CODE_HOME 覆盖层）', // 08-22T18:09
      'Project 详情页全景重做：从任务树到注意力路由', // 08-22T19:05
    ]);
    const at = (t: string) => Date.parse((byTitle.get(t) ?? extra.get(t))!.lastActivityAt!);
    for (const [i, t] of closing.entries()) {
      const next = closing[i + 1];
      if (next) expect(at(t)).toBeLessThan(at(next));
    }
  });
});

/**
 * ACCEPTANCE — the badges, over the same snapshot.
 *
 * The claim this unit was filed on is a claim about production: two projects hold a task whose
 * status says RUNNING while nothing has been written to them for days, and the page had no signal
 * for either. That is checkable here and nowhere else — a fixture named "Zombie Run" can only show
 * that the rule works, not that anything in the deployment trips it.
 *
 * The page clock is fixed at the snapshot instant, so both lane membership and badge ages remain
 * reproducible no matter when the suite runs.
 */
describe('projects index — badges over the 2026-08-23 production snapshot', () => {
  /** Every badged row, as `[title, badge]`, in the order the page draws them. */
  function badges(html: string): Array<[string, string]> {
    return [...html.matchAll(/<li [\s\S]*?<\/li>/g)].flatMap((li) => {
      const title = /class="project-row-title">([^<]*)</.exec(li[0]);
      const chip = /class="project-row-chip project-row-chip-\w+">([^<]*)</.exec(li[0]);
      return title && chip ? [[decode(title[1]).trim(), decode(chip[1]).trim()] as [string, string]] : [];
    });
  }

  const html = render(SNAPSHOT);

  it('moves the two quiet runs to Needs attention and names the missing activity', () => {
    const stale = badges(html).filter(([, chip]) => chip.startsWith('Running · no activity'));

    expect(stale).toEqual([
      [NAME.brand, 'Running · no activity 3d'],
      [NAME.fairSched, 'Running · no activity 2d'],
    ]);
    // Linux From Scratch is the control: it is in the same section, it also has a task running,
    // and it wrote three minutes before the snapshot — so the badge is about the silence, not
    // about the section.
    expect(badges(html).map(([title]) => title)).not.toContain(NAME.lfs);
  });

  it('badges the finished project nobody closed with its own count', () => {
    expect(badges(html)).toContainEqual([NAME.sessionList, '12/12 settled · still open']);
  });

  it('moves only quiet ready queues to attention and leaves fresh queues in Ready', () => {
    const badged = badges(html);
    const readyBadges = badged.filter(([, chip]) => chip.startsWith('Ready · no activity'));

    expect(readyBadges).toEqual([
      [NAME.iosProject, 'Ready · no activity 4d'],
      [NAME.agentContract, 'Ready · no activity 2d'],
      [NAME.ios, 'Ready · no activity 2d'],
      [NAME.multiAgent, 'Ready · no activity 2d'],
    ]);
    expect(sectionOf(html, 'attention').rows).toHaveLength(7);
    expect(sectionOf(html, 'ready').rows).toHaveLength(4);
    expect(badged).toHaveLength(7);
    expect(badged.map(([t]) => t)).not.toContain(NAME.fineweb);
  });

  it('keeps the one running task in the 118-task project on the bar', () => {
    // The snapshot's thinnest real segment: 1 running against 117 blocked. Across the 196px this
    // column gets, one flex unit in 118 is under two pixels, and a proportional bar would round it
    // away — leaving the row saying nothing is running in the project that is the only reason it
    // is filed under Running at all. The 3px floor is what stops that.
    const row = [...html.matchAll(/<li [\s\S]*?<\/li>/g)]
      .map((m) => m[0])
      .find((li) => li.includes(NAME.lfs))!;
    const meter = /<div role="img"[\s\S]*?<\/div>/.exec(row)![0];

    // Two segments for the two non-empty buckets, in the panorama's own order, each with the floor
    // under it. The two buckets at zero draw nothing at all.
    expect([...meter.matchAll(/background:var\(--([a-z0-9-]+)\)/g)].map((m) => m[1])).toEqual([
      'brand',
      'text-3',
    ]);
    expect(meter.match(/min-width:3px/g)).toHaveLength(2);
    // Proportion is still what sizes them — the floor is a minimum, not a redistribution.
    expect([...meter.matchAll(/flex:(\d+)/g)].map((m) => m[1])).toEqual(['1', '117']);
    // And the number is beside the bar too, because colour alone is not carrying it.
    expect(row).toContain('<b>1</b>');
  });

});
