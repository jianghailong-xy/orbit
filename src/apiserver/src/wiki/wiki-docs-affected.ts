import { Prisma } from '@prisma/client';
import {
  WIKI_DOC_REPO_KINDS,
  WIKI_DOCS_AFFECTED_RULES,
  type WikiDocsAffected,
  type WikiDocsPathWithdrawalResult,
  type WikiDocsUnplacedEntry,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { anchorPathsOf, entryProjects, sectionFit, storedSessionCondition, type FitCandidate, type StoredSessionCondition } from './wiki-docs-material';
import { wikiPlanTopics } from './wiki-plan';

/**
 * What a maintenance run writes again, and what it may propose (criterion 3, revision 3; contracts/
 * wiki.contract.json `docs.affected`, `docs.withdrawal.paths`).
 *
 * WHERE AN ENTRY BELONGS. An entry belongs to a section of the plan when it fits the section's session
 * condition (`sectionFit`, wiki-docs-material.ts): by the condition's keywords, anchor paths, projects,
 * entry kinds and topics — the rule the section's material picks its entries by, so a section an entry
 * fits is one whose material the entry is in, up to the section's cap.
 *
 * WHAT IS WRITTEN AGAIN. A written section is written again when an entry that fits it changed after the
 * section was generated — a maintenance run's own ops, and every other applied op since, so a run that
 * failed, or the owner's acceptance of a waiting op, loses nothing — and when a sentence of it was
 * withdrawn (stale). Whether its material really changed is the fingerprint's to say, on the runner: a
 * section whose fingerprint is the stored one is left as it is. The repository's half — the design
 * documents, code and contracts a section cites, changed on origin/main since its repoSha — is the run's
 * to find in its checkout: the server has none.
 *
 * WHAT HAS NO PLACE. An entry changed since the plan was first drafted that fits no section of the
 * confirmed plan, and that no proposal names — accepted, rejected or pending — is new knowledge the plan
 * has no place for: what a run's plan proposal is made of, one proposal a run at most, the rest waiting for
 * the next. The run adds the design documents new on origin/main that no section cites.
 *
 * A FILE THAT IS GONE. A repository file a section's footnotes cite that was deleted or renamed on
 * origin/main withdraws every sentence citing it, as its anchor gone missing (`withdrawDocSentencesByPath`),
 * and marks its section stale: the next write of it is from what origin/main has now.
 *
 * Reads only, but for the withdrawal; nothing here is a Sessions or Projects dependency.
 */

type Db = PrismaService;
type Tx = Prisma.TransactionClient;

// ── What a run writes again, and what has no place ──────────────────────────────────────────────

interface PlanSectionRow {
  key: string;
  sources: unknown;
}

interface ChangedEntry {
  id: string;
  kind: string;
  title: string;
  summary: string;
  blob: string;
  topics: string[];
  anchors: unknown;
  changedAt: Date;
}

/** A section's session condition as the plan stores it, its projects as ids (`storedSessionCondition`), or null. */
function conditionOf(sources: unknown): StoredSessionCondition | null {
  return storedSessionCondition(sources && typeof sources === 'object' ? (sources as { sessions?: unknown }).sessions : null);
}

/** The design documents a plan's sections and a proposal's document cite: `sources.docs[].path`. */
function docPathsOf(sections: ReadonlyArray<{ sources?: unknown }>): string[] {
  return sections.flatMap((section) => {
    const docs = section.sources && typeof section.sources === 'object' ? (section.sources as { docs?: unknown }).docs : null;
    return Array.isArray(docs)
      ? docs.flatMap((doc) => {
        const path = doc && typeof doc === 'object' ? (doc as { path?: unknown }).path : null;
        return typeof path === 'string' && path.trim() !== '' ? [path.trim().replace(/^\.\//u, '')] : [];
      })
      : [];
  });
}

/**
 * The runner door's read of what a maintenance run writes again because of the entries, and what it may
 * propose (contract `docs.reads.affected`). The caller has been found a maintenance run of the space.
 */
export async function wikiDocsAffected(db: Db, ownerId: string, spaceId: string): Promise<WikiDocsAffected> {
  const [confirmed, build, proposals, topics] = await Promise.all([
    db.wikiPlan.findFirst({
      where: { ownerId, spaceId, status: 'confirmed' },
      select: {
        id: true,
        version: true,
        confirmedAt: true,
        repoSha: true,
        baseVersion: true,
        docs: { orderBy: { position: 'asc' }, select: { slug: true, sections: { orderBy: { position: 'asc' }, select: { key: true, sources: true } } } },
      },
    }),
    db.wikiPlanJob.findFirst({
      where: { ownerId, spaceId, kind: 'build', state: { in: ['queued', 'held', 'made'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, state: true, version: true },
    }),
    db.wikiPlanProposal.findMany({ where: { ownerId, spaceId }, select: { facts: true, change: true } }),
    wikiPlanTopics(db, ownerId, spaceId),
  ]);
  const proposed = { entryIds: new Set<string>(), commits: new Set<string>(), paths: new Set<string>() };
  for (const proposal of proposals) {
    for (const fact of Array.isArray(proposal.facts) ? (proposal.facts as Array<{ kind?: unknown; id?: unknown }>) : []) {
      if (fact.kind === 'entry' && typeof fact.id === 'string') proposed.entryIds.add(fact.id);
      if (fact.kind === 'commit' && typeof fact.id === 'string') proposed.commits.add(fact.id);
    }
    const doc = (proposal.change as { doc?: { sections?: Array<{ sources?: unknown }> } } | null)?.doc;
    for (const path of docPathsOf(doc?.sections ?? [])) proposed.paths.add(path);
  }
  const proposedView = { entryIds: [...proposed.entryIds], commits: [...proposed.commits], paths: [...proposed.paths] };
  const buildView = build
    ? { jobId: build.id, state: (build.state === 'made' ? 'running' : build.state) as 'queued' | 'held' | 'running', version: build.version ?? 0 }
    : null;
  if (!confirmed?.confirmedAt) {
    return { spaceId, plan: null, build: buildView, sections: [], unplaced: [], unplacedMore: 0, proposed: proposedView, topics };
  }

  // The commit the plan's references were last checked at: the confirmed version's, or the newest of the
  // versions it was made from (an owner's edit or an accepted proposal checks nothing on a runner).
  let repoSha = confirmed.repoSha;
  for (let base = confirmed.baseVersion, hops = 0; !repoSha && base !== null && hops < 1_000; hops += 1) {
    const earlier = await db.wikiPlan.findFirst({ where: { ownerId, spaceId, version: base }, select: { repoSha: true, baseVersion: true } });
    if (!earlier) break;
    repoSha = earlier.repoSha;
    base = earlier.baseVersion;
  }
  const first = await db.wikiPlan.findFirst({ where: { ownerId, spaceId }, orderBy: { version: 'asc' }, select: { createdAt: true } });
  const draftedAt = first?.createdAt ?? confirmed.confirmedAt;

  const written = await db.wikiDocSection.findMany({
    where: { ownerId, doc: { ownerId, spaceId } },
    select: { key: true, repoSha: true, generatedAt: true, staleAt: true, doc: { select: { slug: true } } },
  });
  const writtenOf = new Map(written.map((section) => [`${section.doc.slug}#${section.key}`, section]));
  const conditioned: Array<{ doc: string; section: PlanSectionRow; condition: StoredSessionCondition }> = [];
  for (const doc of confirmed.docs) {
    for (const section of doc.sections) {
      const condition = conditionOf(section.sources);
      if (condition) conditioned.push({ doc: doc.slug, section, condition });
    }
  }

  // Every entry an op was applied to since the earliest point anything here is measured from: applied by
  // the space's mode (auto_applied, or pending a spot check it was applied before), or accepted or edited
  // by the owner — each at the moment it was decided, or, for one applied before its spot check, recorded.
  const earliest = written.reduce((min, section) => (section.generatedAt < min ? section.generatedAt : min), draftedAt);
  const changed = await db.$queryRaw<Array<ChangedEntry>>(Prisma.sql`
    SELECT e."id"::text AS "id", e."kind" AS "kind", e."title" AS "title", e."summary" AS "summary",
           e."title" || ' ' || e."summary" || ' ' || e."fields"::text || ' ' || array_to_string(e."aliases", ' ') AS "blob",
           e."topics" AS "topics", e."anchors" AS "anchors", max(coalesce(op."decided_at", c."created_at")) AS "changedAt"
      FROM "wiki_changeset_op" op
      JOIN "wiki_changeset" c ON c."id" = op."changeset_id" AND c."owner_id" = op."owner_id"
      JOIN "wiki_entry" e ON e."id" = coalesce(op."result_entry_id", op."entry_id") AND e."owner_id" = op."owner_id"
     WHERE op."owner_id" = ${ownerId}::uuid AND c."space_id" = ${spaceId}::uuid
       AND (op."decision" IN ('auto_applied', 'accepted', 'edited')
            OR (op."decision" = 'pending' AND op."spot_check" AND op."applied_by_mode" IS NOT NULL))
       AND coalesce(op."decided_at", c."created_at") > ${earliest}
       AND e."space_id" = ${spaceId}::uuid AND e."status" = 'active' AND e."anchor_state" NOT IN ('changed', 'missing')
     GROUP BY e."id"
     ORDER BY max(coalesce(op."decided_at", c."created_at")) DESC, e."id"`);
  const projects = await entryProjects(db, ownerId, changed.map((entry) => entry.id));
  const candidates = changed.map((entry) => ({
    entry,
    fit: {
      id: entry.id,
      kind: entry.kind,
      blob: entry.blob,
      topics: entry.topics ?? [],
      anchorPaths: anchorPathsOf(entry.anchors),
      projects: projects.get(entry.id) ?? new Set<string>(),
    } satisfies FitCandidate,
  }));

  const placed = new Set<string>();
  const sections: WikiDocsAffected['sections'] = [];
  for (const { doc, section, condition } of conditioned) {
    const stored = writtenOf.get(`${doc}#${section.key}`);
    const entryIds: string[] = [];
    for (const { entry, fit } of candidates) {
      if (!sectionFit(condition, fit).fits) continue;
      placed.add(entry.id);
      if (stored && entry.changedAt > stored.generatedAt) entryIds.push(entry.id);
    }
    if (stored && (entryIds.length > 0 || stored.staleAt !== null)) {
      sections.push({ doc, key: section.key, repoSha: stored.repoSha, generatedAt: stored.generatedAt.toISOString(), stale: stored.staleAt !== null, entryIds });
    }
  }
  // A stale section with no session condition — a withdrawn sentence of a mechanism — is written again too.
  for (const stored of written) {
    if (stored.staleAt === null || sections.some((s) => s.doc === stored.doc.slug && s.key === stored.key)) continue;
    if (!confirmed.docs.some((doc) => doc.slug === stored.doc.slug && doc.sections.some((section) => section.key === stored.key))) continue;
    sections.push({ doc: stored.doc.slug, key: stored.key, repoSha: stored.repoSha, generatedAt: stored.generatedAt.toISOString(), stale: true, entryIds: [] });
  }

  const unplacedAll: WikiDocsUnplacedEntry[] = candidates
    .filter(({ entry }) => entry.changedAt > draftedAt && !placed.has(entry.id) && !proposed.entryIds.has(entry.id))
    .map(({ entry, fit }) => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary,
      topics: [...fit.topics],
      anchorPaths: [...fit.anchorPaths],
      changedAt: entry.changedAt.toISOString(),
    }));
  const unplaced = unplacedAll.slice(0, WIKI_DOCS_AFFECTED_RULES.unplacedMax);
  return {
    spaceId,
    plan: { version: confirmed.version, confirmedAt: confirmed.confirmedAt.toISOString(), repoSha, draftedAt: draftedAt.toISOString() },
    build: buildView,
    sections,
    unplaced,
    unplacedMore: unplacedAll.length - unplaced.length,
    proposed: proposedView,
    topics,
  };
}

// ── A file that is gone ─────────────────────────────────────────────────────────────────────────

/**
 * Withdraw every sentence of the space's documents with a repository footnote citing one of `paths` — files
 * deleted or renamed on origin/main — as its anchor gone missing, naming the path, and mark the sections
 * they are in stale. Documents are taken in id order (FOR NO KEY UPDATE), as their writer and the entry
 * withdrawal take them. A sentence withdrawn already is left as it is.
 */
export async function withdrawDocSentencesByPath(
  tx: Tx,
  ownerId: string,
  spaceId: string,
  paths: readonly string[],
): Promise<Omit<WikiDocsPathWithdrawalResult, 'spaceId'>> {
  if (paths.length === 0) return { withdrawn: 0, sections: [] };
  const kinds = [...WIKI_DOC_REPO_KINDS];
  const cited = await tx.$queryRaw<Array<{ docId: string }>>(Prisma.sql`
    SELECT DISTINCT x."doc_id"::text AS "docId"
      FROM "wiki_doc_footnote" f
      JOIN "wiki_doc_sentence" s ON s."id" = f."sentence_id" AND s."owner_id" = f."owner_id"
      JOIN "wiki_doc_section" x ON x."id" = s."section_id" AND x."owner_id" = s."owner_id"
      JOIN "wiki_doc" d ON d."id" = x."doc_id" AND d."owner_id" = x."owner_id"
     WHERE f."owner_id" = ${ownerId}::uuid AND d."space_id" = ${spaceId}::uuid
       AND f."kind" = ANY(${kinds}::text[]) AND f."ref" = ANY(${[...paths]}::text[])
       AND s."status" <> 'withdrawn'`);
  if (cited.length === 0) return { withdrawn: 0, sections: [] };
  const docIds = cited.map((row) => row.docId);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "wiki_doc" WHERE "owner_id" = ${ownerId}::uuid AND "id" = ANY(${docIds}::uuid[]) ORDER BY "id" FOR NO KEY UPDATE`);
  const now = new Date();
  const withdrawn = await tx.$queryRaw<Array<{ sectionId: string }>>(Prisma.sql`
    UPDATE "wiki_doc_sentence" s
       SET "status" = 'withdrawn',
           "new_tokens" = '{}',
           "withdrawn_at" = ${now},
           "withdrawn_entry_id" = NULL,
           "withdrawn_path" = (SELECT min(f."ref") FROM "wiki_doc_footnote" f
                                WHERE f."sentence_id" = s."id" AND f."owner_id" = s."owner_id"
                                  AND f."kind" = ANY(${kinds}::text[]) AND f."ref" = ANY(${[...paths]}::text[])),
           "withdrawn_reason" = 'anchor_missing'
     WHERE s."owner_id" = ${ownerId}::uuid
       AND s."status" <> 'withdrawn'
       AND s."section_id" IN (SELECT x."id" FROM "wiki_doc_section" x WHERE x."owner_id" = ${ownerId}::uuid AND x."doc_id" = ANY(${docIds}::uuid[]))
       AND s."id" IN (SELECT f."sentence_id" FROM "wiki_doc_footnote" f
                       WHERE f."owner_id" = ${ownerId}::uuid AND f."kind" = ANY(${kinds}::text[]) AND f."ref" = ANY(${[...paths]}::text[]))
    RETURNING s."section_id"::text AS "sectionId"`);
  const sectionIds = [...new Set(withdrawn.map((row) => row.sectionId))];
  if (sectionIds.length === 0) return { withdrawn: 0, sections: [] };
  await tx.wikiDocSection.updateMany({ where: { ownerId, id: { in: sectionIds }, staleAt: null }, data: { staleAt: now } });
  const named = await tx.wikiDocSection.findMany({
    where: { ownerId, id: { in: sectionIds } },
    orderBy: [{ docId: 'asc' }, { key: 'asc' }],
    select: { key: true, doc: { select: { slug: true } } },
  });
  return { withdrawn: withdrawn.length, sections: named.map((section) => ({ doc: section.doc.slug, key: section.key })) };
}
