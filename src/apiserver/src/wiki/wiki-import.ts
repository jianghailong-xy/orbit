import { Prisma } from '@prisma/client';
import { Allow } from 'class-validator';
import { WIKI_IMPORT_RULES, type WikiFieldError } from '@orbit/shared';
import { sha256 } from '../common/crypto.util';
import { redactSecrets } from '../common/secret-redaction';
import { PrismaService } from '../prisma/prisma.service';
import { WikiRefusalError, WikiService, type WikiPrincipal } from './wiki.service';

/**
 * `orbit wiki import`'s half of the server (contracts/wiki.contract.json `import`, criterion 1): the
 * file an import reads becomes a `note` — the source every entry proposed from it cites — and the
 * entries themselves are proposed with origin `import` through the one write entry point.
 *
 * ONLY THE REDACTED TEXT IS KEPT (hard constraint 4). The runner sends the file as it read it; the
 * shared redactor takes out every credential shape it knows and the owner's own `workspace.env`
 * values before anything is hashed or stored, and the answer hands back the stored text, which is
 * what the runner gives its model. A quote the model copies is then checked (`sourceText`) against
 * the very text it read, and the text as it was sent is never written anywhere.
 *
 * ONE CONTENT IS ONE NOTE IN A SPACE. The note is keyed by the sha256 of its redacted text (UNIQUE
 * (space_id, content_sha256), migration 0316): importing the same file again, or the same text under
 * another name, answers the note already there and writes nothing.
 */

/** POST /api/runner/wiki/spaces/:id/notes. `@Allow()`d and checked below, so a refusal names its field. */
export class WikiNoteDto {
  @Allow()
  path?: unknown;

  @Allow()
  text?: unknown;
}

/** What registering a note answers (contract `import.note.answer`). */
export interface WikiNoteAnswer {
  id: string;
  spaceId: string;
  path: string;
  contentSha256: string;
  /** The stored text's length, in the characters its CHECK counts. */
  chars: number;
  /** Whether the redactor took anything out of the text or the path. */
  redacted: boolean;
  /** False when the space already held this text: nothing was written. */
  created: boolean;
  /** The stored, redacted text: what the importer hands its model. */
  text: string;
}

const NOTE_SELECT = {
  id: true,
  spaceId: true,
  path: true,
  text: true,
  contentSha256: true,
  redacted: true,
} satisfies Prisma.WikiNoteSelect;

type NoteRow = Prisma.WikiNoteGetPayload<{ select: typeof NOTE_SELECT }>;

const lengthOf = (value: string): number => [...value].length;

/** The principal an import writes as: the calling session, origin `import` (contract `import.propose.origin`). */
export function wikiImportPrincipal(ownerId: string, sessionId: string): WikiPrincipal {
  return { origin: 'import', ownerId, userId: null, sessionId, toolCallId: null };
}

/**
 * Register one file as a note of the space: redacted, hashed, and written unless the space already
 * holds the same text. Another owner's space is the plain 404 `requireSpace` answers.
 */
export async function registerWikiNote(
  prisma: PrismaService,
  wiki: WikiService,
  ownerId: string,
  spaceId: string,
  input: WikiNoteDto,
): Promise<WikiNoteAnswer> {
  const space = await wiki.requireSpace(ownerId, spaceId);
  const shape = noteErrors(input.path, input.text);
  if (shape.length > 0) throw schemaRefusal('the note does not have the shape this contract gives it', shape);
  const literals = await wiki.envLiterals(prisma, ownerId);
  // One line ending, so the same file is one text whichever machine it was read on.
  const text = redactSecrets((input.text as string).replace(/\r\n?/gu, '\n'), { literals });
  const path = redactSecrets((input.path as string).trim(), { literals });
  // `[redacted]` is longer than a short value it replaces: held to the limits again, as stored.
  const stored = noteErrors(path.text, text.text);
  if (stored.length > 0) throw schemaRefusal('redaction pushed the note past its limit: import it in parts', stored);
  const contentSha256 = sha256(text.text);
  const where = { spaceId: space.id, ownerId, contentSha256 };
  const existing = await prisma.wikiNote.findFirst({ where, select: NOTE_SELECT });
  if (existing) return answer(existing, false);
  try {
    const created = await prisma.wikiNote.create({
      data: { spaceId: space.id, ownerId, path: path.text, text: text.text, contentSha256, redacted: text.redacted || path.redacted },
      select: NOTE_SELECT,
    });
    return answer(created, true);
  } catch (error) {
    // Two imports of the same text at once: the unique index let one row in, and that row is the answer.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    return answer(await prisma.wikiNote.findFirstOrThrow({ where, select: NOTE_SELECT }), false);
  }
}

function answer(row: NoteRow, created: boolean): WikiNoteAnswer {
  return {
    id: row.id,
    spaceId: row.spaceId,
    path: row.path,
    contentSha256: row.contentSha256,
    chars: lengthOf(row.text),
    redacted: row.redacted,
    created,
    text: row.text,
  };
}

function noteErrors(path: unknown, text: unknown): WikiFieldError[] {
  const errors: WikiFieldError[] = [];
  const check = (value: unknown, name: string, max: number): void => {
    if (typeof value !== 'string' || value.trim() === '') errors.push({ path: name, message: 'is required' });
    else if (lengthOf(value) > max) errors.push({ path: name, message: `must be at most ${max} characters` });
  };
  check(path, 'path', WIKI_IMPORT_RULES.notePathMaxChars);
  check(text, 'text', WIKI_IMPORT_RULES.noteMaxChars);
  return errors;
}

function schemaRefusal(message: string, errors: WikiFieldError[]): WikiRefusalError {
  return new WikiRefusalError({ code: 'WIKI_SCHEMA', message, errors });
}
