import { queryOptions } from '@tanstack/react-query';
import type { HelpAskAdminResult, HelpAskStuck } from '@orbit/shared';
import { api } from '../../api';
import { parseAnswer } from './helpAsk';

// Still stuck (docs/mocks/help-center board 02 ② right frame, side note 5): what the card reads, Ask your admin, and
// the GitHub report — whose body is built by reportBody alone, so what it may and may not carry is tested in one place.

/** GET /api/help/ask/:id/stuck. */
export const helpAskStuckQuery = (askId: string) =>
  queryOptions({
    queryKey: ['help', 'ask', 'stuck', askId] as const,
    meta: { entities: ['workspace'] },
    queryFn: () => api<HelpAskStuck>(`/help/ask/${askId}/stuck`),
  });

/** POST /api/help/ask/:id/admin: the conversation, as the server holds it, as a task in an admin's own list. */
export const askYourAdmin = (askId: string) =>
  api<HelpAskAdminResult>(`/help/ask/${askId}/admin`, { method: 'POST' });

/** An answer as words a person reads outside Orbit: no source list, `[n](cite:n)` back to `[n]`. */
export function answerText(answer: string): string {
  return parseAnswer(answer).body.replace(/\[(\d{1,2})\]\(cite:\d{1,2}\)/gu, '[$1]').trim();
}

// ── what a report never carries ─────────────────────────────────────────────────────────────────────────────────

const KEY = '[key removed]';

/** Secrets by their shape: provider keys, tokens, private keys, and anything assigned to a name that says it is one. */
const KEY_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
  /\bglpat-[A-Za-z0-9_-]{16,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{30,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\b[A-Fa-f0-9]{32,}\b/gu,
];
/**
 * A long run of base64 is a key when it reads like one — digits, capitals and small letters mixed — and not when it
 * is an article's path such as `help/machines-and-engines/a-machine-shows-offline`.
 */
const BASE64_RUN = /[A-Za-z0-9+/_=-]{32,}/gu;
const looksRandom = (run: string) =>
  (run.match(/\d/gu)?.length ?? 0) >= 3 && (run.match(/[A-Z]/gu)?.length ?? 0) >= 3 && (run.match(/[a-z]/gu)?.length ?? 0) >= 3;
/** `API_KEY=…`, `token: "…"`: the name stays, a value that reads like a secret (a digit in it, or quoted) goes. */
const NAMED_SECRET = /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;

/** A fenced block or an indented one is a file's contents or a command's output: neither goes in a report. */
const FENCED = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/gu;
const INDENTED = /(^|\n[ \t]*\n)((?:(?: {4}|\t)[^\n]*(?:\n|$))+)/gu;

/** Repositories by their address: a git host's URL, an SSH remote, a `.git` URL anywhere. */
const REPO_URLS: RegExp[] = [
  /\b(?:https?:\/\/|git:\/\/|ssh:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|dev\.azure\.com)[/:][^\s)\]>"'`]+/giu,
  /\b[\w.-]+@[\w.-]+:[\w./-]+?(?:\.git)?(?=[\s)\]>"'`]|$)/gu,
  /\b(?:https?|ssh|git):\/\/[^\s)\]>"'`]+\.git\b/giu,
];
/** A folder on somebody's machine names their projects: home folders, server folders, Windows drives. */
const LOCAL_PATH = /(?:~|\b[A-Za-z]:)?(?:\/|\\)(?:home|Users|root|srv|opt|mnt|var|tmp|workspace|workspaces|data|projects|code|src)(?:[\\/][^\s)\]>"'`,;]+)+/gu;
const HOME_PATH = /(?<![\w/])~[\\/][^\s)\]>"'`,;]+/gu;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * The question or the answer as a report may carry it: code blocks, file paths, repository addresses, the person's
 * own workspace, folder and repository names, and keys all taken out, each said where it was.
 */
export function scrubForReport(text: string, privateNames: readonly string[] = []): string {
  let out = text.replace(/\r\n/gu, '\n');
  out = out.replace(FENCED, (_all, lead: string) => `${lead}[code block removed]`);
  out = out.replace(INDENTED, (_all, lead: string) => `${lead}[code block removed]\n`);
  for (const shape of KEY_SHAPES.slice(0, 1)) out = out.replace(shape, KEY);
  out = out.replace(BEARER, `Bearer ${KEY}`);
  out = out.replace(NAMED_SECRET, (all, name: string, sep: string, quote: string, value: string) =>
    quote || /\d/u.test(value) ? `${name}${sep}${KEY}` : all);
  for (const shape of REPO_URLS) out = out.replace(shape, '[repository removed]');
  out = out.replace(LOCAL_PATH, '[path removed]').replace(HOME_PATH, '[path removed]');
  for (const shape of KEY_SHAPES.slice(1)) out = out.replace(shape, KEY);
  out = out.replace(BASE64_RUN, (run) => (looksRandom(run) ? KEY : run));
  // Longest first, so `acme/shop-cli` goes before `shop-cli` would leave `acme/` behind.
  for (const name of [...privateNames].filter((n) => n.trim().length >= 3).sort((a, b) => b.length - a.length)) {
    const word = new RegExp(`(?<![\\w-])${escapeRegExp(name.trim())}(?![\\w-])`, 'giu');
    out = out.replace(word, '[name removed]');
  }
  return out.trim();
}

// ── the report ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReportInput {
  /** Orbit's version, as this client was built from it. */
  orbitVersion: string;
  /** `web`, `macos`, `ios`, `android`. */
  client: string;
  exchanges: { question: string; answer: string }[];
  /** The person's workspace, folder and repository names (HelpAskStuck.report.privateNames). */
  privateNames?: readonly string[];
}

/** How much of the conversation a report carries: a new-issue URL stays well under what GitHub and browsers take. */
const REPORT_TEXT_CHARS = 1_500;
const REPORT_EXCHANGES = 3;

const clip = (text: string, chars: number) => (text.length <= chars ? text : `${text.slice(0, chars - 1).trimEnd()}…`);

export const REPORT_NOT_INCLUDED = 'Not included: repository names, file contents, keys';

/**
 * The GitHub issue's body: Orbit's version and client, and the question and answer, scrubbed by scrubForReport. The one builder of a report; the card
 * shows exactly this text before it opens GitHub.
 */
export function reportBody(input: ReportInput): string {
  const lines = [
    '### Diagnostics',
    '',
    '```',
    `Orbit ${input.orbitVersion} · ${input.client}`,
    '```',
  ];
  const shown = input.exchanges.slice(-REPORT_EXCHANGES);
  shown.forEach((ex, i) => {
    const n = shown.length > 1 ? ` ${i + 1}` : '';
    lines.push(
      '',
      `### Question${n}`,
      '',
      clip(scrubForReport(ex.question, input.privateNames), REPORT_TEXT_CHARS),
      '',
      `### Answer${n}`,
      '',
      clip(scrubForReport(answerText(ex.answer), input.privateNames), REPORT_TEXT_CHARS) || '(no answer)',
    );
  });
  lines.push('', `_Sent from Orbit's help. ${REPORT_NOT_INCLUDED}._`);
  return lines.join('\n');
}

/** The issue's title: the first question, scrubbed, on one line. */
export function reportTitle(question: string, privateNames: readonly string[] = []): string {
  return clip(`Help: ${scrubForReport(question, privateNames).replace(/\s+/gu, ' ')}`, 120);
}

/** The new-issue URL on the repository the instance's release came from, title and body filled in. */
export function reportIssueUrl(repository: string, title: string, body: string): string {
  const params = new URLSearchParams({ title, body });
  return `https://github.com/${repository}/issues/new?${params.toString()}`;
}
