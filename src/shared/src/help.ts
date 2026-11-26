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

// ── Ask (docs/mocks/help-center board 02 §1–§4) ─────────────────────────────────────────────────────────────────
// An Ask is a conversation answered by the server on its own DeepSeek key (apiserver help/help-ask.ts, migration
// 1668): the person only sends questions. The answer draws on the help articles and on what the account reads say
// (machines, sessions, tasks, quota), and changes nothing. Asks are listed under /help → Your questions.
//
// Asks made before 1668 were sessions marked by `session.help_ask` (migration 0850) on one of the person's machines;
// the constants below the next line still describe those, as the runner starts them.

/** The runner capability that says it starts a session-based Ask read-only (runner-go help_ask.go). */
export const HELP_ASK_V1 = 'help-ask/v1';

/**
 * The account state an Ask may read: the server reads it for a DeepSeek Ask, and a session-based one read it through
 * one runner door each (GET /runner/help-ask/<name>). Machine status and heartbeat, session status, task status,
 * account quota.
 */
export const HELP_ASK_READS = ['machines', 'sessions', 'tasks', 'quota'] as const;
export type HelpAskRead = (typeof HELP_ASK_READS)[number];

/** The page the question was asked from (board 02 ① ③): its route, what the chip calls it, and the errors it shows. */
export interface HelpAskPage {
  route: string;
  label: string;
  errors: string[];
}

/** What a session-based Ask's `session.help_ask` holds. `page` is null when the person took the page chip off. */
export interface HelpAskMarker {
  page: HelpAskPage | null;
}

/** POST /api/help/ask: the first question, and the page it was asked from. */
export interface HelpAskCreateBody {
  content: string;
  page?: HelpAskPage | null;
}

/** POST /api/help/ask/:id/messages: a follow-up. */
export interface HelpAskFollowUpBody {
  content: string;
}

/** Where an Ask stands: the server is waiting on DeepSeek, it answered, or the last question got no answer. */
export type HelpAskStatus = 'working' | 'answered' | 'failed';

/** One message of an Ask, in the order said. An assistant message with `error` is a question that got no answer. */
export interface HelpAskMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  error?: string;
}

/** GET /api/help/ask/:id: one Ask, as the drawer and /help/questions/:id draw it. */
export interface HelpAskConversation {
  id: string;
  /** The first question. */
  title: string;
  page: HelpAskPage | null;
  status: HelpAskStatus;
  messages: HelpAskMessage[];
  createdAt: string;
}

/** `with-admin`: the person pressed Still stuck → Ask your admin, and an admin has the question as a task. */
export type HelpAskOutcome = 'working' | 'answered' | 'failed' | 'with-admin';

/** One row of /help → Your questions (board 02 ④). */
export interface HelpAskRow {
  id: string;
  /** The first question. */
  title: string;
  /** What the page chip called the page it was asked from, or null. */
  origin: string | null;
  outcome: HelpAskOutcome;
  createdAt: string;
  /** The admin this question was sent to (Still stuck → Ask your admin), or null. */
  sentTo: string | null;
}

/** GET /api/help/ask/conversations. */
export interface HelpAskList {
  questions: HelpAskRow[];
}

// ── Still stuck (board 02 ② right frame, side note 5) ───────────────────────────────────────────────────────────

/** Where the release this instance runs came from, when the server is not told otherwise (ORBIT_RELEASE_REPOSITORY). */
export const ORBIT_RELEASE_REPOSITORY_DEFAULT = 'jianghailong-xy/orbit';

/** GET /api/help/ask/:id/stuck: what the Still stuck card offers for this Ask. */
export interface HelpAskStuck {
  /** The admin Ask your admin sends to; null when the caller is an admin, or the instance has no other admin. */
  admin: { name: string } | null;
  /** Already sent: to whom, and when. */
  sentToAdmin: { adminName: string; at: string } | null;
  report: {
    /** `owner/repo` on GitHub: where the instance's release came from. */
    repository: string;
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

/** What a Yes / No is about: an article (by its slug) or one Ask answer (by `<Ask id>:<message index>`). */
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
