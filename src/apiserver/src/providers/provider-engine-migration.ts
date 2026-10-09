/**
 * The provider/engine split's data migration (docs/provider-engine-contract.md §7.2–§7.6), run by the API
 * server when it starts (provider-engine-migration.module.ts) because deciding a merge means comparing
 * decrypted keys.
 *
 *  1. Every `deepseek-harness` row (runtime `dsh`) becomes a DeepSeek key. It is MERGED into the same
 *     owner's DeepSeek key when both are enabled and hold the same key (trimmed) on the same endpoint
 *     (scheme and host lowercased, trailing slashes dropped) — its references move to that key and the
 *     row is deleted — and otherwise CONVERTED where it stands: preset `deepseek`, Anthropic's protocol,
 *     the preset's models, enabled or not as it was, a vendor label in place of "DeepSeek Harness", and a
 *     `deepseek` slug. Either way its old slug becomes a retired name (provider_slug_alias, 0415) that
 *     resolves to the key on DeepSeek Harness, so whatever still names it — a receipt, a route decision,
 *     an older client — gets what it got before.
 *  2. What names the old slug is rewritten to the key's own, in the same transaction: sessions (their
 *     engine kept, recorded as `dsh` where an older replica left none), task pins (the engine pin with
 *     them), `User.preferences.defaultModels`, a Wiki maintenance setting, a workspace's
 *     `providerFallbacks`, and the old OpenCode spelling naming it. History — receipts, route decisions,
 *     run events, agents — is left as written: it reads through the retired name.
 *  3. On the full scan only: the old OpenCode spelling (`provider: opencode`, `model: orbit-<slug>/<model>`)
 *     becomes the key on OpenCode with the bare model, in sessions, task pins and preferences; and a
 *     built-in `dsh` session moves onto its owner's first enabled DeepSeek key — unless its workspace
 *     holds its own ORBIT_DSH_API_KEY, which it has always run on and keeps (§3.3).
 *
 * It is idempotent: every step is conditioned on the state it changes, so a run with nothing left to do
 * changes nothing. One run at a time, across replicas: a session-level advisory lock on a connection of
 * its own, held for the whole run, so a second replica starting beside the first waits for it and then
 * finds the completion marker. One transaction per owner, taking its locks in the canonical order
 * (common/lock-order.ts); a rewrite whose row changed under it is SKIPPED_CHANGED, retried in a later
 * pass, and keeps the marker from being written while any is left. After the marker, a start still folds
 * the `deepseek-harness` rows an older replica made since; nothing else.
 *
 * Every row it touches is reported (provider_engine_migration_report, and the log) with its values before
 * and after — never key material — and every session it touches is resolved as dispatch would build it,
 * before and after (provider-engine-resolution.ts): engine, key fingerprint, endpoint, model and runtime id
 * stay the same. A rehearsal runs the same code in one transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  AgentProvider,
  credentialEngines,
  isDeepSeekKey,
  isEngineCompatible,
  openCodeKeyModel,
  openCodeKeyOf,
  providerPreset,
} from '@orbit/shared';
import { Prisma, type ModelProvider, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { keyCredential, usableProviderSql } from './custom-provider';
import { defaultDeepSeekKey, keyRowForSlug, taskPinCredential, workspaceHoldsDshKey } from './engine-provider';
import { catalogDefaultModel, catalogModels } from './model-catalog';
import { decryptSecret } from './provider-crypto';
import {
  normalizedEndpoint,
  RESOLUTION_SELECT,
  resolutionOf,
  sameResolution,
  type SessionResolution,
} from './provider-engine-resolution';
import { pickFreeSlug } from './provider-slug';
import { sessionEnginesOf } from './session-engine';

/** The version a completion marker is written for. A later data migration of this kind is another. */
export const PROVIDER_ENGINE_MIGRATION_VERSION = 1;
/** The advisory lock every run holds (hashtextextended of this, seed 0). */
export const PROVIDER_ENGINE_MIGRATION_LOCK = 'provider-engine-migration';

const DEEPSEEK_PRESET = 'deepseek';
/** The label the retired Harness form filled in, which names an engine rather than the key. */
const HARNESS_LABEL = 'DeepSeek Harness';
const DEEPSEEK_LABEL = 'DeepSeek';
/** A slug already in DeepSeek's naming (`deepseek`, `deepseek-2`…), which a conversion keeps. */
const DEEPSEEK_SLUG = /^deepseek(?:-\d+)?$/;
/** The order keys are taken in when one has to be chosen (§3.3) — /providers lists them so too. */
const KEY_ORDER: Prisma.ModelProviderOrderByWithRelationInput[] = [
  { position: { sort: 'asc', nulls: 'last' } },
  { createdAt: 'asc' },
  { id: 'asc' },
];
/** Passes over the owners whose rewrites found a row changed under them. */
const PASSES = 3;
/** A slug another writer took between our pick and our write: the unit is re-run on a fresh pick. */
const SLUG_RACE_ATTEMPTS = 5;
/** One owner's transaction: decryption and a few hundred rows at most, never a long wait. */
const OWNER_TRANSACTION = { maxWait: 10_000, timeout: 120_000 };
const REHEARSAL_TRANSACTION = { maxWait: 10_000, timeout: 30 * 60_000 };
/** How long a start waits for another replica's run before it boots without one. */
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;

export type MigrationAction =
  | 'MERGED' | 'CONVERTED' | 'ALIASED' | 'REWRITTEN' | 'NOOP' | 'SKIPPED_CHANGED' | 'UNRESOLVED'
  | 'LEGACY_DSH_ENV_KEY' | 'LEGACY_DSH_NO_KEY'
  /** The backfill recorded the engine a session's init event names, not its key row's runtime (§7.1). */
  | 'INCONSISTENT'
  /** A session's resolution after the run, compared with the one before it. */
  | 'SAME' | 'CHANGED';

export type MigrationStep =
  /** T2's backfill, re-read (§7.1): sessions and pins it could not place, and init events it preferred. */
  | 'backfill'
  /** What must not move: account pool members and managed runners' initial providers (§7.3). */
  | 'check'
  /** A `deepseek-harness` row merged or converted, and its retired name. */
  | 'dsh-row'
  /** Something naming a folded row's old slug, rewritten to the key's own. */
  | 'reference'
  /** A built-in `dsh` session (§7.3). */
  | 'legacy-dsh'
  /** The old OpenCode spelling of a key (§7.4). */
  | 'opencode'
  /** A `defaultModels` key whose meaning changed (§7.5). */
  | 'preference'
  | 'resolution'
  /** After the run: an open session or task pin, a preference, a setting still naming a retired slug. */
  | 'alias-reference';

export interface ReportLine {
  step: MigrationStep;
  table: string;
  rowId: string | null;
  ownerId: string | null;
  action: MigrationAction;
  before?: unknown;
  after?: unknown;
  note?: string;
}

export interface MigrationSummary {
  version: number;
  fullScan: boolean;
  /** The full scan left nothing behind: written as the completion marker. */
  complete: boolean;
  actions: Partial<Record<MigrationAction, number>>;
  steps: Partial<Record<MigrationStep, Partial<Record<MigrationAction, number>>>>;
  resolutions: { same: number; changed: number };
  /** What the coordinator asked to see at 0 (task comment 34cyugWvuntejHeqndmqX): references to a
   *  retired slug left in open sessions, task pins, preferences, maintenance settings and fallbacks. */
  aliasReferences: number;
  /** Rows a rewrite found changed under it in the last pass, left for the next start. */
  leftOver: number;
  failures: Array<{ ownerId: string | null; error: string }>;
  legacyRowsLeft: number;
}

export interface MigrationResult {
  /** Null for a start that found nothing to do. */
  runId: string | null;
  rehearsal: boolean;
  fullScan: boolean;
  lines: ReportLine[];
  summary: MigrationSummary | null;
}

export interface ProviderEngineMigrationOptions {
  /** The database the advisory lock is held on, over a connection of its own. */
  databaseUrl: string;
  /** Where the report goes besides its table. */
  log?: Pick<Logger, 'log' | 'warn' | 'error'>;
  lockTimeoutMs?: number;
}

/** Runs a unit of work: in its own retried transaction, or inside the rehearsal's one. */
type UnitRunner = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

/** A unit's `deepseek-harness` rows changed before its locks were taken: it runs again. */
class UnitMoved extends Error {
  constructor() {
    super('the owner\'s deepseek-harness rows changed while the unit took its locks');
  }
}

/** Thrown out of the rehearsal's transaction to roll everything it did back. */
class Rehearsed extends Error {
  constructor(readonly result: MigrationResult) {
    super('rehearsal rolled back');
  }
}

export class ProviderEngineMigration {
  private readonly log: Pick<Logger, 'log' | 'warn' | 'error'>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: ProviderEngineMigrationOptions,
  ) {
    this.log = options.log ?? new Logger('ProviderEngineMigration');
  }

  /** Run the migration: everything on the first start, the `deepseek-harness` rows on later ones. */
  async run(): Promise<MigrationResult> {
    const unlock = await this.lock();
    try {
      const unit: UnitRunner = (work) =>
        withTransactionRetry(this.prisma, work, loggedRetry(this.log, 'providerEngineMigration.owner', { transaction: OWNER_TRANSACTION }));
      return await this.execute(this.prisma, unit, false);
    } finally {
      await unlock();
    }
  }

  /**
   * The same run inside one transaction that is rolled back (§7.6 演练): the report, and nothing written —
   * for a drill on a copy of production data. It takes the same lock, so it never runs beside a real run.
   */
  async rehearse(): Promise<MigrationResult> {
    const unlock = await this.lock();
    try {
      await this.prisma.$transaction(async (tx) => {
        throw new Rehearsed(await this.execute(tx, (work) => work(tx), true));
      }, REHEARSAL_TRANSACTION);
      throw new Error('the rehearsal transaction committed');
    } catch (error) {
      if (error instanceof Rehearsed) return error.result;
      throw error;
    } finally {
      await unlock();
    }
  }

  /** Hold the migration's advisory lock on a connection of its own until the returned release. */
  private async lock(): Promise<() => Promise<void>> {
    const client = new Client({ connectionString: this.options.databaseUrl });
    await client.connect();
    try {
      const timeout = Math.max(1, Math.trunc(this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
      await client.query(`SET lock_timeout = ${timeout}`);
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [PROVIDER_ENGINE_MIGRATION_LOCK]);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    return async () => {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [PROVIDER_ENGINE_MIGRATION_LOCK]);
      } finally {
        await client.end().catch(() => undefined);
      }
    };
  }

  private async execute(db: Prisma.TransactionClient, unit: UnitRunner, rehearsal: boolean): Promise<MigrationResult> {
    const marker = await db.providerEngineMigrationRun.findFirst({
      where: { version: PROVIDER_ENGINE_MIGRATION_VERSION, fullScan: true, complete: true },
      select: { id: true },
    });
    const fullScan = !marker;
    if (!fullScan && (await db.modelProvider.count({ where: { runtime: AgentProvider.DSH } })) === 0) {
      return { runId: null, rehearsal, fullScan, lines: [], summary: null };
    }
    const runId = randomUUID();
    await db.providerEngineMigrationRun.create({
      data: { id: runId, version: PROVIDER_ENGINE_MIGRATION_VERSION, fullScan },
    });
    const lines: ReportLine[] = [];
    const record = async (batch: ReportLine[]) => {
      await writeReport(db, runId, batch);
      this.report(runId, batch);
      lines.push(...batch);
    };
    this.log.log(`provider-engine-migration ${runId} started (${fullScan ? 'full scan' : 'deepseek-harness rows only'}${rehearsal ? ', rehearsal' : ''})`);
    // Read before anything moves.
    if (fullScan) await record(await backfillLines(db));
    await record(await untouchedLines(db, fullScan));
    const failures: MigrationSummary['failures'] = [];
    let pending = await ownersToMigrate(db, fullScan);
    let leftOver = 0;
    for (let pass = 1; pass <= PASSES && pending.length > 0; pass++) {
      const again: Array<string | null> = [];
      leftOver = 0;
      for (const ownerId of pending) {
        try {
          const outcome = await this.migrateOwnerUnit(unit, runId, ownerId, fullScan);
          this.report(runId, outcome.lines);
          lines.push(...outcome.lines);
          if (outcome.skipped > 0) {
            again.push(ownerId);
            leftOver += outcome.skipped;
          }
        } catch (error) {
          if (rehearsal) throw error;
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ ownerId, error: message });
          this.log.error(`provider-engine-migration ${runId} owner ${ownerId ?? '(shared)'} failed and is left for the next start: ${message}`);
        }
      }
      pending = again;
    }
    await record(await aliasReferenceLines(db));
    const legacyRowsLeft = await db.modelProvider.count({ where: { runtime: AgentProvider.DSH } });
    const complete = fullScan && failures.length === 0 && leftOver === 0 && legacyRowsLeft === 0;
    const summary = summarize(lines, { fullScan, complete, leftOver, failures, legacyRowsLeft });
    await db.providerEngineMigrationRun.update({
      where: { id: runId },
      data: { finishedAt: new Date(), complete, summary: summary as unknown as Prisma.InputJsonValue },
    });
    this.log.log(`provider-engine-migration ${runId} finished: ${JSON.stringify(summary)}`);
    return { runId, rehearsal, fullScan, lines, summary };
  }

  /** One owner's unit, re-run whole when the slug it picked was taken under it, or its rows moved
   *  before it held them. */
  private async migrateOwnerUnit(
    unit: UnitRunner,
    runId: string,
    ownerId: string | null,
    fullScan: boolean,
  ): Promise<UnitOutcome> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await unit((tx) => migrateOwner(tx, runId, ownerId, fullScan));
      } catch (error) {
        // A slug picked for a conversion that another writer took first, or rows that moved under the
        // unit's first read: the whole unit again, on what is there now.
        const raced = (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || error instanceof UnitMoved;
        if (!raced || attempt >= SLUG_RACE_ATTEMPTS) throw error;
      }
    }
  }

  private report(runId: string, batch: ReportLine[]): void {
    for (const line of batch) {
      const say = line.action === 'CHANGED' || line.action === 'SKIPPED_CHANGED' ? 'warn' : 'log';
      this.log[say](`provider-engine-migration ${runId} ${JSON.stringify(line)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// One owner (or, for the shared rows, the null owner): every rewrite in one transaction.
// ---------------------------------------------------------------------------------------------------

interface UnitOutcome {
  lines: ReportLine[];
  /** Rewrites that found their row changed, which a later pass tries again. */
  skipped: number;
}

/** A session or a task pin a unit may rewrite, as it read it under its lock. */
interface SessionRow { id: string; ownerId: string; provider: string; providerBuiltin: boolean; engine: string | null; model: string | null }
interface TaskRow { id: string; ownerId: string; provider: string | null; engine: string | null; model: string | null }

/** What a unit is about to rewrite, read under its locks. */
interface UnitRows {
  sessions: Map<string, SessionRow>;
  tasks: Map<string, TaskRow>;
  /** Working copies, written once each at the end. */
  preferences: Map<string, JsonEdit>;
  fallbacks: Map<string, JsonEdit>;
  wikiSpaces: Map<string, JsonEdit>;
}

interface JsonEdit {
  ownerId: string;
  before: unknown;
  value: unknown;
  lines: ReportLine[];
}

async function migrateOwner(
  tx: Prisma.TransactionClient,
  runId: string,
  ownerId: string | null,
  fullScan: boolean,
): Promise<UnitOutcome> {
  const lines: ReportLine[] = [];
  const personal = ownerId !== null;
  // A full scan of a personal owner reaches its built-in dsh sessions, its old OpenCode spellings and its
  // preferences; every unit reaches whatever names a row it folds.
  const everything = fullScan && personal;
  const legacySlugs = (await tx.modelProvider.findMany({
    where: { runtime: AgentProvider.DSH, ownerId }, select: { slug: true },
  })).map((row) => row.slug);
  const rows = await lockUnit(tx, ownerId, legacySlugs, everything);
  const keys = await tx.modelProvider.findMany({ where: { ownerId }, orderBy: KEY_ORDER });
  const legacy = keys.filter((row) => row.runtime === AgentProvider.DSH);
  if (legacy.length !== legacySlugs.length || legacy.some((row) => !legacySlugs.includes(row.slug))) {
    // A row came or went between the read the locks were chosen by and the locks: choose again.
    throw new UnitMoved();
  }
  const before = await resolutions(tx, [...rows.sessions.keys()]);
  let skipped = 0;

  // 1. Fold each `deepseek-harness` row, in the order keys are chosen in (§3.3).
  let current = keys;
  for (const row of legacy) {
    const folded = await foldLegacyRow(tx, row, current);
    lines.push(...folded.lines);
    current = folded.keys;
    skipped += await rewriteReferences(tx, rows, row.slug, folded.slug, lines);
  }

  if (everything) {
    // 2. Built-in dsh sessions: onto the first enabled DeepSeek key, now that every row is folded.
    skipped += await moveLegacyDshSessions(tx, rows, ownerId!, lines);
    // 3. The old OpenCode spelling of any other key.
    skipped += await moveOpenCodeSpelling(tx, rows, ownerId!, lines);
    // 4. Preferences whose keys changed meaning.
    await rekeyPreferences(tx, rows, ownerId!);
  }
  skipped += await writeEdits(tx, rows, lines);

  // 5. Every session this unit locked, resolved again.
  const after = await resolutions(tx, [...rows.sessions.keys()]);
  for (const [id, was] of before) {
    const now = after.get(id)!;
    const session = rows.sessions.get(id)!;
    lines.push({
      step: 'resolution', table: 'session', rowId: id, ownerId: session.ownerId,
      action: sameResolution(was, now) ? 'SAME' : 'CHANGED', before: was, after: now,
    });
  }
  if (lines.length === 0) {
    lines.push({ step: 'dsh-row', table: 'model_provider', rowId: null, ownerId, action: 'NOOP', note: 'nothing left to migrate' });
  }
  await writeReport(tx, runId, lines);
  return { lines, skipped };
}

/**
 * The unit's locks, in the canonical order (common/lock-order.ts): the accounts it writes for (rank 10,
 * the owner graph mutex, FOR UPDATE); the workspaces whose fallbacks name a row it folds, then the
 * owner's keys (rank 15); the sessions (30) and task pins (50) it may rewrite, each sorted by id in one
 * statement at the mode its UPDATE takes; the Wiki spaces whose maintenance setting names one. The rows
 * are read back under those locks.
 */
async function lockUnit(
  tx: Prisma.TransactionClient,
  ownerId: string | null,
  slugs: string[],
  everything: boolean,
): Promise<UnitRows> {
  const scope = (alias: string) => ownerId === null
    ? Prisma.sql`TRUE`
    : Prisma.sql`${Prisma.raw(alias)}."owner_id" = ${ownerId}::uuid`;
  const prefixes = slugs.map((slug) => openCodeKeyModel(slug, ''));
  const sessionsWhere = Prisma.sql`(
      (NOT s."provider_builtin" AND s."provider" = ANY(${slugs}::text[]))
      OR (s."provider" = 'opencode' AND s."model" IS NOT NULL
          AND EXISTS (SELECT 1 FROM unnest(${prefixes}::text[]) p WHERE starts_with(s."model", p)))
      ${everything ? Prisma.sql`OR (s."provider" = 'dsh' AND s."provider_builtin")
      OR (s."provider" = 'opencode' AND s."model" LIKE 'orbit-%/%')` : Prisma.empty}
    ) AND ${scope('s')}`;
  const tasksWhere = Prisma.sql`(
      t."provider" = ANY(${slugs}::text[])
      OR (t."provider" = 'opencode' AND t."model" IS NOT NULL
          AND EXISTS (SELECT 1 FROM unnest(${prefixes}::text[]) p WHERE starts_with(t."model", p)))
      ${everything ? Prisma.sql`OR (t."provider" = 'opencode' AND t."model" LIKE 'orbit-%/%')` : Prisma.empty}
    ) AND ${scope('t')}`;
  const namesSlug = (key: Prisma.Sql) => Prisma.sql`(${key} = ANY(${slugs}::text[])
    OR (strpos(${key}, ':') > 0 AND substr(${key}, strpos(${key}, ':') + 1) = ANY(${slugs}::text[]))
    OR (${key} LIKE 'opencode/%' AND substr(${key}, 10) = ANY(${slugs}::text[])))`;

  // Rank 10: the owner; for shared rows, every account whose rows or preferences name one.
  const accounts = ownerId !== null ? [ownerId] : (await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s."owner_id" AS "id" FROM "session" s WHERE ${sessionsWhere}
      UNION SELECT t."owner_id" FROM "task" t WHERE ${tasksWhere}
      UNION SELECT u."id" FROM "user" u
       WHERE jsonb_typeof(u."preferences"->'defaultModels') = 'object'
         AND EXISTS (SELECT 1 FROM jsonb_each_text(u."preferences"->'defaultModels') e("k", "v")
                     WHERE ${namesSlug(Prisma.sql`e."k"`)}
                        OR (e."k" = 'opencode' AND EXISTS (
                              SELECT 1 FROM unnest(${prefixes}::text[]) p WHERE starts_with(e."v", p))))`)).map((row) => row.id);
  const users = accounts.length === 0 ? [] : await tx.$queryRaw<Array<{ id: string; preferences: unknown }>>(Prisma.sql`
      SELECT "id", "preferences" FROM "user" WHERE "id" = ANY(${accounts}::uuid[]) ORDER BY "id" FOR UPDATE`);
  // Rank 15: workspaces whose fallbacks name a row about to fold, then the owner's keys.
  const workspaces = slugs.length === 0 ? [] : await tx.$queryRaw<Array<{ id: string; ownerId: string; fallbacks: unknown }>>(Prisma.sql`
      SELECT w."id", w."owner_id" AS "ownerId", w."provider_fallbacks" AS "fallbacks" FROM "workspace" w
       WHERE jsonb_typeof(w."provider_fallbacks") = 'array'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(w."provider_fallbacks") f
                     WHERE f->>'provider' = ANY(${slugs}::text[]))
         AND ${scope('w')}
       ORDER BY w."id" FOR NO KEY UPDATE`);
  await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "model_provider" WHERE ${ownerId === null ? Prisma.sql`"owner_id" IS NULL` : Prisma.sql`"owner_id" = ${ownerId}::uuid`}
       ORDER BY "id" FOR UPDATE`);
  // Rank 30 and 50.
  const sessions = await tx.$queryRaw<SessionRow[]>(Prisma.sql`
      SELECT s."id", s."owner_id" AS "ownerId", s."provider", s."provider_builtin" AS "providerBuiltin", s."engine", s."model"
        FROM "session" s WHERE ${sessionsWhere}
       ORDER BY s."id" FOR NO KEY UPDATE`);
  const tasks = await tx.$queryRaw<TaskRow[]>(Prisma.sql`
      SELECT t."id", t."owner_id" AS "ownerId", t."provider", t."engine", t."model"
        FROM "task" t WHERE ${tasksWhere}
       ORDER BY t."id" FOR NO KEY UPDATE`);
  const wikiSpaces = slugs.length === 0 ? [] : await tx.$queryRaw<Array<{ id: string; ownerId: string; settings: unknown }>>(Prisma.sql`
      SELECT w."id", w."owner_id" AS "ownerId", w."settings" FROM "wiki_space" w
       WHERE w."settings"#>>'{maintenance,provider}' = ANY(${slugs}::text[]) AND ${scope('w')}
       ORDER BY w."id" FOR NO KEY UPDATE`);
  const edit = (owner: string, value: unknown): JsonEdit => ({ ownerId: owner, before: value, value: structuredClone(value), lines: [] });
  return {
    sessions: new Map(sessions.map((row) => [row.id, row])),
    tasks: new Map(tasks.map((row) => [row.id, row])),
    preferences: new Map(users.map((row) => [row.id, edit(row.id, row.preferences)])),
    fallbacks: new Map(workspaces.map((row) => [row.id, edit(row.ownerId, row.fallbacks)])),
    wikiSpaces: new Map(wikiSpaces.map((row) => [row.id, edit(row.ownerId, row.settings)])),
  };
}

async function resolutions(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, SessionResolution>> {
  const out = new Map<string, SessionResolution>();
  if (ids.length === 0) return out;
  const sessions = await tx.session.findMany({ where: { id: { in: ids } }, select: RESOLUTION_SELECT });
  for (const session of sessions) out.set(session.id, await resolutionOf(tx, session));
  return out;
}

/** A key's row as the report shows it: everything but the key. */
function rowView(row: ModelProvider) {
  return {
    id: row.id, slug: row.slug, label: row.label, runtime: row.runtime, presetSlug: row.presetSlug,
    baseUrl: row.baseUrl, enabled: row.enabled, position: row.position, followsPreset: row.followsPreset,
    defaultModel: row.defaultModel,
  };
}

/** The key a row holds, trimmed, or null when it cannot be decrypted. */
function heldKey(row: ModelProvider): string | null {
  try {
    return decryptSecret(row.apiKeyEnc).trim();
  } catch {
    return null;
  }
}

/** Why `row` is not merged, or the key it is merged into (§7.2): the first of the owner's enabled
 *  DeepSeek keys that DeepSeek Harness can run, holding the same key on the same endpoint. */
async function mergeTarget(
  tx: Prisma.TransactionClient,
  row: ModelProvider,
  keys: ModelProvider[],
): Promise<{ target: ModelProvider } | { why: string }> {
  if (!row.enabled) return { why: 'it is turned off, so it is not merged; it stays off' };
  if (await tx.providerPoolMember.count({ where: { providerId: row.id } })) {
    return { why: 'it is a member of an account pool, which a merge would take it out of' };
  }
  const key = heldKey(row);
  if (key === null) return { why: 'its key cannot be decrypted, so no other key can be shown to be the same' };
  const endpoint = normalizedEndpoint(row.baseUrl);
  const target = keys.find((candidate) =>
    candidate.id !== row.id
    && candidate.runtime === AgentProvider.CLAUDE
    && candidate.enabled
    && isDeepSeekKey(candidate)
    && normalizedEndpoint(candidate.baseUrl) === endpoint
    && heldKey(candidate) === key
    && isEngineCompatible(AgentProvider.DSH, keyCredential(candidate, key)));
  return target
    ? { target }
    : { why: 'no enabled DeepSeek key of the same owner holds the same key on the same endpoint' };
}

/** The first vendor label none of the owner's other keys carries (compared trimmed, without case). */
function freeDeepSeekLabel(keys: ModelProvider[], row: ModelProvider): string {
  const taken = new Set(keys.filter((key) => key.id !== row.id).map((key) => key.label.trim().toLowerCase()));
  if (!taken.has(DEEPSEEK_LABEL.toLowerCase())) return DEEPSEEK_LABEL;
  for (let n = 2; ; n++) if (!taken.has(`${DEEPSEEK_LABEL} ${n}`.toLowerCase())) return `${DEEPSEEK_LABEL} ${n}`;
}

/** A free `deepseek` slug in the one dispatch namespace: keys, pools and retired names (0265, 0415). */
async function freeDeepSeekSlug(tx: Prisma.TransactionClient): Promise<string> {
  const where = { slug: { startsWith: DEEPSEEK_PRESET } };
  const [keys, pools, aliases] = await Promise.all([
    tx.modelProvider.findMany({ where, select: { slug: true } }),
    tx.providerPool.findMany({ where, select: { slug: true } }),
    tx.providerSlugAlias.findMany({ where, select: { slug: true } }),
  ]);
  return pickFreeSlug(DEEPSEEK_PRESET, [...keys, ...pools, ...aliases].map((r) => r.slug));
}

/**
 * Merge or convert one `deepseek-harness` row (§7.2), and retire its slug: deleted before its name is
 * taken as an alias (or renamed first), since 0265's guard refuses a name a row still holds. Answers the
 * slug its references move to, and the owner's keys as they now are.
 */
async function foldLegacyRow(
  tx: Prisma.TransactionClient,
  row: ModelProvider,
  keys: ModelProvider[],
): Promise<{ slug: string; keys: ModelProvider[]; lines: ReportLine[] }> {
  const lines: ReportLine[] = [];
  const merge = await mergeTarget(tx, row, keys);
  if ('target' in merge) {
    const { target } = merge;
    await tx.modelProvider.delete({ where: { id: row.id } });
    await tx.providerSlugAlias.create({ data: { slug: row.slug, providerId: target.id, engine: AgentProvider.DSH, reason: 'MERGED' } });
    lines.push(
      {
        step: 'dsh-row', table: 'model_provider', rowId: row.id, ownerId: row.ownerId, action: 'MERGED',
        before: rowView(row), after: { mergedInto: target.id, slug: target.slug, sameKey: true },
        note: 'the same owner\'s enabled DeepSeek key holds the same key on the same endpoint',
      },
      {
        step: 'dsh-row', table: 'provider_slug_alias', rowId: row.slug, ownerId: row.ownerId, action: 'ALIASED',
        after: { slug: row.slug, providerId: target.id, engine: AgentProvider.DSH, reason: 'MERGED' },
      },
    );
    return { slug: target.slug, keys: keys.filter((key) => key.id !== row.id), lines };
  }
  const preset = providerPreset(DEEPSEEK_PRESET)!;
  const slug = DEEPSEEK_SLUG.test(row.slug) ? row.slug : await freeDeepSeekSlug(tx);
  const converted = await tx.modelProvider.update({
    where: { id: row.id },
    data: {
      presetSlug: DEEPSEEK_PRESET,
      runtime: AgentProvider.CLAUDE,
      followsPreset: true,
      models: catalogModels(preset).map((m) => ({
        value: m.value,
        label: m.label,
        ...(m.contextWindow != null ? { contextWindow: m.contextWindow } : {}),
      })) as Prisma.InputJsonValue,
      defaultModel: catalogDefaultModel(preset),
      label: row.label.trim() === HARNESS_LABEL ? freeDeepSeekLabel(keys, row) : row.label,
      slug,
    },
  });
  lines.push({
    step: 'dsh-row', table: 'model_provider', rowId: row.id, ownerId: row.ownerId, action: 'CONVERTED',
    before: rowView(row), after: rowView(converted), note: merge.why,
  });
  if (slug !== row.slug) {
    await tx.providerSlugAlias.create({ data: { slug: row.slug, providerId: row.id, engine: AgentProvider.DSH, reason: 'RENAMED' } });
    lines.push({
      step: 'dsh-row', table: 'provider_slug_alias', rowId: row.slug, ownerId: row.ownerId, action: 'ALIASED',
      after: { slug: row.slug, providerId: row.id, engine: AgentProvider.DSH, reason: 'RENAMED' },
    });
  }
  return { slug, keys: keys.map((key) => (key.id === row.id ? converted : key)), lines };
}

/**
 * Everything the unit locked that names `from` — a folded row's old slug — moved to `to`, the key's own
 * (§7.3): sessions keep their engine (`dsh` where none was recorded: what the old slug ran on), task pins
 * take the engine pin with them, an old OpenCode spelling naming it becomes the key on OpenCode, and the
 * preferences, Wiki settings and fallbacks that name it are edited for the one write each gets at the end.
 * Answers how many rewrites found their row changed.
 */
async function rewriteReferences(
  tx: Prisma.TransactionClient,
  rows: UnitRows,
  from: string,
  to: string,
  lines: ReportLine[],
): Promise<number> {
  if (from === to) return 0;
  let skipped = 0;
  const sessions = [...rows.sessions.values()].filter((s) => s.provider === from && !s.providerBuiltin);
  if (sessions.length > 0) {
    const moved = new Set((await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "session" SET "provider" = ${to}, "engine" = COALESCE("engine", 'dsh')
         WHERE "id" = ANY(${sessions.map((s) => s.id)}::uuid[]) AND "provider" = ${from} AND NOT "provider_builtin"
        RETURNING "id"`)).map((row) => row.id));
    for (const s of sessions) {
      const done = moved.has(s.id);
      if (!done) skipped++;
      lines.push({
        step: 'reference', table: 'session', rowId: s.id, ownerId: s.ownerId, action: done ? 'REWRITTEN' : 'SKIPPED_CHANGED',
        before: { provider: from, engine: s.engine }, after: { provider: to, engine: s.engine ?? AgentProvider.DSH },
      });
      if (done) Object.assign(s, { provider: to, engine: s.engine ?? AgentProvider.DSH });
    }
  }
  const tasks = [...rows.tasks.values()].filter((t) => t.provider === from);
  if (tasks.length > 0) {
    const moved = new Set((await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "task" SET "provider" = ${to}, "engine" = COALESCE("engine", 'dsh')
         WHERE "id" = ANY(${tasks.map((t) => t.id)}::uuid[]) AND "provider" = ${from}
        RETURNING "id"`)).map((row) => row.id));
    for (const t of tasks) {
      const done = moved.has(t.id);
      if (!done) skipped++;
      lines.push({
        step: 'reference', table: 'task', rowId: t.id, ownerId: t.ownerId, action: done ? 'REWRITTEN' : 'SKIPPED_CHANGED',
        before: { provider: from, engine: t.engine }, after: { provider: to, engine: t.engine ?? AgentProvider.DSH },
      });
      if (done) Object.assign(t, { provider: to, engine: t.engine ?? AgentProvider.DSH });
    }
  }
  // The old OpenCode spelling naming the folded row: the key on OpenCode, under its own slug.
  const prefix = openCodeKeyModel(from, '');
  skipped += await moveOpenCodeRows(
    tx,
    [...rows.sessions.values()].filter((s) => s.provider === AgentProvider.OPENCODE && s.model?.startsWith(prefix)),
    [...rows.tasks.values()].filter((t) => t.provider === AgentProvider.OPENCODE && t.model?.startsWith(prefix)),
    () => Promise.resolve(to),
    'reference',
    lines,
  );
  // Preferences, maintenance settings and fallbacks: edited now, written once each by writeEdits.
  for (const edit of rows.preferences.values()) renamePreferenceKeys(edit, from, to);
  for (const edit of rows.wikiSpaces.values()) {
    const settings = edit.value as { maintenance?: { provider?: unknown } } | null;
    if (settings?.maintenance?.provider !== from) continue;
    settings.maintenance.provider = to;
    edit.lines.push({
      step: 'reference', table: 'wiki_space', rowId: null, ownerId: edit.ownerId, action: 'REWRITTEN',
      before: { maintenanceProvider: from }, after: { maintenanceProvider: to },
      note: 'flagged: the maintenance setting did not accept a DeepSeek Harness row before the split',
    });
  }
  for (const edit of rows.fallbacks.values()) {
    if (!Array.isArray(edit.value)) continue;
    let named = false;
    for (const entry of edit.value as Array<{ provider?: unknown }>) {
      if (entry && typeof entry === 'object' && entry.provider === from) {
        entry.provider = to;
        named = true;
      }
    }
    if (named) {
      edit.lines.push({
        step: 'reference', table: 'workspace', rowId: null, ownerId: edit.ownerId, action: 'REWRITTEN',
        before: { fallbackProvider: from }, after: { fallbackProvider: to },
      });
    }
  }
  return skipped;
}

/**
 * The old OpenCode spelling (§7.4): `provider: opencode`, `model: orbit-<slug>/<model>` becomes the key
 * `<slug>` names — its own slug, a retired name followed to its key — on OpenCode, with the bare model.
 * A key that is gone, or one OpenCode cannot run (a Claude subscription token), is left as it was and
 * reported UNRESOLVED: it cannot be dispatched today either.
 */
async function moveOpenCodeRows(
  tx: Prisma.TransactionClient,
  sessions: SessionRow[],
  tasks: TaskRow[],
  keySlug: (ownerId: string, slug: string) => Promise<string | { why: string }>,
  step: MigrationStep,
  lines: ReportLine[],
): Promise<number> {
  let skipped = 0;
  for (const s of sessions) {
    const named = openCodeKeyOf(s.model);
    if (!named) continue;
    const target = s.engine && s.engine !== AgentProvider.OPENCODE
      ? { why: `it is recorded on ${s.engine}, not OpenCode` }
      : await keySlug(s.ownerId, named.slug);
    if (typeof target !== 'string') {
      lines.push({ step, table: 'session', rowId: s.id, ownerId: s.ownerId, action: 'UNRESOLVED', before: { provider: s.provider, model: s.model }, note: target.why });
      continue;
    }
    const moved = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "session" SET "provider" = ${target}, "provider_builtin" = false, "model" = ${named.model},
               "engine" = COALESCE("engine", 'opencode')
         WHERE "id" = ${s.id}::uuid AND "provider" = 'opencode' AND "model" = ${s.model}
        RETURNING "id"`);
    const done = moved.length === 1;
    if (!done) skipped++;
    lines.push({
      step, table: 'session', rowId: s.id, ownerId: s.ownerId, action: done ? 'REWRITTEN' : 'SKIPPED_CHANGED',
      before: { provider: s.provider, providerBuiltin: s.providerBuiltin, model: s.model, engine: s.engine },
      after: { provider: target, providerBuiltin: false, model: named.model, engine: AgentProvider.OPENCODE },
    });
    if (done) Object.assign(s, { provider: target, providerBuiltin: false, model: named.model, engine: AgentProvider.OPENCODE });
  }
  for (const t of tasks) {
    const named = openCodeKeyOf(t.model);
    if (!named) continue;
    const target = t.engine && t.engine !== AgentProvider.OPENCODE
      ? { why: `it is pinned to ${t.engine}, not OpenCode` }
      : await keySlug(t.ownerId, named.slug);
    if (typeof target !== 'string') {
      lines.push({ step, table: 'task', rowId: t.id, ownerId: t.ownerId, action: 'UNRESOLVED', before: { provider: t.provider, model: t.model }, note: target.why });
      continue;
    }
    const moved = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "task" SET "provider" = ${target}, "model" = ${named.model}, "engine" = COALESCE("engine", 'opencode')
         WHERE "id" = ${t.id}::uuid AND "provider" = 'opencode' AND "model" = ${t.model}
        RETURNING "id"`);
    const done = moved.length === 1;
    if (!done) skipped++;
    lines.push({
      step, table: 'task', rowId: t.id, ownerId: t.ownerId, action: done ? 'REWRITTEN' : 'SKIPPED_CHANGED',
      before: { provider: t.provider, model: t.model, engine: t.engine },
      after: { provider: target, model: named.model, engine: AgentProvider.OPENCODE },
    });
    if (done) Object.assign(t, { provider: target, model: named.model, engine: AgentProvider.OPENCODE });
  }
  return skipped;
}

/** The slug the old OpenCode spelling's `<slug>` stores as: the owner's key of it (or the one a retired
 *  name of it resolves to), when OpenCode can run that key. */
function openCodeKey(tx: Prisma.TransactionClient) {
  const found = new Map<string, Promise<string | { why: string }>>();
  return (ownerId: string, slug: string) => {
    const at = `${ownerId}\u0000${slug}`;
    if (!found.has(at)) {
      found.set(at, (async () => {
        const row = await keyRowForSlug(tx, ownerId, slug);
        if (!row) return { why: `no key of this account is called "${slug}"` };
        if (!credentialEngines(keyCredential(row)).includes(AgentProvider.OPENCODE)) {
          return { why: `"${slug}" is a key OpenCode cannot run` };
        }
        return row.slug;
      })());
    }
    return found.get(at)!;
  };
}

async function moveOpenCodeSpelling(tx: Prisma.TransactionClient, rows: UnitRows, ownerId: string, lines: ReportLine[]): Promise<number> {
  const encoded = (provider: string | null, model: string | null) => provider === AgentProvider.OPENCODE && !!openCodeKeyOf(model);
  return moveOpenCodeRows(
    tx,
    [...rows.sessions.values()].filter((s) => s.ownerId === ownerId && encoded(s.provider, s.model)),
    [...rows.tasks.values()].filter((t) => t.ownerId === ownerId && encoded(t.provider, t.model)),
    openCodeKey(tx),
    'opencode',
    lines,
  );
}

/**
 * The owner's built-in `dsh` sessions (§3.3, §7.3): kept as they are when their workspace's own
 * environment holds the key they run on (LEGACY_DSH_ENV_KEY: another key would bill another account),
 * moved onto the owner's first enabled DeepSeek key otherwise — read now that every row is folded, the
 * key dispatch hands them today — and listed where there is none (LEGACY_DSH_NO_KEY).
 */
async function moveLegacyDshSessions(tx: Prisma.TransactionClient, rows: UnitRows, ownerId: string, lines: ReportLine[]): Promise<number> {
  const legacy = [...rows.sessions.values()].filter((s) => s.provider === AgentProvider.DSH && s.providerBuiltin);
  if (legacy.length === 0) return 0;
  const workspaces = await tx.session.findMany({
    where: { id: { in: legacy.map((s) => s.id) } },
    select: { id: true, workspace: { select: { env: true } } },
  });
  const ownKey = new Set(workspaces.filter((s) => workspaceHoldsDshKey(s.workspace?.env)).map((s) => s.id));
  const key = await defaultDeepSeekKey(tx, ownerId);
  const moving = legacy.filter((s) => !ownKey.has(s.id) && key);
  for (const s of legacy) {
    if (ownKey.has(s.id)) {
      lines.push({ step: 'legacy-dsh', table: 'session', rowId: s.id, ownerId, action: 'LEGACY_DSH_ENV_KEY', before: { provider: AgentProvider.DSH, providerBuiltin: true }, note: 'its workspace holds the ORBIT_DSH_API_KEY it runs on; kept' });
    } else if (!key) {
      lines.push({ step: 'legacy-dsh', table: 'session', rowId: s.id, ownerId, action: 'LEGACY_DSH_NO_KEY', before: { provider: AgentProvider.DSH, providerBuiltin: true }, note: 'its owner has no enabled DeepSeek key; kept' });
    }
  }
  if (moving.length === 0 || !key) return 0;
  const moved = new Set((await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "session" SET "provider" = ${key.slug}, "provider_builtin" = false, "engine" = COALESCE("engine", 'dsh')
       WHERE "id" = ANY(${moving.map((s) => s.id)}::uuid[]) AND "provider" = 'dsh' AND "provider_builtin"
      RETURNING "id"`)).map((row) => row.id));
  let skipped = 0;
  for (const s of moving) {
    const done = moved.has(s.id);
    if (!done) skipped++;
    lines.push({
      step: 'legacy-dsh', table: 'session', rowId: s.id, ownerId, action: done ? 'REWRITTEN' : 'SKIPPED_CHANGED',
      before: { provider: AgentProvider.DSH, providerBuiltin: true, engine: s.engine },
      after: { provider: key.slug, providerBuiltin: false, engine: s.engine ?? AgentProvider.DSH },
      note: 'the first enabled DeepSeek key of its owner, the one dispatch hands it',
    });
    if (done) Object.assign(s, { provider: key.slug, providerBuiltin: false, engine: s.engine ?? AgentProvider.DSH });
  }
  return skipped;
}

// ---------------------------------------------------------------------------------------------------
// Preferences (§6.5, §7.3, §7.5): `User.preferences.defaultModels`, keyed `<engine>:<provider>` now.
// ---------------------------------------------------------------------------------------------------

function defaultModelsOf(edit: JsonEdit): Record<string, unknown> | null {
  const preferences = edit.value as { defaultModels?: unknown } | null;
  const models = preferences?.defaultModels;
  return models && typeof models === 'object' && !Array.isArray(models) ? (models as Record<string, unknown>) : null;
}

/** Move one entry to the key it means now; one the new key already holds keeps that value (a conflict). */
function moveEntry(edit: JsonEdit, from: string, to: string, value: unknown, step: MigrationStep): void {
  const models = defaultModelsOf(edit)!;
  const was = models[from];
  delete models[from];
  const held = Object.prototype.hasOwnProperty.call(models, to);
  const conflict = held && models[to] !== value;
  if (!held) models[to] = value;
  edit.lines.push({
    step, table: 'user', rowId: `${edit.ownerId}:${from}`, ownerId: edit.ownerId, action: 'REWRITTEN',
    before: { [from]: was }, after: { [to]: models[to] },
    ...(conflict ? { note: `conflict: "${to}" already held a model, which is kept` } : {}),
  });
}

/** The keys that name a folded row's old slug (§7.3): the bare slug as a DeepSeek Harness choice, any
 *  `<engine>:<slug>`, and the two old OpenCode spellings naming it. */
function renamePreferenceKeys(edit: JsonEdit, from: string, to: string): void {
  const models = defaultModelsOf(edit);
  if (!models) return;
  for (const [key, value] of Object.entries(models)) {
    const colon = key.indexOf(':');
    if (key === from) {
      moveEntry(edit, key, `${AgentProvider.DSH}:${to}`, value, 'reference');
    } else if (colon > 0 && key.slice(colon + 1) === from) {
      moveEntry(edit, key, `${key.slice(0, colon)}:${to}`, value, 'reference');
    } else if (key === `${AgentProvider.OPENCODE}/${from}` || key === AgentProvider.OPENCODE) {
      const named = typeof value === 'string' ? openCodeKeyOf(value) : null;
      if (named?.slug === from) moveEntry(edit, key, `${AgentProvider.OPENCODE}:${to}`, named.model, 'reference');
    }
  }
}

/**
 * The owner's own preferences on a full scan (§7.5): an `opencode/<slug>` entry, or an `opencode` one whose
 * model names a key, becomes `opencode:<key>` with the bare model; an entry naming a retired slug becomes
 * the one naming its key. Anything else stays, for the older client that wrote it.
 */
async function rekeyPreferences(tx: Prisma.TransactionClient, rows: UnitRows, ownerId: string): Promise<void> {
  const edit = rows.preferences.get(ownerId);
  const models = edit ? defaultModelsOf(edit) : null;
  if (!edit || !models) return;
  const keyOf = openCodeKey(tx);
  const aliases = new Map((await tx.providerSlugAlias.findMany({ select: { slug: true, providerId: true } }))
    .map((alias) => [alias.slug, alias.providerId]));
  for (const [key, value] of Object.entries(models)) {
    const colon = key.indexOf(':');
    const retired = colon > 0 ? key.slice(colon + 1) : key;
    if (aliases.has(retired)) {
      const row = await keyRowForSlug(tx, ownerId, retired);
      if (!row) {
        edit.lines.push({ step: 'preference', table: 'user', rowId: `${ownerId}:${key}`, ownerId, action: 'UNRESOLVED', before: { [key]: value }, note: `"${retired}" is a retired name of a key this account cannot use` });
      } else if (colon > 0) {
        moveEntry(edit, key, `${key.slice(0, colon)}:${row.slug}`, value, 'preference');
      } else {
        moveEntry(edit, key, `${AgentProvider.DSH}:${row.slug}`, value, 'preference');
      }
      continue;
    }
    const spelled = key.startsWith(`${AgentProvider.OPENCODE}/`) || key === AgentProvider.OPENCODE;
    if (!spelled) continue;
    const named = typeof value === 'string' ? openCodeKeyOf(value) : null;
    if (key === AgentProvider.OPENCODE && !named) continue; // OpenCode's own model: unchanged.
    const slug = key === AgentProvider.OPENCODE ? named!.slug : key.slice(AgentProvider.OPENCODE.length + 1);
    if (!named || named.slug !== slug) {
      edit.lines.push({ step: 'preference', table: 'user', rowId: `${ownerId}:${key}`, ownerId, action: 'UNRESOLVED', before: { [key]: value }, note: 'its model does not name the key the entry is for' });
      continue;
    }
    const target = await keyOf(ownerId, slug);
    if (typeof target !== 'string') {
      edit.lines.push({ step: 'preference', table: 'user', rowId: `${ownerId}:${key}`, ownerId, action: 'UNRESOLVED', before: { [key]: value }, note: target.why });
      continue;
    }
    moveEntry(edit, key, `${AgentProvider.OPENCODE}:${target}`, named.model, 'preference');
  }
}

/**
 * The unit's JSON edits, each row written once (I3): preferences on the account row the unit holds at rank
 * 10, fallbacks on the workspaces it holds at 15, maintenance settings on the Wiki spaces it holds. Each is
 * compared with the value it was read as, under that lock.
 */
async function writeEdits(tx: Prisma.TransactionClient, rows: UnitRows, lines: ReportLine[]): Promise<number> {
  let skipped = 0;
  const changed = (edit: JsonEdit) => edit.lines.some((line) => line.action === 'REWRITTEN');
  const settle = (edit: JsonEdit, table: string, id: string, count: number) => {
    for (const line of edit.lines) {
      const rowId = line.rowId ?? id;
      if (line.action === 'REWRITTEN' && count !== 1) {
        skipped++;
        lines.push({ ...line, table, rowId, action: 'SKIPPED_CHANGED' });
      } else {
        lines.push({ ...line, table, rowId });
      }
    }
  };
  for (const [id, edit] of rows.preferences) {
    if (!changed(edit)) {
      settle(edit, 'user', id, 1);
      continue;
    }
    const count = await tx.$executeRaw(Prisma.sql`
        UPDATE "user" SET "preferences" = ${JSON.stringify(edit.value)}::jsonb
         WHERE "id" = ${id}::uuid AND "preferences" = ${JSON.stringify(edit.before)}::jsonb`);
    settle(edit, 'user', id, count);
  }
  for (const [id, edit] of rows.fallbacks) {
    if (!changed(edit)) continue;
    const count = await tx.$executeRaw(Prisma.sql`
        UPDATE "workspace" SET "provider_fallbacks" = ${JSON.stringify(edit.value)}::jsonb
         WHERE "id" = ${id}::uuid AND "provider_fallbacks" = ${JSON.stringify(edit.before)}::jsonb`);
    settle(edit, 'workspace', id, count);
  }
  for (const [id, edit] of rows.wikiSpaces) {
    if (!changed(edit)) continue;
    const count = await tx.$executeRaw(Prisma.sql`
        UPDATE "wiki_space" SET "settings" = ${JSON.stringify(edit.value)}::jsonb
         WHERE "id" = ${id}::uuid AND "settings" = ${JSON.stringify(edit.before)}::jsonb`);
    settle(edit, 'wiki_space', id, count);
  }
  return skipped;
}

// ---------------------------------------------------------------------------------------------------
// The run's frame: which owners, what is read before and after, the report, the summary.
// ---------------------------------------------------------------------------------------------------

/** The owners with something to migrate: the shared rows' (null) first, then each account by id. */
async function ownersToMigrate(db: Prisma.TransactionClient, fullScan: boolean): Promise<Array<string | null>> {
  const owners = await db.$queryRaw<Array<{ id: string | null }>>(Prisma.sql`
      SELECT DISTINCT "owner_id" AS "id" FROM "model_provider" WHERE "runtime" = 'dsh'
      ${fullScan ? Prisma.sql`
      UNION SELECT "owner_id" FROM "session"
       WHERE ("provider" = 'dsh' AND "provider_builtin") OR ("provider" = 'opencode' AND "model" LIKE 'orbit-%/%')
      UNION SELECT "owner_id" FROM "task" WHERE "provider" = 'opencode' AND "model" LIKE 'orbit-%/%'
      UNION SELECT u."id" FROM "user" u
       WHERE jsonb_typeof(u."preferences"->'defaultModels') = 'object'
         AND EXISTS (SELECT 1 FROM jsonb_each_text(u."preferences"->'defaultModels') e("k", "v")
                     WHERE e."k" LIKE 'opencode/%'
                        OR (e."k" = 'opencode' AND e."v" LIKE 'orbit-%/%')
                        OR e."k" IN (SELECT "slug" FROM "provider_slug_alias")
                        OR (strpos(e."k", ':') > 0
                            AND substr(e."k", strpos(e."k", ':') + 1) IN (SELECT "slug" FROM "provider_slug_alias")))` : Prisma.empty}`);
  const ids = owners.map((row) => row.id);
  return [
    ...(ids.includes(null) ? [null] : []),
    ...ids.filter((id): id is string => id !== null).sort(),
  ];
}

/**
 * T2's backfill as it stands (§7.1), read before anything moves: the sessions and pinned tasks with no
 * engine that nothing can place either — the key they name is gone, and no init event named an engine
 * (UNRESOLVED; one an older replica wrote and the old rules still place is the claim's to record) — and
 * the sessions it placed by their runtime's init event rather than by the runtime their key's row has
 * now (INCONSISTENT), among those made before 0414 ran, so a session that chose another engine on a key
 * since is not mistaken for one.
 */
async function backfillLines(db: Prisma.TransactionClient): Promise<ReportLine[]> {
  const sessions = await db.session.findMany({
    where: { engine: null },
    select: { id: true, ownerId: true, provider: true, providerBuiltin: true, engine: true, runtimeSessionId: true },
    orderBy: { id: 'asc' },
  });
  const engines = await sessionEnginesOf(db, sessions);
  const tasks = await db.task.findMany({
    where: { engine: null, provider: { not: null } },
    select: { id: true, ownerId: true, provider: true },
    orderBy: { id: 'asc' },
  });
  const inconsistent = await db.$queryRaw<Array<{ id: string; ownerId: string; provider: string; engine: string; runtime: string }>>(Prisma.sql`
      SELECT s."id", s."owner_id" AS "ownerId", s."provider", s."engine", mp."runtime"
        FROM "session" s
        JOIN LATERAL (
          SELECT k."runtime" FROM "model_provider" k
           WHERE k."slug" = s."provider" AND (k."owner_id" = s."owner_id" OR k."owner_id" IS NULL)
           LIMIT 1) mp ON true
       WHERE NOT s."provider_builtin" AND s."engine" IS NOT NULL AND s."engine" <> mp."runtime"
         AND mp."runtime" IN ('claude', 'codex', 'kimi', 'antigravity', 'dsh')
         AND s."created_at" < (SELECT max("finished_at") FROM "_prisma_migrations"
                                WHERE "migration_name" = '0414_session_engine')
       ORDER BY s."id"`);
  const lines: ReportLine[] = [];
  for (const s of sessions) {
    if (engines.get(s.id)) continue;
    lines.push({
      step: 'backfill', table: 'session', rowId: s.id, ownerId: s.ownerId, action: 'UNRESOLVED',
      before: { provider: s.provider, providerBuiltin: s.providerBuiltin, runtimeSessionId: s.runtimeSessionId },
      note: 'no engine recorded, and none can be derived: nothing answers its provider any more',
    });
  }
  for (const t of tasks) {
    if (await taskPinCredential(db, t.ownerId, t.provider!)) continue;
    lines.push({
      step: 'backfill', table: 'task', rowId: t.id, ownerId: t.ownerId, action: 'UNRESOLVED',
      before: { provider: t.provider }, note: 'a provider pin with no engine pin, and nothing answers its slug',
    });
  }
  for (const s of inconsistent) {
    lines.push({
      step: 'backfill', table: 'session', rowId: s.id, ownerId: s.ownerId, action: 'INCONSISTENT',
      before: { provider: s.provider, keyRuntime: s.runtime }, after: { engine: s.engine },
      note: 'recorded from its init event: the key\'s protocol was changed after this session ran',
    });
  }
  return lines.length > 0
    ? lines
    : [{ step: 'backfill', table: 'session', rowId: null, ownerId: null, action: 'NOOP', note: 'every session and pinned task has an engine, recorded or derivable' }];
}

/** What the migration must not move (§7.3): no account pool holds a `deepseek-harness` row as a member
 *  (pools take Claude subscriptions and Codex logins), and managed runners start on built-in engines. */
async function untouchedLines(db: Prisma.TransactionClient, fullScan: boolean): Promise<ReportLine[]> {
  const members = await db.$queryRaw<Array<{ poolId: string; providerId: string; ownerId: string }>>(Prisma.sql`
      SELECT m."pool_id" AS "poolId", m."provider_id" AS "providerId", m."owner_id" AS "ownerId"
        FROM "provider_pool_member" m JOIN "model_provider" mp ON mp."id" = m."provider_id"
       WHERE mp."runtime" = 'dsh' ORDER BY m."pool_id", m."provider_id"`);
  const lines: ReportLine[] = members.length > 0
    ? members.map((m) => ({
        step: 'check', table: 'provider_pool_member', rowId: `${m.poolId}:${m.providerId}`, ownerId: m.ownerId,
        action: 'UNRESOLVED', note: 'a DeepSeek Harness row in an account pool: converted where it stands, never merged, so the pool keeps it',
      }))
    : [{ step: 'check', table: 'provider_pool_member', rowId: null, ownerId: null, action: 'NOOP', note: 'no account pool holds a DeepSeek Harness row' }];
  if (!fullScan) return lines;
  const runners = await db.managedRunner.findMany({
    where: { initialProvider: { not: null, notIn: [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.ANTIGRAVITY, AgentProvider.OPENCODE] } },
    select: { id: true, ownerId: true, initialProvider: true },
    orderBy: { id: 'asc' },
  });
  lines.push(...(runners.length > 0
    ? runners.map((r): ReportLine => ({
        step: 'check', table: 'managed_runner', rowId: r.id, ownerId: r.ownerId, action: 'UNRESOLVED',
        before: { initialProvider: r.initialProvider }, note: 'not a built-in engine; left as it is',
      }))
    : [{ step: 'check', table: 'managed_runner', rowId: null, ownerId: null, action: 'NOOP', note: 'every managed runner starts on a built-in engine; none is rewritten' } as ReportLine]));
  return lines;
}

/**
 * After the run: whatever still names a retired slug where a reference should name the key's own — open
 * sessions and task pins (by slug, or in the old OpenCode spelling), preferences, maintenance settings,
 * fallbacks — counted only where its owner reaches the key through that name (usableProviderScope), since
 * for anyone else the name is not the key's: another account's `dsh` is still the built-in one. History is
 * not here: receipts, route decisions and run events read through the name.
 */
async function aliasReferenceLines(db: Prisma.TransactionClient): Promise<ReportLine[]> {
  // `a` is the key a retired name resolves to; no branch below names a table `u`, which the helper's own
  // admin test does.
  const reaches = (owner: string) => usableProviderSql('a', Prisma.raw(owner));
  const found = await db.$queryRaw<Array<{ tableName: string; rowId: string; ownerId: string; slug: string }>>(Prisma.sql`
      WITH a AS (SELECT pa."slug", mp."owner_id" FROM "provider_slug_alias" pa JOIN "model_provider" mp ON mp."id" = pa."provider_id")
      SELECT 'session' AS "tableName", s."id"::text AS "rowId", s."owner_id" AS "ownerId", s."provider" AS "slug"
        FROM "session" s JOIN a ON a."slug" = s."provider"
       WHERE NOT s."provider_builtin" AND s."completed_at" IS NULL AND s."deleted_at" IS NULL AND ${reaches('s."owner_id"')}
      UNION ALL
      SELECT 'session', s."id"::text, s."owner_id", s."model" FROM "session" s JOIN a ON starts_with(s."model", 'orbit-' || a."slug" || '/')
       WHERE s."provider" = 'opencode' AND s."completed_at" IS NULL AND s."deleted_at" IS NULL AND ${reaches('s."owner_id"')}
      UNION ALL
      SELECT 'task', t."id"::text, t."owner_id", t."provider" FROM "task" t JOIN a ON a."slug" = t."provider"
       WHERE t."status"::text NOT IN ('DONE', 'CANCELLED') AND ${reaches('t."owner_id"')}
      UNION ALL
      SELECT 'task', t."id"::text, t."owner_id", t."model" FROM "task" t JOIN a ON starts_with(t."model", 'orbit-' || a."slug" || '/')
       WHERE t."provider" = 'opencode' AND t."status"::text NOT IN ('DONE', 'CANCELLED') AND ${reaches('t."owner_id"')}
      UNION ALL
      SELECT 'user', pu."id"::text || ':' || e."k", pu."id", e."k" FROM "user" pu
        CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(pu."preferences"->'defaultModels') = 'object'
                                                THEN pu."preferences"->'defaultModels' ELSE '{}'::jsonb END) e("k", "v")
        JOIN a ON e."k" = a."slug" OR e."k" LIKE '%:' || a."slug" OR e."k" = 'opencode/' || a."slug"
               OR starts_with(e."v", 'orbit-' || a."slug" || '/')
       WHERE ${reaches('pu."id"')}
      UNION ALL
      SELECT 'wiki_space', w."id"::text, w."owner_id", w."settings"#>>'{maintenance,provider}' FROM "wiki_space" w
        JOIN a ON a."slug" = w."settings"#>>'{maintenance,provider}'
       WHERE ${reaches('w."owner_id"')}
      UNION ALL
      SELECT 'workspace', w."id"::text, w."owner_id", f->>'provider' FROM "workspace" w
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(w."provider_fallbacks") = 'array'
                                                     THEN w."provider_fallbacks" ELSE '[]'::jsonb END) f
        JOIN a ON a."slug" = f->>'provider'
       WHERE ${reaches('w."owner_id"')}
      ORDER BY 1, 2`);
  return found.length > 0
    ? found.map((row) => ({
        step: 'alias-reference', table: row.tableName, rowId: row.rowId, ownerId: row.ownerId, action: 'UNRESOLVED',
        before: { names: row.slug }, note: 'still names a retired provider name; it resolves through it',
      }))
    : [{ step: 'alias-reference', table: 'provider_slug_alias', rowId: null, ownerId: null, action: 'NOOP', note: 'no open session or task pin, preference, maintenance setting or fallback names a retired provider name' }];
}

/** Report lines into the run's table, in the transaction (or the client) the caller writes in. */
async function writeReport(db: Prisma.TransactionClient, runId: string, lines: ReportLine[]): Promise<void> {
  if (lines.length === 0) return;
  await db.providerEngineMigrationReport.createMany({
    data: lines.map((line) => ({
      runId,
      step: line.step,
      tableName: line.table,
      rowId: line.rowId,
      ownerId: line.ownerId,
      action: line.action,
      ...(line.before === undefined ? {} : { before: line.before as Prisma.InputJsonValue }),
      ...(line.after === undefined ? {} : { after: line.after as Prisma.InputJsonValue }),
      ...(line.note === undefined ? {} : { note: line.note }),
    })),
  });
}

function summarize(
  lines: ReportLine[],
  facts: Pick<MigrationSummary, 'fullScan' | 'complete' | 'leftOver' | 'failures' | 'legacyRowsLeft'>,
): MigrationSummary {
  const actions: MigrationSummary['actions'] = {};
  const steps: MigrationSummary['steps'] = {};
  for (const line of lines) {
    actions[line.action] = (actions[line.action] ?? 0) + 1;
    const step = (steps[line.step] ??= {});
    step[line.action] = (step[line.action] ?? 0) + 1;
  }
  const isAliasReference = (line: ReportLine) => line.action === 'UNRESOLVED' && line.step === 'alias-reference';
  return {
    version: PROVIDER_ENGINE_MIGRATION_VERSION,
    ...facts,
    actions,
    steps,
    resolutions: { same: steps.resolution?.SAME ?? 0, changed: steps.resolution?.CHANGED ?? 0 },
    aliasReferences: lines.filter(isAliasReference).length,
  };
}
