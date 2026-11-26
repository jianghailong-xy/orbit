// The help center's article library (docs/help, design: docs/mocks/help-center board 03 "how it reaches clients"):
// the categories, an article's front matter, and the answers of the apiserver's three help doors —
// GET /api/help, GET /api/help/articles/:slug and GET /api/help/search?q=. The library ships with the apiserver,
// so a client reads the help of the server it talks to.

/** The nine categories, in the order the help center lists them (board 03), each with its English name. */
export const HELP_CATEGORIES = [
  { slug: 'get-started', title: 'Get started' },
  { slug: 'workspaces-and-sessions', title: 'Workspaces & sessions' },
  { slug: 'projects-and-tasks', title: 'Projects & tasks' },
  { slug: 'wiki', title: 'Wiki' },
  { slug: 'machines-and-engines', title: 'Machines & engines' },
  { slug: 'models-keys-and-accounts', title: 'Models, keys & accounts' },
  { slug: 'phone-and-desktop-apps', title: 'Phone & desktop apps' },
  { slug: 'integrations-and-api', title: 'Integrations & API' },
  { slug: 'admin-and-self-hosting', title: 'Admin & self-hosting' },
] as const;
export type HelpCategorySlug = (typeof HELP_CATEGORIES)[number]['slug'];

/** The category only administrators are shown: absent from a non-admin's index and search, its articles a 404. */
export const HELP_ADMIN_CATEGORY: HelpCategorySlug = 'admin-and-self-hosting';

export const HELP_PLATFORMS = ['web', 'macos', 'ios', 'android'] as const;
export type HelpPlatform = (typeof HELP_PLATFORMS)[number];

/**
 * The languages the help library is read in. English is the library's source, docs/help/<category>/<slug>.md; every
 * other language ships as a translated copy beside it, docs/help/<language>/<category>/<slug>.md. A code is the one
 * Settings › Translation uses (TRANSLATION_LANGUAGES), so an account's "Your language" can choose the help it reads.
 * A language a server does not ship falls back to English article by article.
 */
export const HELP_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'zh-Hans', name: '中文' },
] as const;
export type HelpLanguage = (typeof HELP_LANGUAGES)[number]['code'];

/** The language an article is read in when the reader has chosen none: the library's own. */
export const DEFAULT_HELP_LANGUAGE: HelpLanguage = 'en';

export function isHelpLanguage(value: unknown): value is HelpLanguage {
  return typeof value === 'string' && (HELP_LANGUAGES as readonly { code: string }[]).some((l) => l.code === value);
}

export interface HelpCategory {
  slug: HelpCategorySlug;
  title: string;
}

/** An article's front matter, and its slug (the file's name: docs/help/<category>/<slug>.md). */
export interface HelpArticleMeta {
  slug: string;
  title: string;
  summary: string;
  category: HelpCategorySlug;
  /** The app routes the article is about, such as `/settings/machines/:id`: the drawer's "For this page". */
  routes: string[];
  /** The error slugs, such as `runner.offline`, whose cards link to this article. */
  errors: string[];
  platforms: HelpPlatform[];
  /** Listed under Common problems. */
  common: boolean;
  /** `YYYY-MM-DD`. */
  updated: string;
}

/** GET /api/help: the categories the caller may see, and every one of their articles' front matter (no bodies). */
export interface HelpIndex {
  categories: HelpCategory[];
  articles: HelpArticleMeta[];
}

/** GET /api/help/articles/:slug: the front matter and the Markdown body (after the front matter). */
export interface HelpArticle extends HelpArticleMeta {
  body: string;
}

/** Where a match is, in UTF-16 code units of the text it is in. */
export interface HelpMatch {
  start: number;
  length: number;
}

/** One search result. */
export interface HelpSearchHit {
  slug: string;
  title: string;
  category: HelpCategorySlug;
  /** The query's words in the title, for highlighting it. */
  titleMatches: HelpMatch[];
  /** A short plain-text passage around the first match in the body (else the summary), and the matches in it. */
  snippet: { text: string; matches: HelpMatch[] };
}

/** GET /api/help/search?q=: articles holding every word of the query, title hits first. */
export interface HelpSearchResult {
  query: string;
  hits: HelpSearchHit[];
}

// ── Ask (docs/mocks/help-center board 02 §1–§4, decisions on board 03) ───────────────────────────────────────────────
// An Ask is an ordinary session marked by `session.help_ask` (migration 0850): it runs on a machine and engine the
// person picks, belongs to no workspace, is in no workspace's session list, and is listed under /help → Your
// questions. Its runner starts it in a scratch folder holding the article library, with no tool that writes.

/** The runner capability that says it starts an Ask read-only (runner-go help_ask.go). A machine without it is not offered. */
export const HELP_ASK_V1 = 'help-ask/v1';

/** The engines an Ask runs on: the ones whose read-only start the runner enforces (Claude Code's tool list). */
export const HELP_ASK_ENGINES = ['claude'] as const;
export type HelpAskEngine = (typeof HELP_ASK_ENGINES)[number];

/**
 * The account state an Ask session may read, one runner door each (GET /runner/help-ask/<name>), and nothing else.
 * The board's list: machine status and heartbeat, session status, task status, account quota.
 */
export const HELP_ASK_READS = ['machines', 'sessions', 'tasks', 'quota'] as const;
export type HelpAskRead = (typeof HELP_ASK_READS)[number];

/** The page the question was asked from (board 02 ① ③): its route, what the chip calls it, and the errors it shows. */
export interface HelpAskPage {
  route: string;
  label: string;
  errors: string[];
}

/** What `session.help_ask` holds. `page` is null when the person took the page chip off. */
export interface HelpAskMarker {
  page: HelpAskPage | null;
}

/** One machine in the Runs on picker. */
export interface HelpAskMachine {
  id: string;
  name: string;
  online: boolean;
  /** This machine's runner starts an Ask read-only (HELP_ASK_V1). */
  supported: boolean;
  /** The engines it has signed in that an Ask can run on, and those it has that an Ask cannot (shown disabled). */
  engines: { engine: string; label: string; askable: boolean; model: string | null }[];
}

/** GET /api/help/ask/choices: the Runs on picker, and the machine and engine this person last asked on. */
export interface HelpAskChoices {
  machines: HelpAskMachine[];
  remembered: { runnerId: string; engine: string } | null;
}

/** POST /api/help/ask: the first question, where it runs, and the page it was asked from. */
export interface HelpAskCreateBody {
  content: string;
  runnerId: string;
  engine: string;
  model?: string;
  page?: HelpAskPage | null;
}

/** `with-admin`: the person pressed Still stuck → Ask your admin, and an admin has the question as a task. */
export type HelpAskOutcome = 'working' | 'answered' | 'failed' | 'with-admin';

/** One row of /help → Your questions (board 02 ④). */
export interface HelpAskRow {
  sessionId: string;
  /** The first question. */
  title: string;
  /** What the page chip called the page it was asked from, or null. */
  origin: string | null;
  outcome: HelpAskOutcome;
  costUsd: number;
  createdAt: string;
  runner: string | null;
  engine: string | null;
  model: string | null;
  /** The admin this question was sent to (Still stuck → Ask your admin), or null. */
  sentTo: string | null;
}

/** GET /api/help/ask/sessions. */
export interface HelpAskList {
  questions: HelpAskRow[];
}

// ── Still stuck (board 02 ② right frame, side note 5) ───────────────────────────────────────────────────────────

/** Where the release this instance runs came from, when the server is not told otherwise (ORBIT_RELEASE_REPOSITORY). */
export const ORBIT_RELEASE_REPOSITORY_DEFAULT = 'jianghailong-xy/orbit';

/** The machine an Ask ran on, as a GitHub report states it. */
export interface HelpAskReportMachine {
  name: string;
  runnerVersion: string | null;
  /** GOOS as the runner reports it: `linux`, `darwin`, `windows`; null for a runner that has not said. */
  os: string | null;
  lastHeartbeatAt: string | null;
}

/** GET /api/help/ask/:id/stuck: what the Still stuck card offers for this Ask. */
export interface HelpAskStuck {
  /** The admin Ask your admin sends to; null when the caller is an admin, or the instance has no other admin. */
  admin: { name: string } | null;
  /** Already sent: to whom, and when. */
  sentToAdmin: { adminName: string; at: string } | null;
  report: {
    /** `owner/repo` on GitHub: where the instance's release came from. */
    repository: string;
    machine: HelpAskReportMachine | null;
    /**
     * Words a report must not carry because they name the person's code: their workspaces' names, folders and
     * repositories. Never shown; the report builder takes them out.
     */
    privateNames: string[];
  };
}

/** POST /api/help/ask/:id/admin: the conversation, as the person saw it. */
export interface HelpAskAdminBody {
  exchanges: { question: string; answer: string }[];
}

/** POST /api/help/ask/:id/admin's answer: the admin's task. */
export interface HelpAskAdminResult {
  taskId: string;
  adminName: string;
  at: string;
}

// ── Did this help? / Did this answer it? (board 03 decision 3: counts only, no text) ─────────────────────────────

/** What a Yes / No is about: an article (by its slug) or one Ask answer (by `<Ask session id>:<seq>`). */
export const HELP_FEEDBACK_KINDS = ['article', 'answer'] as const;
export type HelpFeedbackKind = (typeof HELP_FEEDBACK_KINDS)[number];

/** POST /api/help/feedback: one person's Yes / No on one item. A second vote on the same item replaces the first. */
export interface HelpFeedbackBody {
  kind: HelpFeedbackKind;
  id: string;
  helpful: boolean;
}

/** One article's counts on Admin → Help feedback. */
export interface HelpFeedbackArticle {
  slug: string;
  /** The article's title, or null for a slug the library no longer has. */
  title: string | null;
  category: HelpCategorySlug | null;
  yes: number;
  no: number;
}

/** GET /api/admin/help-feedback: per-article counts, most No first, and the Ask answers' totals. Nothing else. */
export interface HelpFeedbackSummary {
  articles: HelpFeedbackArticle[];
  answers: { yes: number; no: number };
}

/** The engine's name as the picker shows it. */
export function helpAskEngineLabel(engine: string): string {
  switch (engine) {
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'kimi': return 'Kimi Code';
    case 'antigravity': return 'Antigravity';
    case 'opencode': return 'OpenCode';
    case 'dsh': return 'DeepSeek Harness';
    default: return engine;
  }
}
