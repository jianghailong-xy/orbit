import { Prisma } from '@prisma/client';
import type { WikiEntryKind, WikiEntryStatus, WikiOp, WikiRejectReason, WikiSimilar, WikiTrust } from '@orbit/shared';

/**
 * The near neighbours of a changeset's drafts, read BEFORE its transaction opens (§4.1 step 8).
 *
 * A changeset is one interactive transaction, and Prisma closes it after the timeout it was given. Of
 * everything an add does inside it, the neighbour lookup is the one step whose cost grows with the space:
 * the trigram index hands it a few hundred candidates in a space of 10,000, and each is tested by
 * extracting the trigrams of its text. On 2026-09-29 a maintenance run's thirty adds spent about a third
 * of the transaction there and it closed under them (P2028). The lookup is a pure read, so it moves out:
 * every draft's neighbours are read here in one statement, and the transaction only re-checks them.
 *
 * WHAT THE TRANSACTION STILL READS
 * --------------------------------
 * `similar[]` must be what the lookup inside the transaction would have answered, because the review
 * card shows it and a verification may only name a duplicate from it. Two things can make an answer read
 * here wrong by the time an op records it, and the transaction checks both before it uses one:
 *
 *  - Another transaction changed a neighbour since. `recheck` re-reads every listed neighbour in one
 *    statement — its revision, status, trust and the reasons it was rejected: everything `similar[]`
 *    shows of it that can change — and a draft that lists one that moved is looked up again, inside.
 *  - An earlier op of the same changeset wrote something the draft would meet: a lineage an add or a
 *    supersede wrote (the pair is found here, by the same trigram test, over the content it will be
 *    written with), an entry an op changed that the draft lists, or an entry an applied amend rewrote,
 *    which could now rank anywhere. Those drafts are looked up again too.
 *
 * An entry another transaction adds in between is not seen, and need not be: a transaction at READ
 * COMMITTED sees a concurrent commit only if it lands before the statement that reads, so the answer
 * read here is the answer the lookup inside gives when that commit lands a moment later — a race the
 * lookup always had, not a new one.
 */

/** The reads a lookup makes, through the pool before the transaction and through its client inside it. */
type Reader = Pick<Prisma.TransactionClient, '$queryRaw' | 'wikiChangesetOp'>;

/** A neighbour as the lookup's statement returns it. */
export interface NeighbourRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  trust: string;
  score: number;
  rejectedReason: string | null;
}

/** One add's or supersede's draft, by its position in the changeset. */
export interface NeighbourDraft {
  seq: number;
  /** What its neighbours are matched against (`neighbourText`). */
  text: string;
  /** The entry a supersede replaces: never its own neighbour. */
  exclude: string | null;
  /** The content its lineage is written with if it is recorded: what a later draft of the changeset meets. */
  written: { title: string; summary: string; aliases: readonly string[]; fields: unknown };
}

/** What a lookup matches a draft by: its title and its summary. */
export function neighbourText(draft: Record<string, unknown>): string {
  const title = typeof draft.title === 'string' ? draft.title : '';
  const summary = typeof draft.summary === 'string' ? draft.summary : '';
  return `${title} ${summary}`.trim();
}

/**
 * The verifier's own words for each of these entries a verification rejected (contract
 * `reviewModes.verification.verdicts.unsupported`). Only a verdict that rejected it: an op its
 * verification found supported, which the owner then rejected, carries the verifier's reason for the
 * opposite answer.
 */
export async function verificationRejections(
  db: Pick<Prisma.TransactionClient, 'wikiChangesetOp'>,
  ownerId: string,
  entryIds: readonly string[],
): Promise<Map<string, string>> {
  const because = new Map<string, string>();
  if (entryIds.length === 0) return because;
  const verdicts = await db.wikiChangesetOp.findMany({
    where: {
      ownerId,
      resultEntryId: { in: [...entryIds] },
      decision: 'rejected',
      verificationVerdict: { in: ['unsupported', 'duplicate'] },
    },
    orderBy: { decidedAt: 'desc' },
    select: { resultEntryId: true, verificationReason: true },
  });
  for (const verdict of verdicts) {
    if (verdict.resultEntryId && verdict.verificationReason && !because.has(verdict.resultEntryId)) {
      because.set(verdict.resultEntryId, verdict.verificationReason);
    }
  }
  return because;
}

/** Rows as `similar[]` shows them: a rejected neighbour with the reason, and the verifier's words when a verification rejected it. */
export function similarOf(rows: readonly NeighbourRow[], because: ReadonlyMap<string, string>): WikiSimilar[] {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as WikiEntryKind,
    title: row.title,
    status: row.status as WikiEntryStatus,
    trust: row.trust as WikiTrust,
    score: Number(row.score),
    ...(row.rejectedReason ? { rejectedReason: row.rejectedReason as WikiRejectReason } : {}),
    ...(because.has(row.id) ? { rejectedBecause: because.get(row.id) } : {}),
  }));
}

/** What `similar[]` shows of a neighbour that can change without its id changing. */
interface Seen {
  currentRevision: number;
  status: string;
  trust: string;
  rejectedReason: string | null;
  rejectedBecause: string | null;
}

interface Answer {
  text: string;
  exclude: string | null;
  similar: WikiSimilar[];
}

/** Every draft's neighbours, as one statement read them before the transaction. */
export class ChangesetNeighbours {
  private constructor(
    private readonly answers: ReadonlyMap<number, Answer>,
    private readonly seen: ReadonlyMap<string, Seen>,
    /** For each draft, the earlier drafts whose lineage, once written, would be among its neighbours. */
    private readonly earlier: ReadonlyMap<number, readonly number[]>,
  ) {}

  /**
   * One statement for every draft's five, over the trigram index as `nearNeighbours` reads it — each
   * draft's text a column of the outer rows, never a constant the planner would test the index's
   * statistics against — and one for the pairs of drafts that would meet each other.
   */
  static async read(db: Reader, ownerId: string, spaceId: string, drafts: readonly NeighbourDraft[]): Promise<ChangesetNeighbours> {
    // An empty text has no neighbours and asks nothing, as in `nearNeighbours`.
    const asked = drafts.filter((draft) => draft.text !== '');
    const rows = asked.length === 0
      ? []
      : await db.$queryRaw<Array<NeighbourRow & { seq: number; currentRevision: number }>>(Prisma.sql`
          SELECT d."seq" AS "seq",
                 n."id" AS "id",
                 n."kind" AS "kind",
                 n."title" AS "title",
                 n."status" AS "status",
                 n."trust" AS "trust",
                 n."score" AS "score",
                 n."currentRevision" AS "currentRevision",
                 (SELECT o."decision_reason"
                    FROM "wiki_changeset_op" o
                   WHERE o."result_entry_id" = n."id" AND o."decision" = 'rejected'
                   ORDER BY o."decided_at" DESC NULLS LAST
                   LIMIT 1) AS "rejectedReason"
            FROM unnest(${asked.map((draft) => draft.seq)}::int[], ${asked.map((draft) => draft.text)}::text[],
                        ${asked.map((draft) => draft.exclude)}::uuid[]) AS d("seq", "text", "exclude")
            CROSS JOIN LATERAL (
              SELECT e."id", e."kind", e."title", e."status", e."trust", e."current_revision" AS "currentRevision",
                     e."recorded_at" AS "recordedAt",
                     similarity(wiki_entry_search_text(e."title", e."summary", e."aliases", e."fields"), d."text")::float8 AS "score"
                FROM "wiki_entry" e
               WHERE e."owner_id" = ${ownerId}::uuid
                 AND e."space_id" = ${spaceId}::uuid
                 AND (d."exclude" IS NULL OR e."id" <> d."exclude")
                 AND wiki_entry_search_text(e."title", e."summary", e."aliases", e."fields") % d."text"
               ORDER BY "score" DESC, e."recorded_at" DESC
               LIMIT 5
            ) n
           ORDER BY d."seq", n."score" DESC, n."recordedAt" DESC
        `);
    const because = await verificationRejections(
      db,
      ownerId,
      [...new Set(rows.filter((row) => row.rejectedReason !== null).map((row) => row.id))],
    );
    const answers = new Map<number, Answer>();
    for (const draft of drafts) {
      const own = rows.filter((row) => row.seq === draft.seq);
      answers.set(draft.seq, { text: draft.text, exclude: draft.exclude, similar: similarOf(own, because) });
    }
    const seen = new Map<string, Seen>();
    for (const row of rows) {
      seen.set(row.id, {
        currentRevision: row.currentRevision,
        status: row.status,
        trust: row.trust,
        rejectedReason: row.rejectedReason,
        rejectedBecause: because.get(row.id) ?? null,
      });
    }
    // The drafts of one changeset meet each other only once written, which happens inside the
    // transaction; which pairs would is known here. The content is the one the lineage is written with,
    // under the same trigram test the lookup makes.
    const pairs = drafts.length < 2
      ? []
      : await db.$queryRaw<Array<{ earlier: number; later: number }>>(Prisma.sql`
          WITH "written" AS MATERIALIZED (
            SELECT w."seq",
                   wiki_entry_search_text(w."title", w."summary",
                                          ARRAY(SELECT jsonb_array_elements_text(w."aliases"::jsonb)),
                                          w."fields"::jsonb) AS "searchText"
              FROM unnest(${drafts.map((draft) => draft.seq)}::int[],
                          ${drafts.map((draft) => draft.written.title)}::text[],
                          ${drafts.map((draft) => draft.written.summary)}::text[],
                          ${drafts.map((draft) => JSON.stringify(draft.written.aliases))}::text[],
                          ${drafts.map((draft) => JSON.stringify(draft.written.fields ?? null))}::text[])
                     AS w("seq", "title", "summary", "aliases", "fields")
          )
          SELECT w."seq" AS "earlier", d."seq" AS "later"
            FROM "written" w
            JOIN unnest(${asked.map((draft) => draft.seq)}::int[], ${asked.map((draft) => draft.text)}::text[])
                   AS d("seq", "text") ON d."seq" > w."seq"
           WHERE w."searchText" % d."text"
        `);
    const earlier = new Map<number, number[]>();
    for (const pair of pairs) earlier.set(pair.later, [...(earlier.get(pair.later) ?? []), pair.earlier]);
    return new ChangesetNeighbours(answers, seen, earlier);
  }

  /**
   * Inside the transaction, before its first op: every neighbour listed re-read in one statement, and
   * the drafts that list one that moved since marked to be looked up again. What it answers is this
   * attempt's alone — a retried transaction re-checks from the start.
   */
  async recheck(tx: Reader, ownerId: string): Promise<NeighbourLookups> {
    const ids = [...this.seen.keys()];
    if (ids.length === 0) return new NeighbourLookups(this, new Set());
    const now = await tx.$queryRaw<Array<{ id: string; currentRevision: number; status: string; trust: string; rejectedReason: string | null }>>(Prisma.sql`
      SELECT e."id" AS "id",
             e."current_revision" AS "currentRevision",
             e."status" AS "status",
             e."trust" AS "trust",
             (SELECT o."decision_reason"
                FROM "wiki_changeset_op" o
               WHERE o."result_entry_id" = e."id" AND o."decision" = 'rejected'
               ORDER BY o."decided_at" DESC NULLS LAST
               LIMIT 1) AS "rejectedReason"
        FROM "wiki_entry" e
       WHERE e."owner_id" = ${ownerId}::uuid AND e."id" = ANY(${ids}::uuid[])
    `);
    const because = await verificationRejections(tx, ownerId, now.filter((row) => row.rejectedReason !== null).map((row) => row.id));
    // A neighbour that is gone is as moved as one that changed.
    const moved = new Set(ids);
    for (const row of now) {
      const before = this.seen.get(row.id);
      if (
        before
        && before.currentRevision === row.currentRevision
        && before.status === row.status
        && before.trust === row.trust
        && before.rejectedReason === row.rejectedReason
        && before.rejectedBecause === (because.get(row.id) ?? null)
      ) {
        moved.delete(row.id);
      }
    }
    const stale = new Set<number>();
    for (const [seq, answer] of this.answers) {
      if (answer.similar.some((near) => moved.has(near.id))) stale.add(seq);
    }
    return new NeighbourLookups(this, stale);
  }

  /** @internal What was read for one draft. */
  answerFor(seq: number): Answer | undefined {
    return this.answers.get(seq);
  }

  /** @internal The earlier drafts whose lineage this draft would meet. */
  earlierOf(seq: number): readonly number[] {
    return this.earlier.get(seq) ?? [];
  }
}

/** One attempt's use of the answers: which still stand, given what the attempt has written so far. */
export class NeighbourLookups {
  /** The drafts whose lineage this attempt wrote. */
  private readonly written = new Set<number>();
  /** The existing entries it changed. */
  private readonly touched = new Set<string>();
  /** An amend it applied rewrote an entry, which can now rank anywhere. */
  private rewrote = false;

  constructor(
    private readonly reads: ChangesetNeighbours,
    private readonly stale: ReadonlySet<number>,
  ) {}

  /**
   * The draft's neighbours as read before the transaction, when nothing since can have changed them;
   * null when they have to be looked up inside it. The text and the excluded entry are the lookup's own,
   * so an answer read for another question is never handed out.
   */
  answer(seq: number, text: string, exclude: string | null): WikiSimilar[] | null {
    const read = this.reads.answerFor(seq);
    if (!read || read.text !== text || read.exclude !== exclude) return null;
    if (this.stale.has(seq) || this.rewrote) return null;
    if (read.similar.some((near) => this.touched.has(near.id))) return null;
    if (this.reads.earlierOf(seq).some((earlier) => this.written.has(earlier))) return null;
    return read.similar;
  }

  /**
   * An op this attempt recorded, as a later draft meets it — what `recordOp` writes at once: every add's
   * and supersede's lineage, the entry an applied op names (a supersede's target, an amend's, a retire's)
   * and a challenge's, whose flag is written whether or not anything applied.
   */
  recorded(op: { seq: number; op: WikiOp; entryId: string | null; applied: boolean }): void {
    if (op.op === 'add' || op.op === 'supersede') this.written.add(op.seq);
    if (op.entryId && (op.applied || op.op === 'challenge')) this.touched.add(op.entryId);
    if (op.op === 'amend' && op.applied) this.rewrote = true;
  }
}
