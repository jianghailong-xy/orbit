import { ConflictException, NotFoundException } from '@nestjs/common';
import { Allow } from 'class-validator';
import {
  toUuid,
  WIKI_IMPORT_JOB,
  WIKI_IMPORT_RULES,
  type WikiFieldError,
  type WikiSystemModelReadState,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { currentWikiExecutorSwitch, wikiExecutorServes } from './wiki-executor-switch';
import { WikiSystemModelReads } from './wiki-system-model';
import { WikiRefusalError, type WikiService } from './wiki.service';

/**
 * `orbit wiki import` on the server (contracts/wiki.contract.json `import.server`, design §2.2, P5): the runner
 * door's half of it. The command still reads the files and registers each as a note (`import.note`); when the
 * executor switch gives its account to the server it then hands the notes to an `import` job here instead of a
 * model of its own, and waits for the job's report — what the wiki-worker read, found and proposed
 * (src/apiserver/src/wiki-worker/wiki-import-job.ts).
 *
 * THREE ROUTES, ALL THE CALLING SESSION'S OWNER'S:
 *   GET  …/spaces/:id/import            which path an import of this space takes — the server's, or the
 *                                       runner's own (the switch; the System model's name and state)
 *   POST …/spaces/:id/import-jobs       the notes, as a job; the command names the job's id, so a request sent
 *                                       again after a lost answer is the same job and not a second one
 *   GET  …/spaces/:id/import-jobs/:jobId  the job: where it is, and its report once it has one
 *
 * A job is made only for an account the switch gives the server: under `runner` the command reads with its own
 * model exactly as it always has, and a job nobody would run is refused rather than queued.
 */

/** Which path an import takes (`import.server.executor`). */
export interface WikiImportExecutor {
  executor: 'server' | 'runner';
  /** The System model's name and state; null and the state the read says when it is not known. */
  model: string | null;
  modelState: WikiSystemModelReadState;
}

/** POST …/import-jobs. `@Allow()`d and checked below, so a refusal names its field. */
export class WikiImportJobDto {
  @Allow()
  id?: unknown;

  @Allow()
  maxOps?: unknown;

  @Allow()
  concurrency?: unknown;

  @Allow()
  checkoutRoot?: unknown;

  @Allow()
  notes?: unknown;
}

/** One import job as the command reads it (`import.server.read`). */
export interface WikiImportJobRead {
  id: string;
  spaceId: string;
  state: string;
  waitingFor: string | null;
  attempts: number;
  error: string | null;
  failureKind: string | null;
  progress: unknown;
  report: unknown;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** The System model the job reads with, so a command waiting on it can say why it waits. */
  model: { name: string | null; state: WikiSystemModelReadState };
}

/** Which path an import of this account takes, and the model the server would read with. */
export async function wikiImportExecutor(prisma: PrismaService, ownerId: string): Promise<WikiImportExecutor> {
  const server = wikiExecutorServes(currentWikiExecutorSwitch(), ownerId);
  const status = await new WikiSystemModelReads(prisma).read(new Date());
  return { executor: server ? 'server' : 'runner', model: status.model, modelState: status.state };
}

/**
 * Make the import job the command asked for, or answer the one it already made under that id. The notes must
 * be the space's own — a note is cited by what the job proposes, so one of another space is no note of this
 * import's — and the session is the one the changeset is recorded against, as the runner's proposal was.
 */
export async function createWikiImportJob(
  prisma: PrismaService,
  wiki: WikiService,
  input: { ownerId: string; spaceId: string; sessionId: string; body: WikiImportJobDto },
): Promise<WikiImportJobRead> {
  const space = await wiki.requireSpace(input.ownerId, input.spaceId);
  if (!wikiExecutorServes(currentWikiExecutorSwitch(), input.ownerId)) {
    throw new ConflictException(
      "this account's wiki runs on its runner (ORBIT_WIKI_EXECUTOR): orbit wiki import reads with the session's own model, "
        + 'and the server makes no import job for it',
    );
  }
  const job = importJobInput(input.body, input.sessionId);
  const held = await prisma.wikiNote.findMany({
    where: { ownerId: input.ownerId, spaceId: space.id, id: { in: job.notes.map((note) => note.noteId) } },
    select: { id: true },
  });
  const known = new Set(held.map((note) => note.id));
  const missing: WikiFieldError[] = job.notes.flatMap((note, i) =>
    known.has(note.noteId) ? [] : [{ path: `notes[${i}].noteId`, message: 'names no note of this space' }]);
  if (missing.length > 0) throw schemaRefusal('the import names notes this space does not hold', missing);
  await prisma.$executeRaw`
    INSERT INTO "wiki_job" ("id", "owner_id", "space_id", "kind", "input", "priority", "state")
    VALUES (${job.id}::uuid, ${input.ownerId}::uuid, ${space.id}::uuid, 'import',
            ${JSON.stringify(job.input)}::jsonb, ${WIKI_IMPORT_JOB.priority}, 'queued')
    ON CONFLICT ("id") DO NOTHING`;
  const made = await readImportJob(prisma, input.ownerId, space.id, job.id);
  if (!made) throw new ConflictException(`the id ${job.id} names another job: name a new one for this import`);
  return made;
}

/** One import job of the space, as the command waits on it. Another owner's, or another space's, is a 404. */
export async function readWikiImportJob(
  prisma: PrismaService,
  input: { ownerId: string; spaceId: string; jobId: string },
): Promise<WikiImportJobRead> {
  const read = await readImportJob(prisma, input.ownerId, input.spaceId, input.jobId);
  if (!read) throw new NotFoundException('no such import job');
  return read;
}

async function readImportJob(prisma: PrismaService, ownerId: string, spaceId: string, jobId: string): Promise<WikiImportJobRead | null> {
  const row = await prisma.wikiJob.findFirst({
    where: { id: jobId, ownerId, spaceId, kind: 'import' },
    select: {
      id: true, spaceId: true, state: true, waitingFor: true, attempts: true, error: true, failureKind: true,
      progress: true, report: true, createdAt: true, startedAt: true, endedAt: true,
    },
  });
  if (!row) return null;
  const model = await new WikiSystemModelReads(prisma).read(new Date());
  return {
    id: row.id,
    spaceId: row.spaceId,
    state: row.state,
    waitingFor: row.waitingFor,
    attempts: row.attempts,
    error: row.error,
    failureKind: row.failureKind,
    progress: row.progress,
    report: row.report,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    model: { name: model.model, state: model.state },
  };
}

/** The body as the job's input, or the refusal naming every field that is not as the contract gives it. */
function importJobInput(body: WikiImportJobDto, sessionId: string): { id: string; notes: Array<{ noteId: string }>; input: Record<string, unknown> } {
  const errors: WikiFieldError[] = [];
  const uuid = (value: unknown, path: string): string => {
    try {
      if (typeof value === 'string' && value.trim() !== '') return toUuid(value.trim());
    } catch {
      /* named below */
    }
    errors.push({ path, message: 'must be an id' });
    return '';
  };
  const whole = (value: unknown, path: string, min: number, max: number): number => {
    if (Number.isInteger(value) && (value as number) >= min && (value as number) <= max) return value as number;
    errors.push({ path, message: `must be a whole number from ${min} to ${max}` });
    return min;
  };
  const id = uuid(body?.id, 'id');
  const maxOps = whole(body?.maxOps, 'maxOps', 1, WIKI_IMPORT_RULES.opsPerRun);
  const concurrency = body?.concurrency === undefined
    ? WIKI_IMPORT_JOB.defaultConcurrency
    : whole(body.concurrency, 'concurrency', 1, WIKI_IMPORT_JOB.maxConcurrency);
  const checkoutRoot = typeof body?.checkoutRoot === 'string' ? body.checkoutRoot.trim() : '';
  if (body?.checkoutRoot !== undefined && typeof body.checkoutRoot !== 'string') errors.push({ path: 'checkoutRoot', message: 'must be a path' });
  const raw = Array.isArray(body?.notes) ? body.notes : null;
  if (!raw || raw.length === 0 || raw.length > WIKI_IMPORT_JOB.maxNotes) {
    errors.push({ path: 'notes', message: `must hold 1 to ${WIKI_IMPORT_JOB.maxNotes} notes` });
  }
  const seen = new Set<string>();
  const notes = (raw ?? []).map((value: unknown, i: number) => {
    const note = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const noteId = uuid(note.noteId, `notes[${i}].noteId`);
    if (noteId !== '' && seen.has(noteId)) errors.push({ path: `notes[${i}].noteId`, message: 'names a note already named' });
    seen.add(noteId);
    if (typeof note.file !== 'string' || note.file.trim() === '' || [...note.file].length > WIKI_IMPORT_RULES.notePathMaxChars) {
      errors.push({ path: `notes[${i}].file`, message: `must be a path of at most ${WIKI_IMPORT_RULES.notePathMaxChars} characters` });
    }
    if (typeof note.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(note.date)) {
      errors.push({ path: `notes[${i}].date`, message: 'must be a date, YYYY-MM-DD' });
    }
    let ops: Array<{ index: number; body: Record<string, unknown> }> | undefined;
    if (note.ops !== undefined) {
      const given = Array.isArray(note.ops) ? note.ops : null;
      if (!given || given.length > WIKI_IMPORT_RULES.entriesPerNote) {
        errors.push({ path: `notes[${i}].ops`, message: `must hold at most ${WIKI_IMPORT_RULES.entriesPerNote} ops` });
      }
      ops = (given ?? []).map((op: unknown, j: number) => {
        const one = (op !== null && typeof op === 'object' ? op : {}) as Record<string, unknown>;
        if (!Number.isInteger(one.index) || (one.index as number) < 0) {
          errors.push({ path: `notes[${i}].ops[${j}].index`, message: 'must be a whole number' });
        }
        if (one.body === null || typeof one.body !== 'object' || Array.isArray(one.body)) {
          errors.push({ path: `notes[${i}].ops[${j}].body`, message: 'must be an op' });
        }
        return { index: one.index as number, body: one.body as Record<string, unknown> };
      });
    }
    return { noteId, file: typeof note.file === 'string' ? note.file : '', date: note.date as string, ...(ops ? { ops } : {}) };
  });
  if (errors.length > 0) throw schemaRefusal('the import job does not have the shape this contract gives it', errors);
  return { id, notes, input: { sessionId, maxOps, concurrency, checkoutRoot, notes } };
}

function schemaRefusal(message: string, errors: WikiFieldError[]): WikiRefusalError {
  return new WikiRefusalError({ code: 'WIKI_SCHEMA', message, errors });
}
