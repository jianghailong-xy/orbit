import { Logger, NotFoundException } from '@nestjs/common';
import {
  WIKI_DOCS_BUILD_JOB,
  WIKI_DOCS_FOLLOW,
  WIKI_MAINTAIN_JOB,
  type WikiDocsFollowFact,
  type WikiDocsFollowReport,
  type WikiDocsFollowReportSection,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { wikiDocsBuildJobPrincipal, type WikiDocWriteCause } from '../wiki/wiki-docs';
import { markWikiDocSectionsStale, wikiDocsFollowFactsOf, wikiDocsFollowSectionsToday } from '../wiki/wiki-docs-follow';
import { gatherDocMaterial, gatherPressMaterial } from '../wiki/wiki-docs-material';
import { ownerEnvLiterals } from '../wiki/wiki-dossier';
import {
  runWikiDocsBuild,
  WikiDocsCallFailed,
  type WikiDocsBuildSectionRun,
  type WikiDocsStoredSection,
  type WikiDocsWriteAnswer,
} from './wiki-docs-build';
import {
  operation,
  readConfirmedPlan,
  readFiles,
  write,
  WikiDocsSnapshotRepo,
  type WikiDocsBuildJobDeps,
} from './wiki-docs-build-job';
import {
  wikiDocCodePieces,
  wikiDocContract,
  wikiDocDocSection,
  wikiDocRepoPieces,
  wikiDocSectionWords,
  type WikiDocPiece,
  type WikiDocsPlanDoc,
  type WikiDocsPlanSection,
} from './wiki-docs-writer';
import { cutRunes } from './wiki-import-extract';
import { WikiJobContentError, WikiJobInfraError, type WikiJobContext, type WikiJobRunner } from './wiki-job-executor';
import { readWikiJobCarry, wikiJobCarryWriter, writeWikiJobProgress } from './wiki-jobs';
import { baseTreeOf, diffAnswerOf, gitChangesOf, pathNamed, samePieces, sectionPaths } from './wiki-maintain-job';
import { wikiJobModelCalls } from './wiki-model-queue';
import { readWikiRepoReadiness, readWikiRepoSnapshot, wikiRepoStepsCanRun } from './wiki-repo-ops';

/**
 * The follow job, `docs_follow` (contracts/wiki.contract.json `docs.follow`, `jobs.kindRuns.docs_follow`;
 * docs/wiki-contract.md §29; design docs/wiki-chat-design.md §8.1–§8.3): the sections a chat's press or a change that
 * reached main touched, written again by the wiki-worker with the System model, at once — not when maintenance is
 * next due, and not skipped while the space catches up (`docs.follow.catchUp`): it writes only what changed.
 *
 * WHAT IT WRITES (`docs.follow.sections`). A press's sections — the card's Rewrites — whatever their fingerprint: the
 * press marked them stale, and the job marks again one a writer cleared since (a maintenance run that wrote the section
 * before this job could), so a press is never answered by a section it did not write. For the merges and landings it
 * carries, each written section of the confirmed plan that cites a file one of their ranges of commits changed, whose
 * own material changed on origin/main since the commit it was written at — the comparison a maintenance run makes
 * (`maintenance.job.docs.byRepo`), narrowed to the files those commits changed; a cited file one of them deleted or
 * renamed away, and still gone, is withdrawn first (`docs.withdrawalPaths`). A section whose material did not change
 * asks no model and writes nothing, by its fingerprint (`docs.regeneration`). A document some of whose sections are
 * written has its overview handed to the writer as a build hands it.
 *
 * THE DAY'S BUDGET (`docs.follow.daily`). Of the sections merges and landings ask for — never a press's — a space's
 * follow jobs write at most `sectionsPerDay` (40) in one UTC day. Past it, the job writes them in the plan's order up to
 * what is left and leaves the rest as they are, still behind main, for the next maintenance run; its report says how
 * many it left, which Activity says (`wikiDocsFollowLeftRows`).
 *
 * WHAT IT HANDS THE WRITER BESIDES (`docs.follow.material`, design §8.2): a press's sections, the entries the card
 * wrote — through their live sources — and the owner's own words in the chat, before everything else, so the cap
 * cannot leave them out; a merge's sections, the files its commits changed, cut as a section's sources are cut and
 * read at the job's snapshot, after the section's own. Neither is part of the fingerprint: the next maintenance run
 * finds the section's own material unchanged and leaves what was written with them.
 *
 * HOW IT RUNS (`docs.follow.run`): as a build does (wiki-docs-build-job.ts) — the repository at one origin/main commit
 * read through the runner of the space's maintenance workspace, every call through the queue at the job's priority
 * under the build's steps and units of its own, each section written through `WikiDocs.write` as soon as it is done,
 * and keeping the version it replaced with the reason of the fact that asked for it: `chat` for a press, `merge` or
 * `landing` for a receipt (`docs.versions`). It runs beside a job of its space that writes no document and waits for
 * one that does (`jobs.onePerSpace`, the claim's).
 *
 * HOW IT ENDS (`docs.follow.outcomes`). Each section it took up is written, unchanged, gone (the confirmed plan no
 * longer has it) or failed. No section failed: the job succeeded. Otherwise it fails as content once every other
 * section was tried, with the others written, as a build does; the platform's failures are retried (`jobs.retry`).
 * The report — `{ sections, left, usage }` — is the whole job's: a section an earlier attempt wrote is carried on the
 * job's row as it is written (`jobs.carry`), and a replay neither marks it stale again nor writes it twice.
 */

/** What the job needs besides its context: what a build needs. */
export type WikiDocsFollowJobDeps = WikiDocsBuildJobDeps;

/** The runner the worker's module registers for `docs_follow`. */
export function wikiDocsFollowJobRunner(deps: WikiDocsFollowJobDeps): WikiJobRunner {
  return (context) => runWikiDocsFollowJob(context, deps) as unknown as Promise<Record<string, unknown>>;
}

/**
 * The changed files handed one section besides its own material, at most, in the order the diff named them: the
 * section's cap decides what of them the writer is shown, and this bounds what is read for it.
 */
const CHANGED_FILES_PER_SECTION = 8;

/** A file a document can be written from: text a cut reads, outside the directories no document cites. */
const TEXT_FILE = /\.(md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|go|swift|kt|kts|java|py|rb|rs|c|h|cc|cpp|hpp|cs|sql|sh|bash|ya?ml|toml|json|proto|css|scss|html|gradle)$/iu;

const logger = new Logger('WikiDocsFollowJob');

/** What a follow job carries to its replay (contract `jobs.carry.kinds.docs_follow`): each section it wrote. */
interface FollowCarry {
  sections: WikiDocsFollowReportSection[];
}

function followCarryOf(raw: unknown): FollowCarry {
  const sections = raw !== null && typeof raw === 'object' ? (raw as { sections?: unknown }).sections : undefined;
  return { sections: Array.isArray(sections) ? [...(sections as WikiDocsFollowReportSection[])] : [] };
}

const at = (doc: string, key: string): string => `${doc}#${key}`;

/** Rewrite what the job's facts touched, and say how each section came out. */
export async function runWikiDocsFollowJob(context: WikiJobContext, deps: WikiDocsFollowJobDeps): Promise<WikiDocsFollowReport> {
  const { job } = context;
  const { prisma } = deps;
  const facts = wikiDocsFollowFactsOf(job.input);
  if (facts.length === 0) throw new WikiJobContentError('the job carries no fact to follow (input.facts)');
  const principal = wikiDocsBuildJobPrincipal(job.ownerId);
  const { carry: carried, startedAt } = await readWikiJobCarry(prisma, job.id);
  const carry = followCarryOf(carried);
  const keep = wikiJobCarryWriter(prisma, job, () => ({ sections: carry.sections }));
  const writtenBefore = new Set(carry.sections.map((section) => at(section.doc, section.key)));

  // The presses' sections, each with the cards that asked for it and the newest press among them.
  const presses = facts.filter((fact): fact is Extract<WikiDocsFollowFact, { kind: 'press' }> => fact.kind === 'press');
  const merges = facts.filter((fact): fact is Extract<WikiDocsFollowFact, { kind: 'merge' | 'landing' }> => fact.kind !== 'press');
  const forced = new Map<string, { doc: string; key: string; draftIds: string[]; press: Extract<WikiDocsFollowFact, { kind: 'press' }> }>();
  for (const press of presses) {
    for (const section of press.sections) {
      const id = at(section.doc, section.key);
      const before = forced.get(id);
      forced.set(id, {
        doc: section.doc,
        key: section.key,
        draftIds: [...new Set([...(before?.draftIds ?? []), press.draftId])],
        press: !before || before.press.at <= press.at ? press : before.press,
      });
    }
  }
  const report: WikiDocsFollowReport = { kind: 'docs_follow', sha: '', sections: [], left: 0, usage: { inputTokens: 0, outputTokens: 0, calls: 0 } };
  const sectionOf = (doc: string, key: string): WikiDocsFollowReportSection => ({
    doc, key, outcome: 'gone', changed: null, versionId: null, forced: forced.has(at(doc, key)), draftIds: forced.get(at(doc, key))?.draftIds ?? [],
  });

  const plan = await readConfirmedPlan(prisma, job.ownerId, job.spaceId);
  const inPlan = (doc: string, key: string): boolean =>
    plan?.docs.some((one) => one.slug === doc && one.sections.some((section) => section.key === key)) ?? false;
  // A press's section the confirmed plan no longer has: design §10's «Section no longer in the plan». It is not written.
  const gone = [...forced.values()].filter((section) => !inPlan(section.doc, section.key));
  if (!plan) {
    context.log('the space has no plan its owner confirmed, so no document is written');
    report.sections = gone.map((section) => sectionOf(section.doc, section.key));
    return report;
  }
  const pressed = [...forced.values()].filter((section) => inPlan(section.doc, section.key) && !writtenBefore.has(at(section.doc, section.key)));
  if (pressed.length > 0) {
    // Written whatever its fingerprint: marked again where a writer cleared the press's mark since.
    const marked = await withTransactionRetry(
      prisma,
      (tx) => markWikiDocSectionsStale(tx, { ownerId: job.ownerId, spaceId: job.spaceId, sections: pressed, at: new Date() }),
      loggedRetry(logger, 'wiki.followDocsMarkStale'),
    );
    if (marked > 0) context.log(`${marked} section(s) a press asked for were written meanwhile and are marked to be written again`);
  }

  const readiness = await readWikiRepoReadiness(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
  if (!wikiRepoStepsCanRun(readiness)) {
    throw new WikiJobInfraError(`REPO_NOT_READY: the space's repository cannot be read now (${readiness.look})`);
  }
  const wholeFile = readiness.runner?.wholeFile === true;
  await writeWikiJobProgress(prisma, { id: job.id, generation: job.leaseGeneration, progress: { step: 'snapshot' } });
  const snapshot = await followSnapshot(context, deps, wholeFile);
  const head = snapshot.repo.sha;
  report.sha = head;
  const reaches = (sha: string): boolean => snapshot.commits.has(sha.toLowerCase());

  // The merges: the files each range of commits changed, on the commits the snapshot reaches.
  const ranges: Array<{ fact: Extract<WikiDocsFollowFact, { kind: 'merge' | 'landing' }>; files: Array<{ status: string; path: string; from: string | null }> }> = [];
  for (const fact of merges) {
    if (ranges.some((range) => range.fact.from === fact.from && range.fact.sha === fact.sha)) continue;
    if (!reaches(fact.from) || !reaches(fact.sha)) {
      context.log(`${fact.kind} ${fact.sha.slice(0, 12)} is not on origin/main as the snapshot reads it: nothing of it is followed`);
      continue;
    }
    ranges.push({ fact, files: (await diff(context, deps, fact.from, fact.sha)).files });
  }

  const state = await deps.docs.writerState(principal, job.spaceId);
  const stored = new Map<string, Map<string, WikiDocsStoredSection>>();
  const shaOf = new Map<string, string>();
  for (const doc of state.docs) {
    stored.set(doc.slug, new Map(doc.sections.map((section) => [section.key, { materialSha256: section.materialSha256, stale: section.stale }])));
    for (const section of doc.sections) shaOf.set(at(doc.slug, section.key), section.repoSha);
  }

  // The written sections the ranges touched: each citing a path one of them changed, with the newest fact that did.
  const touched = new Map<string, { doc: string; key: string; section: WikiDocsPlanSection; paths: string[]; facts: typeof merges }>();
  const goneSeen = new Set<string>();
  const goneFiles: Array<{ path: string; change: string; to?: string; fact: (typeof merges)[number] }> = [];
  for (const doc of plan.docs) {
    for (const section of doc.sections) {
      const id = at(doc.slug, section.key);
      if (!shaOf.has(id)) continue;
      const paths = sectionPaths(section);
      if (paths.length === 0) continue;
      for (const range of ranges) {
        for (const [path, change] of gitChangesOf(range.files)) {
          if (!pathNamed(path, paths)) continue;
          const entry = touched.get(id) ?? { doc: doc.slug, key: section.key, section, paths, facts: [] };
          if (!entry.facts.includes(range.fact)) entry.facts.push(range.fact);
          touched.set(id, entry);
          // A cited file the range deleted or renamed away, and that the head does not have: its sentences are withdrawn.
          if ((change.status === 'D' || change.status === 'R') && !snapshot.sizes.has(path) && !goneSeen.has(path)) {
            goneSeen.add(path);
            goneFiles.push(change.status === 'R' ? { path, change: 'renamed', to: change.to, fact: range.fact } : { path, change: 'deleted', fact: range.fact });
          }
        }
      }
    }
  }

  // Of those, the ones whose own material changed since the commit each was written at: the maintenance run's comparison.
  await writeWikiJobProgress(prisma, { id: job.id, generation: job.leaseGeneration, progress: { step: 'comparing', sha: head } });
  const changed = await compareTouched(context, deps, snapshot, [...touched.values()].filter((one) => !forced.has(at(one.doc, one.key))), shaOf, wholeFile);
  const factOf = new Map<string, (typeof merges)[number]>();
  for (const id of changed) factOf.set(id, newestOf(touched.get(id)!.facts)!);
  if (goneFiles.length > 0) {
    const answer = await deps.docs.withdrawPaths(principal, job.spaceId, {
      repoSha: head,
      paths: goneFiles.map((one) => (one.to ? { path: one.path, change: one.change, to: one.to } : { path: one.path, change: one.change })),
    });
    for (const section of answer.sections) {
      const id = at(section.doc, section.key);
      changed.add(id);
      const fact = goneFiles.find((one) => pathNamed(one.path, touched.get(id)?.paths ?? []))?.fact ?? goneFiles[0].fact;
      if (!factOf.has(id)) factOf.set(id, fact);
    }
    context.log(`withdrew ${answer.withdrawn} sentence(s) citing ${goneFiles.length} file(s) the merges took off origin/main`);
  }

  // The day's budget, in the plan's order: what the merges and landings ask for past it is left for maintenance.
  const order: string[] = plan.docs.flatMap((doc) => doc.sections.map((section) => at(doc.slug, section.key)));
  const asked = order.filter((id) => changed.has(id) && !forced.has(id) && !writtenBefore.has(id));
  const spent = await wikiDocsFollowSectionsToday(prisma, { ownerId: job.ownerId, spaceId: job.spaceId, now: new Date() });
  const room = Math.max(0, WIKI_DOCS_FOLLOW.sectionsPerDay - spent);
  const taken = asked.slice(0, room);
  report.left = asked.length - taken.length;
  if (report.left > 0) {
    context.log(`${report.left} section(s) the merges touched are left for the next maintenance run: `
      + `${spent} of the day's ${WIKI_DOCS_FOLLOW.sectionsPerDay} are written already`);
  }

  const only = new Map<string, Set<string>>();
  const take = (doc: string, key: string): void => {
    const keys = only.get(doc) ?? new Set<string>();
    keys.add(key);
    only.set(doc, keys);
  };
  for (const section of pressed) take(section.doc, section.key);
  for (const id of taken) {
    const [doc, key] = id.split('#');
    take(doc, key);
  }
  // A press's section is written whatever its fingerprint: the build reads it as stale, as the press marked it.
  for (const section of pressed) {
    const docStored = stored.get(section.doc) ?? new Map<string, WikiDocsStoredSection>();
    const one = docStored.get(section.key);
    if (one) docStored.set(section.key, { ...one, stale: true });
    stored.set(section.doc, docStored);
  }

  // Why each section is written again (docs.versions): its press, or the newest fact that touched it. An overview, or
  // a section no fact of its own asked for, is its document's: the newest press among the sections taken up there,
  // else the newest fact among them.
  const chatCause = (press: Extract<WikiDocsFollowFact, { kind: 'press' }>): WikiDocWriteCause => ({ reason: 'chat', jobId: job.id, title: press.title });
  const mergeCause = (fact: (typeof merges)[number]): WikiDocWriteCause => ({ reason: fact.kind, jobId: job.id, title: fact.title, sha: fact.sha });
  const causeOf = (slug: string, key: string): WikiDocWriteCause => {
    const id = at(slug, key);
    const own = forced.get(id);
    if (own) return chatCause(own.press);
    const fact = factOf.get(id);
    if (fact) return mergeCause(fact);
    const taken = (one: string): boolean => one.startsWith(`${slug}#`) && (only.get(slug)?.has(one.slice(slug.length + 1)) ?? false);
    const press = newestOf([...forced.entries()].filter(([one]) => taken(one)).map(([, one]) => one.press));
    if (press) return chatCause(press);
    const docFact = newestOf([...factOf.entries()].filter(([one]) => taken(one)).map(([, one]) => one));
    if (docFact) return mergeCause(docFact);
    return merges.length > 0 ? mergeCause(newestOf(merges)!) : chatCause(newestOf(presses)!);
  };

  const literals = await ownerEnvLiterals(prisma, job.ownerId);
  const answers = new Map<string, { versionId: string | null; changed: number | null }>();
  const total = [...only.values()].reduce((sum, keys) => sum + keys.size, 0);
  let done = 0;
  const finished = new Map<string, WikiDocsBuildSectionRun>();
  if (total > 0) {
    await writeWikiJobProgress(prisma, { id: job.id, generation: job.leaseGeneration, progress: { step: 'documents', done, total, sha: head } });
    await runWikiDocsBuild({
      repo: snapshot.repo,
      prepare: (paths) => snapshot.repo.prepare(paths),
      material: async (doc, key) => {
        const gathered = await gatherDocMaterial(prisma, deps.wiki, {
          ownerId: job.ownerId, spaceId: job.spaceId, condition: plan.conditions.get(at(doc.slug, key)) ?? null, literals,
        });
        return { records: gathered.records, unresolved: gathered.unresolved };
      },
      view: async (slug) => {
        try {
          return await deps.docs.writerDoc(principal, job.spaceId, slug);
        } catch (error) {
          if (error instanceof NotFoundException) return null;
          throw error;
        }
      },
      write: async (slug, request) => {
        const key = request.sections[0]?.key ?? '';
        const answer = await write(deps, job.ownerId, job.spaceId, slug, request, causeOf(slug, key));
        for (const section of answer.sections) {
          answers.set(at(slug, section.key), { versionId: section.versionId ?? null, changed: section.changed ?? null });
        }
        return answer;
      },
      ask: async (call) => {
        try {
          const row = await context.ask(call.step, call.unit, { system: call.system, prompt: call.prompt, maxTokens: WIKI_DOCS_BUILD_JOB.maxTokens });
          return { text: row.answer ?? '', inputTokens: row.inputTokens ?? 0, outputTokens: row.outputTokens ?? 0 };
        } catch (error) {
          // The call's own end (the request failed) fails its section; the platform's stops the job.
          if (error instanceof WikiJobContentError) throw new WikiDocsCallFailed(error.message);
          throw error;
        }
      },
      extra: async (doc, key) => {
        const id = at(doc.slug, key);
        const pressOf = forced.get(id);
        const first = pressOf
          ? (await gatherPressMaterial(prisma, deps.wiki, {
            ownerId: job.ownerId,
            spaceId: job.spaceId,
            entryIds: [...new Set(presses.filter((press) => pressOf.draftIds.includes(press.draftId)).flatMap((press) => press.entryIds))],
            chatId: pressOf.press.chatId,
            until: new Date(pressOf.press.at),
            literals,
          })).records
          : [];
        const facts = touched.get(id)?.facts ?? [];
        const repo = facts.length === 0 ? [] : await changedFilePieces(snapshot, doc, key, ranges.filter((range) => facts.includes(range.fact)));
        return first.length === 0 && repo.length === 0 ? null : { first, repo };
      },
      model: deps.model,
      log: (message) => context.log(message),
      signal: context.signal,
    }, {
      spaceId: job.spaceId,
      planVersion: plan.version,
      docs: plan.docs,
      stored,
      only,
      onSection: async (doc, run, answer: WikiDocsWriteAnswer | null) => {
        const id = at(doc.slug, run.key);
        finished.set(id, run);
        done += 1;
        await writeWikiJobProgress(prisma, { id: job.id, generation: job.leaseGeneration, progress: { step: 'documents', done: Math.min(done, total), total, sha: head } });
        if (run.outcome !== 'written') return;
        const written = answers.get(id) ?? { versionId: answer?.sections[0]?.versionId ?? null, changed: answer?.sections[0]?.changed ?? null };
        carry.sections = [...carry.sections.filter((one) => at(one.doc, one.key) !== id), {
          ...sectionOf(doc.slug, run.key), outcome: 'written', changed: written.changed, versionId: written.versionId,
        }];
        await keep();
      },
    });
  } else {
    context.log('nothing the facts touched is to be written again');
  }

  // The report: every section the job took up, the ones earlier attempts wrote among them, and a press's gone ones.
  const sections = new Map<string, WikiDocsFollowReportSection>();
  for (const section of carry.sections) sections.set(at(section.doc, section.key), section);
  for (const [id, run] of finished) {
    if (run.outcome === 'written') continue;
    const [doc, key] = [id.slice(0, id.indexOf('#')), id.slice(id.indexOf('#') + 1)];
    // A section an earlier attempt wrote is that attempt's written one, whatever the replay found of it.
    if (sections.has(id)) continue;
    sections.set(id, { ...sectionOf(doc, key), outcome: run.outcome === 'unchanged' ? 'unchanged' : 'failed', ...(run.why ? { why: cutRunes(run.why, 400) } : {}) });
  }
  for (const section of gone) sections.set(at(section.doc, section.key), sectionOf(section.doc, section.key));
  report.sections = order.filter((id) => sections.has(id)).map((id) => sections.get(id)!)
    .concat([...sections.entries()].filter(([id]) => !order.includes(id)).map(([, section]) => section));
  const spentCalls = await wikiJobModelCalls(prisma, { jobId: job.id, failed: true });
  report.usage = { inputTokens: spentCalls.inputTokens, outputTokens: spentCalls.outputTokens, calls: spentCalls.calls };
  const failed = report.sections.filter((section) => section.outcome === 'failed').length;
  context.log(`followed ${facts.length} fact(s) at origin/main ${head.slice(0, 12)}: `
    + `${report.sections.filter((section) => section.outcome === 'written').length} section(s) written, `
    + `${report.sections.filter((section) => section.outcome === 'unchanged').length} unchanged, ${failed} failed, ${report.left} left`
    + (startedAt ? `, in ${Math.round((Date.now() - startedAt.getTime()) / 1000)} s` : ''));
  if (failed > 0) {
    throw new WikiJobContentError(`${failed === 1 ? '1 section was' : `${failed} sections were`} left unwritten`, report as unknown as Record<string, unknown>);
  }
  return report;
}

/** The newest of some facts, by when each came; null of none. */
function newestOf<T extends { at: string }>(list: readonly T[]): T | null {
  return list.length === 0 ? null : list.reduce((a, b) => (a.at >= b.at ? a : b));
}

// ── The repository ─────────────────────────────────────────────────────────────────────────────

interface FollowSnapshot {
  repo: WikiDocsSnapshotRepo;
  files: string[];
  sizes: Map<string, number>;
  /** The commits origin/main reaches, as the snapshot lists them. */
  commits: Set<string>;
}

/** origin/main as the space's runner reads it now: the snapshot's commit, its files and the commits it reaches. */
async function followSnapshot(context: WikiJobContext, deps: WikiDocsFollowJobDeps, wholeFile: boolean): Promise<FollowSnapshot> {
  const { job } = context;
  const held = await deps.prisma.wikiRepoSnapshot.findFirst({ where: { spaceId: job.spaceId, ownerId: job.ownerId }, select: { sha: true } });
  const settled = await operation(context, deps, 'snapshot', { skipSha: held?.sha ?? null }, 'the snapshot of origin/main');
  if (settled.state !== 'succeeded') {
    throw new WikiJobInfraError(`REPO_OP_FAILED: the snapshot of origin/main ${settled.state}: ${settled.error ?? ''}`);
  }
  const sha = String(settled.result?.sha ?? '');
  const snapshot = await readWikiRepoSnapshot(deps.prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
  if (!snapshot || snapshot.sha !== sha) {
    throw new WikiJobInfraError(`REPO_OP_FAILED: the space holds no snapshot of ${sha.slice(0, 12)}, the commit the snapshot named`);
  }
  const index = JSON.parse(snapshot.index) as { files?: Array<{ path?: unknown; size?: unknown }>; commits?: unknown };
  const sizes = new Map<string, number>();
  for (const file of index.files ?? []) {
    if (typeof file.path === 'string') sizes.set(file.path, typeof file.size === 'number' ? file.size : 0);
  }
  const files = [...sizes.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const commits = new Set((Array.isArray(index.commits) ? index.commits : []).filter((one): one is string => typeof one === 'string').map((one) => one.toLowerCase()));
  commits.add(sha.toLowerCase());
  context.log(`the repository at ${sha.slice(0, 12)} (${files.length} files)`);
  const repo = new WikiDocsSnapshotRepo(sha, sizes, files, (paths) => readFiles(context, deps, sha, paths, sizes, wholeFile));
  return { repo, files, sizes, commits };
}

/** `git diff --name-status -M` between two commits, as the space's runner answers it. */
async function diff(context: WikiJobContext, deps: WikiDocsFollowJobDeps, from: string, to: string): Promise<ReturnType<typeof diffAnswerOf>> {
  const what = `the diff ${from.slice(0, 12)}..${to.slice(0, 12)}`;
  const settled = await operation(context, deps, 'diff', { from, to }, what);
  if (settled.state !== 'succeeded') throw new WikiJobInfraError(`REPO_OP_FAILED: ${what} ${settled.state}: ${settled.error ?? ''}`);
  return diffAnswerOf(settled);
}

/**
 * Of the sections the facts touched, the ones whose repository material changed on origin/main since the commit each
 * was written at (`maintenance.job.docs.byRepo`): by commit, one diff to the head, and each section's pieces read at
 * both and compared. A section written at the head has nothing to follow; one written at a commit the snapshot does
 * not reach is taken as changed.
 */
async function compareTouched(
  context: WikiJobContext,
  deps: WikiDocsFollowJobDeps,
  snapshot: FollowSnapshot,
  touched: ReadonlyArray<{ doc: string; key: string; section: WikiDocsPlanSection; paths: string[] }>,
  shaOf: ReadonlyMap<string, string>,
  wholeFile: boolean,
): Promise<Set<string>> {
  const head = snapshot.repo.sha;
  const changed = new Set<string>();
  const bySha = new Map<string, Array<(typeof touched)[number]>>();
  for (const one of touched) {
    const sha = shaOf.get(at(one.doc, one.key)) ?? '';
    if (sha === '' || sha === head) continue;
    bySha.set(sha, [...(bySha.get(sha) ?? []), one]);
  }
  if (bySha.size === 0) return changed;
  await snapshot.repo.prepare([...bySha.values()].flat().flatMap((one) => one.paths));
  for (const sha of [...bySha.keys()].sort()) {
    const sections = bySha.get(sha)!;
    if (!snapshot.commits.has(sha.toLowerCase())) {
      context.log(`the snapshot does not have commit ${sha.slice(0, 12)} ${sections.length} section(s) were written at: they are taken as changed`);
      for (const one of sections) changed.add(at(one.doc, one.key));
      continue;
    }
    const files = (await diff(context, deps, sha, head)).files;
    const tree = baseTreeOf(snapshot.files, snapshot.sizes, files);
    const ordered = [...tree.files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const base = new WikiDocsSnapshotRepo(sha, tree.sizes, ordered, (paths) => readFiles(context, deps, sha, paths, tree.sizes, wholeFile));
    await base.prepare(sections.flatMap((one) => one.paths));
    for (const one of sections) {
      const before = wikiDocRepoPieces(base, one.section);
      const after = wikiDocRepoPieces(snapshot.repo, one.section);
      if (!samePieces(before.pieces, after.pieces)) changed.add(at(one.doc, one.key));
    }
  }
  return changed;
}

/**
 * The files a section's merges changed, as the writer is handed them besides its own material (`docs.follow.material`):
 * each a text file still at the head and not among the section's own sources, cut as a section's sources are
 * (`docs.build.repository`) — a design document from its top, a contract whole, code by its head and the declarations
 * the section's words match — at most `CHANGED_FILES_PER_SECTION`, in the order the diffs named them.
 */
async function changedFilePieces(
  snapshot: FollowSnapshot,
  doc: WikiDocsPlanDoc,
  key: string,
  ranges: ReadonlyArray<{ files: ReadonlyArray<{ status: string; path: string; from: string | null }> }>,
): Promise<WikiDocPiece[]> {
  const section = doc.sections.find((one) => one.key === key);
  if (!section) return [];
  const own = sectionPaths(section);
  const paths: string[] = [];
  for (const range of ranges) {
    for (const file of range.files) {
      if (file.status.startsWith('D') || paths.includes(file.path)) continue;
      if (!snapshot.sizes.has(file.path) || !TEXT_FILE.test(file.path)) continue;
      if (WIKI_MAINTAIN_JOB.docsExcluded.some((dir) => file.path.startsWith(dir))) continue;
      if (pathNamed(file.path, own)) continue;
      paths.push(file.path);
    }
  }
  const handed = paths.slice(0, CHANGED_FILES_PER_SECTION);
  if (handed.length === 0) return [];
  await snapshot.repo.prepare(handed);
  const words = wikiDocSectionWords(section);
  const pieces: WikiDocPiece[] = [];
  for (const path of handed) {
    if (/\.(md|markdown)$/iu.test(path)) {
      const found = wikiDocDocSection(snapshot.repo, path, '');
      if (found.piece) pieces.push(found.piece);
    } else if (path.startsWith('contracts/')) {
      const piece = wikiDocContract(snapshot.repo, path);
      if (piece) pieces.push(piece);
    } else {
      pieces.push(...wikiDocCodePieces(snapshot.repo, path, [], words).pieces);
    }
  }
  return pieces;
}
