import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Allow, IsOptional } from 'class-validator';
import {
  uuidToBase62,
  WIKI_IMPORT_RULES,
  WIKI_NOTE_READ_BY,
  WIKI_NOTE_RULES,
  type WikiFieldError,
} from '@orbit/shared';
import { sha256 } from '../common/crypto.util';
import { IsPublicId } from '../common/public-id';
import { redactSecrets } from '../common/secret-redaction';
import { PrismaService } from '../prisma/prisma.service';
import { looksLikeProbe, WikiRefusalError, WikiService, type WikiPrincipal } from './wiki.service';

/**
 * `orbit wiki import`'s half of the server (contracts/wiki.contract.json `import`, criterion 1): the
 * file an import reads becomes a `note` — the source every entry proposed from it cites — and the
 * entries themselves are proposed with origin `import` through the one write entry point.
 *
 * ONLY THE REDACTED TEXT IS KEPT (hard constraint 4). The runner sends the file as it read it; the
 * shared redactor takes out every credential shape it knows and the owner's own `workspace.env`
 * values before anything is hashed or stored, and the stored text is what the server's import job
 * hands the System model. A quote the model copies is then checked (`sourceText`) against the very
 * text it read, and the text as it was sent is never written anywhere.
 *
 * ONE CONTENT IS ONE NOTE IN A SPACE. The note is keyed by the sha256 of its redacted text (UNIQUE
 * (space_id, content_sha256), migration 0316): importing the same file again, or the same text under
 * another name, answers the note already there and writes nothing.
 *
 * A SESSION'S NOTE IS ONE TOO (`wiki_note`, contract `agentSurface.note`, docs/wiki-memory-claims-design.md section 4). It
 * is written through the same door, so it is redacted and kept the same way, and it remembers the session that wrote
 * it (migration 0472). It is a claim, not knowledge: the maintenance run reads it back against that session's records
 * (`loadDossierRecords`), and nothing else reads it. It is no op and takes no place in the review queue.
 */

/** POST /api/runner/wiki/spaces/:id/notes. `@Allow()`d and checked below, so a refusal names its field. */
export class WikiNoteDto {
  @Allow()
  path?: unknown;

  @Allow()
  text?: unknown;

  /** `server` from a command whose notes the server reads (contract `import.server`); absent otherwise. */
  @Allow()
  readBy?: unknown;
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
  /** The stored, redacted text, for the server's own callers: the runner door's answer leaves it out (contract `import.note.answer`). */
  text: string;
  /** The session whose `wiki_note` this is, for the server's own callers; null for an imported file. */
  sessionId: string | null;
}

const NOTE_SELECT = {
  id: true,
  spaceId: true,
  path: true,
  text: true,
  contentSha256: true,
  redacted: true,
  sessionId: true,
} satisfies Prisma.WikiNoteSelect;

type NoteRow = Prisma.WikiNoteGetPayload<{ select: typeof NOTE_SELECT }>;

const lengthOf = (value: string): number => [...value].length;

/** The principal an import writes as: the calling session, origin `import` (contract `import.propose.origin`). */
export function wikiImportPrincipal(ownerId: string, sessionId: string): WikiPrincipal {
  return { origin: 'import', ownerId, userId: null, sessionId, toolCallId: null };
}

/**
 * Register one file as a note of the space: redacted, hashed, and written unless the space already
 * holds the same text. Another owner's space is the plain 404 `requireSpace` answers. With `sessionId` the note is that
 * session's, which may write `WIKI_NOTE_RULES.perSession` of them: a text the space already holds is not one more.
 */
export async function registerWikiNote(
  prisma: PrismaService,
  wiki: WikiService,
  ownerId: string,
  spaceId: string,
  input: WikiNoteDto,
  sessionId: string | null = null,
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
  // Read and not locked: two notes of one session at once can pass the limit by one, and nothing counts on it exactly.
  if (sessionId !== null && (await prisma.wikiNote.count({ where: { ownerId, sessionId } })) >= WIKI_NOTE_RULES.perSession) {
    throw new WikiRefusalError({
      code: 'WIKI_QUOTA',
      message: `a session writes at most ${WIKI_NOTE_RULES.perSession} notes, and this one has: tell the wiki what matters most, and leave the rest`,
    });
  }
  try {
    const created = await prisma.wikiNote.create({
      data: { spaceId: space.id, ownerId, path: path.text, text: text.text, contentSha256, redacted: text.redacted || path.redacted, sessionId },
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
    sessionId: row.sessionId,
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

/** POST /api/runner/wiki/notes (contract `agentSurface.note`). `@Allow()`d and checked below, so a refusal names its field. */
export class WikiSessionNoteDto {
  @Allow()
  text?: unknown;

  @Allow()
  paths?: unknown;

  /** The entry this says is wrong: an id as a client shows it, or its UUID. */
  @IsOptional()
  @IsPublicId()
  corrects?: string;
}

/** What became of a note's `corrects`, read from the op's own answer. */
export interface WikiNoteChallenge {
  status: string;
  changesetId?: string | null;
  opId?: string | null;
  entryId?: string | null;
  /** Why it was not flagged. The note was kept all the same: asking again with the right id writes no second one. */
  reasons?: Array<{ code?: string; message: string }>;
}

/** What a session's note answers (contract `agentSurface.note.answer`). */
export interface WikiSessionNoteAnswer {
  noted: true;
  noteId: string;
  created: boolean;
  readBy: string;
  challenged?: WikiNoteChallenge;
}

/** What a session's note says, held to the rules, with every field that failed named. */
function sessionNoteOf(input: WikiSessionNoteDto): { text: string; paths: string[] } {
  const errors: WikiFieldError[] = [];
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text === '') errors.push({ path: 'text', message: 'is required: one claim, in one or two sentences' });
  else if (lengthOf(text) > WIKI_NOTE_RULES.textMaxChars) {
    errors.push({ path: 'text', message: `must be at most ${WIKI_NOTE_RULES.textMaxChars} characters` });
  }
  const given = input.paths ?? [];
  if (!Array.isArray(given) || given.length > WIKI_NOTE_RULES.pathsMax) {
    errors.push({ path: 'paths', message: `must be a list of at most ${WIKI_NOTE_RULES.pathsMax} paths` });
  }
  const paths = Array.isArray(given) ? given.map((path) => (typeof path === 'string' ? path.trim() : '')) : [];
  paths.forEach((path, i) => {
    if (path === '') errors.push({ path: `paths[${i}]`, message: 'must be a repo-relative path' });
    else if (lengthOf(path) > WIKI_NOTE_RULES.pathMaxChars) {
      errors.push({ path: `paths[${i}]`, message: `must be at most ${WIKI_NOTE_RULES.pathMaxChars} characters` });
    }
  });
  if (errors.length > 0) throw schemaRefusal('the note does not have the shape this contract gives it', errors);
  // In one order, so that the same paths are the same content.
  return { text, paths: [...new Set(paths)].sort() };
}

/**
 * A session tells the wiki something (`wiki_note`): kept as a note of its space, to be read against the session's records
 * by the next maintenance run. With `corrects` the entry it names is also flagged at once, through the one write entry
 * point, as any challenge is: what comes of that is told apart from the note, which is kept whichever way it goes.
 */
export async function writeSessionNote(
  prisma: PrismaService,
  wiki: WikiService,
  principal: WikiPrincipal & { sessionId: string },
  spaceId: string,
  input: WikiSessionNoteDto,
): Promise<WikiSessionNoteAnswer> {
  const { ownerId, sessionId } = principal;
  const { text, paths } = sessionNoteOf(input);
  if (looksLikeProbe(text, [text])) {
    throw new WikiRefusalError({
      code: 'WIKI_PROBE_REFUSED',
      message: 'this reads as a tool probe rather than as something a reader should know: the tool works and the call was '
        + 'received — do not retry it, and note something a reader could not get from the code.',
    });
  }
  const note = await registerWikiNote(prisma, wiki, ownerId, spaceId, {
    path: `session/${uuidToBase62(sessionId)}`,
    text: paths.length > 0 ? `${text}\nPaths: ${paths.join(', ')}` : text,
  }, sessionId);
  const { settings } = await wiki.requireSpace(ownerId, spaceId);
  const readBy = note.sessionId !== sessionId
    ? WIKI_NOTE_READ_BY.elsewhere
    : settings.maintenance.enabled ? WIKI_NOTE_READ_BY.nextRun : WIKI_NOTE_READ_BY.noRun;
  return {
    noted: true,
    noteId: note.id,
    created: note.created,
    readBy,
    ...(input.corrects ? { challenged: await challengeForNote(wiki, principal, spaceId, input.corrects, note.id, text) } : {}),
  };
}

/** The challenge a note's `corrects` files: under a key of the note's, so that a retry is the same challenge. */
async function challengeForNote(
  wiki: WikiService,
  principal: WikiPrincipal,
  spaceId: string,
  entryId: string,
  noteId: string,
  reason: string,
): Promise<WikiNoteChallenge> {
  try {
    const answer = await wiki.submitChangeset(principal, spaceId, {
      ops: [{ op: 'challenge', entryId, reason }],
      rationale: 'A session said this entry is wrong (wiki_note, corrects).',
      idempotencyKey: `wiki-note:${noteId}:${entryId}`,
    });
    const [op] = answer.ops as Array<WikiNoteChallenge & { seq: number }>;
    return {
      status: op.status,
      changesetId: answer.changesetId as string | null,
      opId: op.opId ?? null,
      entryId: op.entryId ?? null,
      ...(op.reasons ? { reasons: op.reasons } : {}),
    };
  } catch (error) {
    // An entry this session may not read is answered as one that does not exist (`refusalRules.notFound`).
    if (!(error instanceof HttpException)) throw error;
    const said = error.getResponse();
    const { code, message } = (typeof said === 'object' ? said : { message: said }) as { code?: string; message?: unknown };
    return { status: 'refused', reasons: [{ ...(code ? { code } : {}), message: String(message ?? error.message) }] };
  }
}

function schemaRefusal(message: string, errors: WikiFieldError[]): WikiRefusalError {
  return new WikiRefusalError({ code: 'WIKI_SCHEMA', message, errors });
}
