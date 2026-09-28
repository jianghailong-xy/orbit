// Orbit Wiki's articles (contracts/wiki.contract.json `articles`, migration 0317, criterion 9): the
// view a person reads — each topic's article, footnoted to the entries it was written from. The
// entries stay the store; an article is a cache of them. wikiContract.spec.ts holds every constant
// below to the contract JSON.

import type { WikiEntryKind, WikiEntryStatus, WikiTrust } from './wiki';

/** The six categories a topic is filed under, in the order the directory lists them (the demo's). */
export const WIKI_ARTICLE_CATEGORIES = [
  { key: 'platform', title: 'Platform core' },
  { key: 'runner', title: 'Runner & engines' },
  { key: 'clients', title: 'Clients & UI' },
  { key: 'data', title: 'Data & backend' },
  { key: 'engineering', title: 'Engineering workflow' },
  { key: 'collaboration', title: 'Collaboration' },
] as const;
export type WikiArticleCategory = (typeof WIKI_ARTICLE_CATEGORIES)[number]['key'];
export const WIKI_ARTICLE_CATEGORY_KEYS: readonly WikiArticleCategory[] = WIKI_ARTICLE_CATEGORIES.map((c) => c.key);

/** `article` is a topic's one article; a split topic has an `overview` (part 0) and `subtopic` parts. */
export const WIKI_ARTICLE_KINDS = ['article', 'overview', 'subtopic'] as const;
export type WikiArticleKind = (typeof WIKI_ARTICLE_KINDS)[number];

/** The numbers articles are written and checked by (contract `articles.rules`). */
export const WIKI_ARTICLE_RULES = {
  /** An article's kept sentences, in characters: the writer aims inside [minChars, maxChars]… */
  minChars: 400,
  /** …and the server cuts what passes this. */
  maxChars: 900,
  /** A topic with more entries than this is split into subtopic articles and an overview. */
  splitAbove: 45,
  /** The size a subtopic group is aimed at, the most groups a topic is split into, and the smallest
   *  group kept on its own (a smaller one folds into its nearest). */
  groupTarget: 40,
  groupsMax: 40,
  groupMin: 8,
  /** The most entries one article is written from: the best-supported of its pool. */
  entriesPerArticle: 30,
  titleMaxChars: 120,
  /** The most Markdown one part may carry. */
  markdownMaxChars: 20_000,
} as const;

/** A topic a space is given when it has none (contract `articles.defaultTopics`). */
export interface WikiDefaultTopic {
  slug: string;
  /** The display name. */
  title: string;
  category: WikiArticleCategory;
  description: string;
  /** An entry whose paths start with one of these votes for the topic; the longest prefix wins. */
  pathPrefixes: readonly string[];
}

/**
 * The demo's 22 topics, in the directory's order, with the path prefixes that file an entry under
 * each. The demo's catch-all — anything under `src/apiserver` read as a session — is gone: an entry
 * whose paths no prefix claims is filed by the slug it names, then by its words.
 */
export const WIKI_DEFAULT_TOPICS: readonly WikiDefaultTopic[] = [
  {
    slug: 'sessions',
    title: '会话',
    category: 'platform',
    description: 'Sessions: lifecycle, messages, turns, steer and interrupt, delivery, attachments, session merge and commit.',
    pathPrefixes: [
      'src/apiserver/src/sessions/',
      'src/apiserver/src/attachments/',
      'src/apiserver/src/link-previews/',
      'src/apiserver/src/session-tags/',
      'src/runner-go/session',
      'src/runner-go/transcript',
      'docs/session-',
    ],
  },
  {
    slug: 'tasks',
    title: '任务与派发',
    category: 'platform',
    description: 'Tasks and task lists: completion criteria, acceptance, dependencies, dispatch, retries, evidence.',
    pathPrefixes: ['src/apiserver/src/tasks/', 'src/apiserver/src/task-lists/', 'src/runner-go/task', 'docs/task-'],
  },
  {
    slug: 'projects',
    title: '项目与落地',
    category: 'platform',
    description:
      'Projects and coordinators: the integration line, landing and promotion to main, blockers, open items, the outcome reconciler.',
    pathPrefixes: [
      'src/apiserver/src/projects/',
      'src/apiserver/src/outcome-reconciler/',
      'src/apiserver/src/deadlock/',
      'src/runner-go/project',
      'scripts/outcome-reconciler',
      'scripts/project-',
      'docs/project-',
    ],
  },
  {
    slug: 'watches-wakeups',
    title: 'Watch 与唤醒',
    category: 'platform',
    description: 'Watches, scheduled wakeups, awaits and the notifications they send to sessions.',
    pathPrefixes: ['src/apiserver/src/watches/', 'src/runner-go/watch', 'contracts/watch', 'docs/watch-'],
  },
  {
    slug: 'wiki',
    title: 'Wiki',
    category: 'platform',
    description: 'The Orbit wiki itself: its contract, entries, review, maintenance and articles.',
    pathPrefixes: [
      'src/apiserver/src/wiki/',
      'src/apiserver/src/runner-api/runner-wiki',
      'src/runner-go/wiki',
      'src/web/src/pages/Wiki',
      'src/web/src/components/Wiki',
      'src/web/src/lib/wiki',
      'src/macos/OrbitKit/Sources/OrbitKit/Models/Wiki',
      'src/macos/OrbitKit/Sources/OrbitKit/App/Wiki',
      'src/macos/OrbitKit/Tests/OrbitKitTests/Wiki',
      'src/macos/OrbitApp/Sources/OrbitApp/Wiki',
      'src/macos/OrbitApp/Sources/OrbitApp/Views/Wiki',
      'contracts/wiki',
      'docs/wiki',
      'docs/mocks/wiki',
      'scripts/wiki-',
    ],
  },
  {
    slug: 'runner',
    title: 'Runner',
    category: 'runner',
    description: 'The Go runner daemon: claim and lease, background jobs, self-update, process management, and the runner door.',
    pathPrefixes: ['src/runner-go/', 'src/apiserver/src/runner-api/', 'src/apiserver/src/runners/'],
  },
  {
    slug: 'engines-providers',
    title: '引擎与模型提供方',
    category: 'runner',
    description:
      'Coding engines and model providers: Claude Code, Codex, Kimi, OpenCode, vLLM, models, effort, quotas and rate limits.',
    pathPrefixes: [
      'src/apiserver/src/providers/',
      'src/apiserver/src/agents/',
      'src/runner-go/claude',
      'src/runner-go/codex',
      'src/runner-go/kimi',
      'src/runner-go/opencode',
      'src/runner-go/provider',
      'src/runner-go/model',
      'src/runner-go/engine',
      'src/runner-go/planusage',
    ],
  },
  {
    slug: 'agent-tooling',
    title: 'Agent 工具与环境',
    category: 'runner',
    description: "How agents work here: Bash tool quirks, MCP tools and the orbit CLI, subagents, context and the agents' memory.",
    pathPrefixes: [
      'src/runner-go/mcp',
      'src/runner-go/agent_instructions',
      'src/runner-go/background',
      'src/runner-go/orchestration',
      'src/runner-go/notify',
      'src/runner-go/cli_',
    ],
  },
  {
    slug: 'web-client',
    title: 'Web 客户端',
    category: 'clients',
    description: 'The web client: React, antd, vitest, layout.',
    pathPrefixes: ['src/web/'],
  },
  {
    slug: 'apple-clients',
    title: 'iOS 与 macOS 客户端',
    category: 'clients',
    description: 'The iOS and macOS clients and OrbitKit: SwiftUI, Xcode, TestFlight builds.',
    pathPrefixes: ['src/macos/', 'src/ios/'],
  },
  {
    slug: 'realtime-push',
    title: '实时流与推送',
    category: 'clients',
    description: 'Realtime streams, server-sent events and push notifications.',
    pathPrefixes: ['src/apiserver/src/realtime/', 'src/apiserver/src/push/', 'src/apiserver/src/events/', 'docs/realtime-'],
  },
  {
    slug: 'ui-design',
    title: 'UI 设计',
    category: 'clients',
    description: 'UI and UX design: mockups, screenshots, layout rules, the copy in the UI.',
    pathPrefixes: ['docs/mocks/', 'docs/ux/'],
  },
  {
    slug: 'database',
    title: '数据库与 Prisma',
    category: 'data',
    description: 'PostgreSQL and Prisma: schema, migrations, queries, performance, locks, backups, the write inventory.',
    pathPrefixes: [
      'src/apiserver/prisma/',
      'src/apiserver/src/prisma/',
      'src/apiserver/src/common/db-write-inventory',
      'src/apiserver/src/common/transaction-retry',
      'src/apiserver/src/common/lock-order',
      'docs/postgres-',
      'docs/db-write-audit',
      'scripts/pg-',
      'scripts/sync-db-trigger-inventory',
    ],
  },
  {
    slug: 'auth-workspaces',
    title: '账号与工作区',
    category: 'data',
    description: 'Auth, users, accounts, workspaces, share links and permissions.',
    pathPrefixes: [
      'src/apiserver/src/auth/',
      'src/apiserver/src/users/',
      'src/apiserver/src/share-links/',
      'src/apiserver/src/workspaces/',
      'docs/share-links-',
    ],
  },
  {
    slug: 'shared-contracts',
    title: '共享包与契约',
    category: 'data',
    description: 'The shared package and the contracts: codecs, ids, protocol definitions.',
    pathPrefixes: ['src/shared/', 'contracts/', 'src/apiserver/src/common/public-id'],
  },
  {
    slug: 'security',
    title: '安全与密钥',
    category: 'data',
    description: 'Secrets, keys, redaction and the handling of credentials.',
    pathPrefixes: ['src/apiserver/src/common/secret', 'docs/dependency-security'],
  },
  {
    slug: 'git-worktrees',
    title: 'Git 与 worktree',
    category: 'engineering',
    description: 'Git and worktrees: branches, merges, rebases, cherry-picks, stash, worktree overlays and node_modules.',
    pathPrefixes: [
      'src/runner-go/worktree',
      'src/runner-go/git',
      'src/runner-go/merge',
      'src/runner-go/integrate',
      'src/runner-go/repohealth',
      'scripts/worktree-overlay',
    ],
  },
  {
    slug: 'testing',
    title: '测试',
    category: 'engineering',
    description: 'Tests: pg specs, node:test, vitest, go test, fixtures, flakes and acceptance scripts.',
    pathPrefixes: [
      'scripts/run-pg-spec',
      'scripts/acceptance/',
      'scripts/pg-matrix-',
      'scripts/executable-acceptance-',
      'src/apiserver/src/test-support/',
    ],
  },
  {
    slug: 'ci-release',
    title: 'CI 与发版',
    category: 'engineering',
    description: 'CI and releases: GitHub Actions, tags, versions, signing, notarization, TestFlight.',
    pathPrefixes: [
      '.github/',
      'scripts/ci/',
      'scripts/build-binaries',
      'scripts/runner-release',
      '.claude/skills/release/',
      'src/runner-go/selfupdate',
      'package.json',
      'package-lock.json',
    ],
  },
  {
    slug: 'deploy-ops',
    title: '部署与运维',
    category: 'engineering',
    description: 'Deployment and the host: docker compose, upgrade, gateway, disk, memory, systemd, logs.',
    pathPrefixes: [
      'docker-compose',
      'gateway/',
      '.claude/skills/upgrade/',
      'scripts/image-boot',
      'docs/self-hosting',
      'src/apiserver/Dockerfile',
      'src/web/Dockerfile',
      'src/runner-go/hostd',
    ],
  },
  {
    slug: 'observability',
    title: '可观测性',
    category: 'engineering',
    description: 'Metrics, logs, dashboards and diagnosing production incidents.',
    pathPrefixes: ['src/apiserver/src/metrics/', 'src/apiserver/src/health/'],
  },
  {
    slug: 'workflow-owner',
    title: '与 owner 协作',
    category: 'collaboration',
    description: 'How the owner wants work done: communication, language, confirmations, scope, reporting.',
    pathPrefixes: ['docs/human-only-authority', 'CLAUDE.md', 'AGENTS.md'],
  },
];

/**
 * An article's length as the contract counts it (`articles.rulesNote`): characters — Unicode code
 * points, so a Chinese character is one — of the text given, which is its kept sentences.
 */
export function wikiArticleChars(text: string): number {
  let n = 0;
  for (const _ch of text) n += 1;
  return n;
}

// ── Wire types ─────────────────────────────────────────────────────────────────────────────────

/** One sentence of an article, and the footnote numbers it carries (1-based, into `footnotes`). */
export interface WikiArticleSentence {
  text: string;
  notes: number[];
}

/** A run of sentences under one heading; the lead has none. */
export interface WikiArticleBlock {
  heading: string | null;
  sentences: WikiArticleSentence[];
}

/** What one footnote number names: an entry, at the revision the article was written from. */
export interface WikiArticleCitation {
  n: number;
  entryId: string;
  revision: number;
}

/** A footnote as a reader gets it: the citation, and the entry it names as that entry stands now
 *  (null when it no longer exists). */
export interface WikiArticleFootnote extends WikiArticleCitation {
  entry: {
    id: string;
    kind: WikiEntryKind;
    title: string;
    summary: string;
    status: WikiEntryStatus;
    trust: WikiTrust;
    currentRevision: number;
  } | null;
}

/** What the validation did to one part (contract `articles.validation`). */
export interface WikiArticleStats {
  /** Sentences the model wrote, and how many were deleted for want of a valid footnote… */
  sentences: number;
  sentencesDeleted: number;
  /** …footnote markers it wrote, and how many were stripped (out of range, another topic's, no entry)… */
  markers: number;
  markersStripped: number;
  /** …sentences cut to keep the article within rules.maxChars… */
  sentencesTrimmed: number;
  /** …and what is left: characters of the kept sentences, and footnotes. */
  chars: number;
  footnotes: number;
}

/** One part as the directory and the index name it. */
export interface WikiArticlePartRef {
  part: number;
  kind: WikiArticleKind;
  title: string;
  /** Entries it was written from. */
  entryCount: number;
}

/** `GET /api/wiki/spaces/:id/articles`: categories → topics → the article and its subtopic parts. */
export interface WikiArticleDirectory {
  spaceId: string;
  categories: Array<{
    key: WikiArticleCategory;
    title: string;
    topics: WikiArticleDirectoryTopic[];
  }>;
  /** Topics nothing has filed under a category. */
  uncategorized: WikiArticleDirectoryTopic[];
}

export interface WikiArticleDirectoryTopic {
  slug: string;
  title: string;
  description: string | null;
  category: WikiArticleCategory | null;
  /** Part 0, when the topic has articles. */
  article: (WikiArticlePartRef & { generatedAt: string }) | null;
  /** The subtopic articles under an overview, in order. */
  parts: WikiArticlePartRef[];
}

/** `GET /api/wiki/spaces/:id/articles/:slug[/:part]`. */
export interface WikiArticleView {
  spaceId: string;
  topic: { slug: string; title: string; category: WikiArticleCategory | null; categoryTitle: string | null };
  part: number;
  kind: WikiArticleKind;
  title: string;
  blocks: WikiArticleBlock[];
  footnotes: WikiArticleFootnote[];
  entryCount: number;
  chars: number;
  generatedAt: string;
  ref: string | null;
  model: string | null;
  /** The overview a subtopic article belongs to. */
  overview: WikiArticlePartRef | null;
  /** The subtopic articles of this topic, whichever part this is. */
  parts: WikiArticlePartRef[];
}

/** `GET /api/wiki/spaces/:id/article-index`: every article, A to Z. */
export interface WikiArticleIndex {
  spaceId: string;
  items: Array<WikiArticlePartRef & {
    /** A to Z, or `#` for a title that does not start with a Latin letter. */
    initial: string;
    topic: { slug: string; title: string };
  }>;
}

/** `POST /api/runner/wiki/spaces/:id/article-plan`: which topics' articles need writing. */
export interface WikiArticlePlan {
  spaceId: string;
  /** Topics the space was given by this call (articles.seeding); 0 when it had some. */
  seeded: number;
  /** Active, untainted entries the plan filed, and those no topic took. */
  entries: number;
  unassigned: number;
  topics: Array<{
    slug: string;
    title: string;
    category: WikiArticleCategory | null;
    entryCount: number;
    entrySetSha256: string;
    /** The fingerprint the topic's part 0 was written from, or null before its first article. */
    articleSha256: string | null;
    generatedAt: string | null;
    /** It has entries, and no article written from exactly them. */
    changed: boolean;
  }>;
}

/** One entry as an article is written from it. */
export interface WikiArticleInputEntry {
  id: string;
  revision: number;
  kind: WikiEntryKind;
  title: string;
  summary: string;
  fields: Record<string, unknown>;
  /** The repo-relative paths it names: what the grouping weighs first. */
  paths: string[];
  /** First-hand sources on its current revision: how corroborated it is. */
  sources: number;
  trust: WikiTrust;
  recordedAt: string;
}

/** `GET /api/runner/wiki/spaces/:id/articles/:slug/input`. */
export interface WikiArticleInput {
  spaceId: string;
  topic: { slug: string; title: string; category: WikiArticleCategory | null; description: string | null };
  entrySetSha256: string;
  articleSha256: string | null;
  entries: WikiArticleInputEntry[];
}

/** One part of `POST /api/runner/wiki/spaces/:id/articles/:slug`. */
export interface WikiArticlePartInput {
  part: number;
  kind: WikiArticleKind;
  title: string;
  markdown: string;
  /** The entry each footnote marker names: [n] is notes[n-1]. */
  notes: string[];
  /** A subtopic part's group: the entries it was written about. */
  entries?: string[];
}

export interface WikiArticleWriteRequest {
  /** The fingerprint of the entries the parts were written from, as the input route gave it. */
  entrySetSha256: string;
  ref?: string;
  model?: string;
  articles: WikiArticlePartInput[];
}

export interface WikiArticleWriteResult {
  spaceId: string;
  slug: string;
  /** The parts were stored; false when nothing was (unchanged, or part 0 kept no sentence). */
  written: boolean;
  /** The stored articles were written from exactly these entries already. */
  unchanged: boolean;
  /** Why nothing was written, when that was not `unchanged`. */
  reason: string | null;
  parts: Array<{ part: number; kind: WikiArticleKind; title: string; kept: boolean; stats: WikiArticleStats }>;
  stats: WikiArticleStats;
}
