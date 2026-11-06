import { BadRequestException } from '@nestjs/common';
import { wikiChatContextErrors, type WikiChatContext } from '@orbit/shared';

/**
 * The page and the selection a wiki chat's message carries (contract `chat.notes.wikiContext`), as the doors
 * that take one read it: the chat's create, and the session's own message door for its later messages.
 *
 * Small and free of the wiki service on purpose: the session doors import it, and the wiki service is a module
 * the sessions module does not otherwise reach.
 */

/**
 * A message's wikiContext, or null when it carries none. Anything wikiChatContextErrors names a path of is
 * refused WIKI_SCHEMA with those paths, before anything is filed (contract `chat.notes.wikiContext.check`) — the
 * answer the wiki's own refusal of that code gives, 400 with `{ code, message, errors }`. One holding neither a
 * page nor a selection carries nothing, and is null too.
 */
export function readWikiChatContext(value: unknown): WikiChatContext | null {
  if (value === undefined || value === null) return null;
  const paths = wikiChatContextErrors(value);
  if (paths.length > 0) {
    throw new BadRequestException({
      code: 'WIKI_SCHEMA',
      message: 'wikiContext is { page?, selection? }: a page of a document, an entry or the plan, and at most '
        + 'twenty sentences of one document, each once',
      errors: paths.map((path) => ({ path, message: 'is not what a wiki chat message carries here' })),
    });
  }
  const context = value as WikiChatContext;
  return context.page === undefined && context.selection === undefined ? null : context;
}

/** A message carrying a wikiContext to a session that is no chat (contract `chat.turns`): 400, nothing filed. */
export function wikiContextOutsideChat(): BadRequestException {
  return new BadRequestException(
    'wikiContext rides only on a message to a wiki chat, and this session is not one: send the message without it',
  );
}

/** JSON with every object's keys sorted, so a context read back from jsonb compares with the one a request sent. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Whether a replayed clientTurnId carries the context its turn was filed with (absent and null are one). */
export function sameWikiChatContext(stored: unknown, sent: WikiChatContext | null): boolean {
  return canonical(stored ?? null) === canonical(sent);
}
