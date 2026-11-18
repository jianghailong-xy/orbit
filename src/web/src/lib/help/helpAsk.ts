import { queryOptions } from '@tanstack/react-query';
import type { HelpArticleMeta, HelpAskChoices, HelpAskCreateBody, HelpAskList, HelpAskMachine, HelpAskPage } from '@orbit/shared';
import { api } from '../../api';
import type { RunEvent } from '../useSessionStream';
import { helpArticleLink, ORBIT_LINK_PREFIX } from './helpContent';

// The help center's Ask on the web (docs/mocks/help-center board 02): the Runs on picker, asking, Your questions,
// and how an answer reads — its [n] citations, its source list and its link buttons, and the one collapsed line that
// says what it looked at. The answer is the session's own transcript; nothing here is stored apart from it.

/** GET /api/help/ask/choices: the Runs on picker and the pick remembered. */
export const helpAskChoicesQuery = () =>
  queryOptions({
    queryKey: ['help', 'ask', 'choices'] as const,
    queryFn: () => api<HelpAskChoices>('/help/ask/choices'),
    staleTime: 15_000,
  });

/** GET /api/help/ask/sessions: /help → Your questions. It declares `session`, so a session event refreshes it. */
export const helpAskListQuery = () =>
  queryOptions({
    queryKey: ['sessions', 'help-ask'] as const,
    meta: { entities: ['session'] },
    queryFn: () => api<HelpAskList>('/help/ask/sessions'),
  });

/** POST /api/help/ask: the first question. */
export const createHelpAsk = (body: HelpAskCreateBody) =>
  api<{ sessionId: string }>('/help/ask', { method: 'POST', body });

/** The machines an Ask can run on now: online, on a runner that answers read-only, with an engine for it. */
export function askableMachines(choices: HelpAskChoices | undefined): HelpAskMachine[] {
  return (choices?.machines ?? []).filter((m) => m.online && m.supported && m.engines.some((e) => e.askable));
}

/** What the picker starts on: the remembered pick while it can still answer, else the first machine that can. */
export function defaultAskPick(choices: HelpAskChoices | undefined): { runnerId: string; engine: string } | null {
  const machines = askableMachines(choices);
  const remembered = choices?.remembered;
  if (remembered) {
    const machine = machines.find((m) => m.id === remembered.runnerId);
    if (machine?.engines.some((e) => e.engine === remembered.engine && e.askable)) return remembered;
  }
  const first = machines[0];
  const engine = first?.engines.find((e) => e.askable);
  return first && engine ? { runnerId: first.id, engine: engine.engine } : null;
}

// ── suggested questions (board 02 ①②) ────────────────────────────────────────────────────────────────────────────

const VERBS = new Set(['add', 'connect', 'open', 'run', 'set', 'use', 'create', 'keep', 'turn', 'move', 'pick', 'sign',
  'start', 'share', 'stop', 'install', 'update', 'invite', 'review', 'merge', 'land', 'write', 'find', 'change', 'switch']);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * A page's article as the question somebody asks to get to it, when its title is an instruction ("Add a second
 * machine" asks "How do I add a second machine?"); null for a title that is not ("A machine shows Offline"), which
 * reads as no question a person would type.
 */
export function questionFor(article: Pick<HelpArticleMeta, 'title'>): string | null {
  const title = article.title.trim().replace(/[.?]$/u, '');
  const first = title.split(/\s+/u)[0]?.toLowerCase() ?? '';
  return VERBS.has(first) ? `How do I ${lowerFirst(title)}?` : null;
}

/** An error's article as a question: what the message on the page means. */
export const errorQuestionFor = (article: Pick<HelpArticleMeta, 'title'>): string =>
  `What does "${article.title.trim().replace(/[.?]$/u, '')}" mean?`;

const FALLBACK_QUESTIONS = [
  'How do I add a second machine?',
  'Which engines can run on a Linux server?',
  'Why is my session waiting?',
];

/**
 * Three questions from the page and its errors: an error the page shows first (an offline machine by its name), then
 * the page's own articles, then the questions anybody starts with.
 */
export function suggestedQuestions(input: {
  errors: readonly string[];
  articles: readonly HelpArticleMeta[];
  pageArticles: readonly HelpArticleMeta[];
  offlineMachine: string | null;
}): string[] {
  const out: string[] = [];
  const add = (q: string | null) => {
    if (q && out.length < 3 && !out.includes(q)) out.push(q);
  };
  for (const error of input.errors) {
    // An offline machine is asked about by its name; any other error by what its article calls it.
    if (error === 'runner.offline' && input.offlineMachine) {
      add(`Why is ${input.offlineMachine} offline?`);
      continue;
    }
    const article = input.articles.find((a) => a.errors.includes(error));
    if (article) add(errorQuestionFor(article));
  }
  for (const article of input.pageArticles) add(questionFor(article));
  for (const q of FALLBACK_QUESTIONS) add(q);
  return out;
}

// ── an answer (board 02 ②) ───────────────────────────────────────────────────────────────────────────────────────

export interface AskSource {
  n: number;
  title: string;
  /** The article's path on the web, `/help/<category>/<slug>`. */
  path: string;
  slug: string;
}

export interface AskLinkButton {
  label: string;
  /** The `orbit:/…` link as written. */
  href: string;
}

export interface ParsedAnswer {
  /** The answer's Markdown without its source list, `[n]` turned into `[n](cite:n)` links and app links into words. */
  body: string;
  sources: AskSource[];
  buttons: AskLinkButton[];
}

const SOURCES_HEADING = /^\s*(?:#+\s*)?\**sources:?\**\s*$/iu;
const SOURCE_LINE = /^\s*(?:[-*]\s*)?\[(\d{1,2})\]:?\s*\[([^\]]+)\]\((orbit:\/help\/[^)\s]+)\)/u;
const APP_LINK = /\[([^\]]+)\]\((orbit:\/(?!help\/)[^)\s]*)\)/gu;

/**
 * An Ask's answer as the drawer draws it: the source list after "Sources:" read into rows, `[n]` in the text made
 * chips that open source n, and every in-app `orbit:/…` link collected into the buttons under the answer — its words
 * stay in the sentence.
 */
export function parseAnswer(text: string): ParsedAnswer {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  const sources: AskSource[] = [];
  let end = lines.length;
  const heading = lines.findIndex((line) => SOURCES_HEADING.test(line));
  const sourceLines = heading >= 0 ? lines.slice(heading + 1) : [];
  if (heading >= 0) end = heading;
  // A list written with no heading still reads as one when it closes the answer.
  if (heading < 0) {
    let i = lines.length - 1;
    while (i >= 0 && (lines[i].trim() === '' || SOURCE_LINE.test(lines[i]))) i -= 1;
    if (i < lines.length - 1 && lines.slice(i + 1).some((l) => SOURCE_LINE.test(l))) {
      sourceLines.push(...lines.slice(i + 1));
      end = i + 1;
    }
  }
  for (const line of sourceLines) {
    const m = line.match(SOURCE_LINE);
    if (!m) continue;
    const path = helpArticleLink(m[3]);
    if (!path) continue;
    sources.push({ n: Number(m[1]), title: m[2].trim(), path, slug: path.split('/').pop() ?? '' });
  }
  const buttons: AskLinkButton[] = [];
  // A line that is nothing but in-app links is said by the buttons below the answer, so it leaves the body.
  const linksAlone = (line: string) => APP_LINK.test(line) && line.replace(APP_LINK, '').replace(/[\s·•|,-]/gu, '') === '';
  let body = lines
    .slice(0, end)
    .flatMap((line) => {
      APP_LINK.lastIndex = 0;
      if (!linksAlone(line)) return [line];
      for (const [, label, href] of line.matchAll(APP_LINK)) {
        if (!buttons.some((b) => b.href === href)) buttons.push({ label: label.trim(), href });
      }
      return [];
    })
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd();
  APP_LINK.lastIndex = 0;
  body = body.replace(APP_LINK, (_all, label: string, href: string) => {
    if (!buttons.some((b) => b.href === href)) buttons.push({ label: label.trim(), href });
    return label;
  });
  const known = new Set(sources.map((s) => s.n));
  // `[1][2]` is two citations, not a reference-style link: set them apart so each becomes a chip.
  body = body.replace(/\[(\d{1,2})\](?=\[\d{1,2}\])/gu, '[$1] ');
  // `[n]` not already a link or a reference definition: a chip, when the list names n.
  body = body.replace(/\[(\d{1,2})\](?![(:[])/gu, (all, n: string) => (known.has(Number(n)) ? `[${n}](cite:${n})` : all));
  return { body, sources, buttons };
}

/** Whether a Markdown link is a citation chip made by parseAnswer. */
export const citationOf = (href: string | undefined): number | null =>
  href?.startsWith('cite:') ? Number(href.slice('cite:'.length)) || null : null;

export const isOrbitLink = (href: string | undefined): boolean => !!href?.startsWith(ORBIT_LINK_PREFIX);

// ── one exchange of the conversation ─────────────────────────────────────────────────────────────────────────────

export interface AskToolCall {
  name: string;
  /** What it was about: the article it read, the pattern it searched for, the state it checked. */
  about: string;
}

export interface AskExchange {
  question: string;
  seq: number;
  tools: AskToolCall[];
  /** The last thing the engine said in this exchange. */
  answer: string;
  answerSeq: number | null;
  error: string | null;
}

const READS: Record<string, string> = {
  help_machines: 'machines',
  help_sessions: 'sessions',
  help_tasks: 'tasks',
  help_quota: 'quota',
};

/** An MCP tool's name without its server prefix (`mcp__orbit__help_machines` is `help_machines`). */
const bareToolName = (name: string) => name.replace(/^mcp__[^_]+__/u, '');

function toolCallOf(name: string, input: unknown): AskToolCall {
  const bare = bareToolName(name);
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (READS[bare]) return { name: bare, about: READS[bare] };
  const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : '';
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  return { name: bare, about: path ? path.split('/').slice(-2).join('/') : pattern };
}

/** The conversation as exchanges: each question, what was looked at, and the answer. */
export function askExchanges(events: readonly RunEvent[]): AskExchange[] {
  const out: AskExchange[] = [];
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type === 'user' && typeof p.text === 'string' && !p.steer && !p.parentToolUseId) {
      out.push({ question: p.text, seq: ev.seq, tools: [], answer: '', answerSeq: null, error: null });
      continue;
    }
    const current = out[out.length - 1];
    if (!current || p.parentToolUseId) continue;
    if (ev.type === 'tool_use') current.tools.push(toolCallOf(String(p.name ?? ''), p.input));
    else if (ev.type === 'assistant' && typeof p.text === 'string' && p.text.trim()) {
      current.answer = p.text;
      current.answerSeq = ev.seq;
    } else if (ev.type === 'error' && typeof p.message === 'string') current.error = p.message;
  }
  return out;
}

/** The collapsed line under a question (board 02 ②①): "Read 2 articles · Checked build-box". */
export function toolLine(tools: readonly AskToolCall[]): string {
  const articles = new Set(
    tools.filter((t) => t.name === 'Read' && /\.md$/u.test(t.about) && !/INDEX\.md$/u.test(t.about)).map((t) => t.about),
  );
  const searched = tools.some((t) => t.name === 'Grep' || t.name === 'Glob');
  const checked = [...new Set(tools.filter((t) => READS[t.name]).map((t) => READS[t.name]))];
  const parts: string[] = [];
  if (searched && articles.size === 0) parts.push('Searched the articles');
  if (articles.size > 0) parts.push(`Read ${articles.size} article${articles.size === 1 ? '' : 's'}`);
  if (checked.length > 0) parts.push(`Checked ${checked.join(', ')}`);
  return parts.join(' · ');
}

/** The page chip: where the person is, by what the board calls it ("Settings → Machines"). */
export function askPage(pathname: string, label: string, errors: readonly string[]): HelpAskPage {
  return { route: pathname, label, errors: [...errors].slice(0, 10) };
}
