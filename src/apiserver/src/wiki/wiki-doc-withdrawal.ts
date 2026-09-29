import { Prisma } from '@prisma/client';
import type { WikiDocWithdrawReason } from '@orbit/shared';

/**
 * The documents' withdrawal (contract `docs.withdrawal`, criterion 9): a sentence whose footnote came
 * through an entry that has since been rejected, retired or superseded, or whose anchor changed or went
 * missing, is withdrawn, and its section is marked for the next maintenance run to write again.
 *
 * WHERE IT HANGS. `WikiService.recomputeFlags` calls it, in the entry's own transaction: every
 * `applyOp` branch ends there, and those two are the entry's only state writers (design §3,
 * `storage.singleWriter`). So there is no second path that moves an entry and forgets its documents,
 * and no new writer of an entry's state. It lives in a file of its own, apart from `wiki-docs.ts`, so
 * that `wiki.service.ts` can import it without the two files importing each other.
 *
 * LOCKS. By the time it runs the entry's row is held (recomputeFlags has just updated it), so a document
 * write that cites through this entry — which takes its via entries FOR SHARE before anything else —
 * has either committed already, and is seen here, or waits for this transaction. The documents are
 * then taken in id order (FOR NO KEY UPDATE, as their writer takes one), their sentences withdrawn, and
 * their sections marked stale: entries before documents, which is the order the writer takes them in.
 */

/** Anything that runs this inside a transaction the caller holds. */
type Tx = Prisma.TransactionClient;

/** Why an entry in this state withdraws the sentences that came through it, or null when it does not. */
export function docWithdrawReason(entry: { status: string; anchorState: string | null }): WikiDocWithdrawReason | null {
  switch (entry.status) {
    case 'rejected':
      return 'rejected';
    case 'retired':
      return 'retired';
    case 'superseded':
      return 'superseded';
    default:
      break;
  }
  if (entry.anchorState === 'changed') return 'anchor_changed';
  if (entry.anchorState === 'missing') return 'anchor_missing';
  return null;
}

/**
 * Withdraw every sentence a footnote of which came through `entryId`, and mark the sections they are
 * in stale. The number of sentences withdrawn; 0, and nothing locked, when no document cites through it.
 */
export async function withdrawDocSentences(tx: Tx, ownerId: string, entryId: string, reason: WikiDocWithdrawReason): Promise<number> {
  const cited = await tx.$queryRaw<Array<{ docId: string }>>(Prisma.sql`
    SELECT DISTINCT x."doc_id"::text AS "docId"
      FROM "wiki_doc_footnote" f
      JOIN "wiki_doc_sentence" s ON s."id" = f."sentence_id" AND s."owner_id" = f."owner_id"
      JOIN "wiki_doc_section" x ON x."id" = s."section_id" AND x."owner_id" = s."owner_id"
     WHERE f."owner_id" = ${ownerId}::uuid
       AND f."via_entry_id" = ${entryId}::uuid
       AND s."status" <> 'withdrawn'
  `);
  if (cited.length === 0) return 0;
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "wiki_doc"
     WHERE "owner_id" = ${ownerId}::uuid AND "id" = ANY(${cited.map((row) => row.docId)}::uuid[])
     ORDER BY "id"
     FOR NO KEY UPDATE`);
  const now = new Date();
  const withdrawn = await tx.$queryRaw<Array<{ sectionId: string }>>(Prisma.sql`
    UPDATE "wiki_doc_sentence" s
       SET "status" = 'withdrawn',
           "new_tokens" = '{}',
           "withdrawn_at" = ${now},
           "withdrawn_entry_id" = ${entryId}::uuid,
           "withdrawn_reason" = ${reason}
     WHERE s."owner_id" = ${ownerId}::uuid
       AND s."status" <> 'withdrawn'
       AND s."id" IN (SELECT f."sentence_id" FROM "wiki_doc_footnote" f
                       WHERE f."owner_id" = ${ownerId}::uuid AND f."via_entry_id" = ${entryId}::uuid)
    RETURNING s."section_id"::text AS "sectionId"
  `);
  const sections = [...new Set(withdrawn.map((row) => row.sectionId))];
  if (sections.length > 0) {
    await tx.wikiDocSection.updateMany({ where: { ownerId, id: { in: sections }, staleAt: null }, data: { staleAt: now } });
  }
  return withdrawn.length;
}
