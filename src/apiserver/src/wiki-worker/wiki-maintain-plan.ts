import {
  WIKI_MAINTAIN_JOB,
  WIKI_PLAN_SECTION_KINDS,
  WIKI_SLUG_PATTERN,
  type WikiPlanTopic,
  type WikiPlanVersion,
} from '@orbit/shared';
import { PAST_THE_READ, wikiDocCodePieces, wikiDocContract, wikiDocDocSection, type WikiDocRepo } from './wiki-docs-writer';
import { cutRunes, goTrimSpace } from './wiki-import-extract';
import {
  emptyWikiPlanHeader,
  parseWikiPlanDocBody,
  wikiPlanDocInput,
  wikiPlanLabel,
  wikiPlanRange,
  type WikiPlanCat,
  type WikiPlanDoc,
  type WikiPlanDocRead,
  type WikiPlanHeader,
  type WikiPlanSection,
  type WikiPlanSectionDraft,
} from './wiki-plan-format';
import { wikiQuote, wikiUnwrap } from './wiki-plan-gate';
import { wikiPlanTopicsBrief } from './wiki-plan-materials';

/**
 * The one change to the plan a maintenance run may propose (contracts/wiki.contract.json `plan.proposals`,
 * `maintenance.job.run.steps`, the docs step; design §8, P8): the knowledge the confirmed plan has no place
 * for — entries, and design documents new on origin/main that no section cites — put to the model, whose
 * answer is checked here on origin/main and again by the server's gate. Ported from
 * `src/runner-go/wiki_maintain_docs.go` (proposePlanChange, wikiProposalPrompt, parseWikiProposal,
 * assembleWikiProposal, wikiProposalSection), which does the same on the runner until P10 removes it.
 *
 * The repository is read as the runner reads it: the files the answer names, at the snapshot's commit, through
 * the reader the documents step writes from (`WikiDocRepo`; the job's is wiki-docs-build-job.ts
 * `WikiDocsSnapshotRepo`), and a document's section, a file's symbols and a contract are found by the same ports
 * of the runner's `wikiDocRepo` that step uses (`wikiDocDocSection`, `wikiDocCodePieces`, `wikiDocContract`).
 * Not by the snapshot's index: its headings and symbols are the plan gate's reading (`WikiPlanRepo`), which takes a
 * heading named as the prompt lists it, `##` and all, for none (2026-10-09, run 28ea4f5c: refused three rounds
 * for two sections its document has). src/shared/src/wiki-maintain-proposal.fixture.json holds both paths to the
 * same answers.
 *
 * Nothing here touches the database or the model: the job asks, and this reads.
 */

/** A design document origin/main has that it did not at the plan's commit, and no section cites. */
export interface WikiNewDesignDoc {
  path: string;
  renamedFrom: string;
  commit: string;
  title: string;
  headings: string[];
  opening: string;
}

/** An entry that fits no section of the confirmed plan (contract `docs.reads.affected.unplaced`). */
export interface WikiUnplacedEntry {
  id: string;
  kind: string;
  title: string;
  summary: string;
  topics: string[];
  anchorPaths: string[];
  changedAt: string;
}

/** The confirmed plan as the proposal reads it: its version, its categories and its documents. */
export interface WikiMaintainPlanRead {
  version: number;
  categories: WikiPlanCat[];
  docs: WikiPlanDocRead[];
}

/** One piece of knowledge the plan has no place for, as the model is told it. */
export interface WikiMaintainProposalItem {
  id: string;
  design?: WikiNewDesignDoc;
  entry?: WikiUnplacedEntry;
}

/** The model's answer, read. */
export interface WikiMaintainProposalAnswer {
  target: string;
  newDoc: boolean;
  reason: string;
  covers: string[];
  category: string;
  slug: string;
  header: WikiPlanHeader;
  sections: WikiPlanSectionDraft[];
  stray: string[];
}

/** The proposal the server gates, and what this side found wrong with it. */
export interface WikiMaintainProposalRequest {
  reason: string;
  change: { doc: WikiPlanDoc; category: WikiPlanCat | null };
  facts: Array<{ kind: string; id: string }>;
}

const COVER_ID = /K\d+/gu;

/** The plan's read as this module's shape: the version's categories and its documents with their sections' sources. */
export function wikiMaintainPlanOf(version: WikiPlanVersion): WikiMaintainPlanRead {
  return {
    version: version.version,
    categories: (version.categories ?? []).map((category) => ({
      key: category.key,
      title: category.title,
      question: category.question ?? '',
      forAgents: category.forAgents === true,
    })),
    docs: version.docs.map((doc) => ({
      category: doc.category,
      slug: doc.slug,
      title: doc.title,
      question: doc.question,
      audience: doc.audience,
      scopeIn: doc.scopeIn,
      scopeOut: doc.scopeOut,
      length: doc.length,
      protected: doc.protected === true,
      extra: (doc.extra ?? null) as Record<string, unknown> | null,
      sections: doc.sections.map((section) => ({
        key: section.key,
        title: section.title,
        kind: section.kind,
        covers: section.covers,
        length: section.length,
        extra: (section.extra ?? null) as Record<string, unknown> | null,
        sources: {
          docs: (section.sources?.docs ?? []).map((source) => ({ path: source.path, section: source.section ?? null })),
          code: (section.sources?.code ?? []).map((source) => ({ path: source.path, symbols: source.symbols ?? [] })),
          contracts: (section.sources?.contracts ?? []).map((source) => ({ path: source.path })),
          sessions: section.sources?.sessions == null
            ? null
            : {
              projects: (section.sources.sessions.projects ?? []).map((project) => ({ id: project.id, title: project.title ?? null })),
              since: section.sources.sessions.since ?? null,
              until: section.sources.sessions.until ?? null,
              keywords: section.sources.sessions.keywords ?? [],
              anchorPaths: section.sources.sessions.anchorPaths ?? [],
              entryKinds: section.sources.sessions.entryKinds ?? [],
              topics: section.sources.sessions.topics ?? [],
              evidence: section.sources.sessions.evidence ?? '',
            },
        },
      })),
    })),
  };
}

/** The commit a design document landed in, cut for the prompt. */
function shortHash(sha: string): string {
  return sha.slice(0, 12);
}

/** Ask the model where the knowledge the plan has no place for belongs. */
export function wikiMaintainProposalPrompt(plan: WikiMaintainPlanRead, items: readonly WikiMaintainProposalItem[]): string {
  let knowledge = '';
  for (const item of items) {
    if (item.design) {
      const d = item.design;
      knowledge += `[${item.id}] new design doc ${d.path}`;
      if (d.title !== '') knowledge += ` «${d.title}»`;
      knowledge += ` (added to origin/main in commit ${shortHash(d.commit)}`;
      if (d.renamedFrom !== '') knowledge += `, renamed from ${d.renamedFrom}`;
      knowledge += ')\n';
      if (d.opening !== '') knowledge += `    Opening: ${d.opening}\n`;
      if (d.headings.length > 0) knowledge += `    Sections: ${d.headings.join('; ')}\n`;
      continue;
    }
    if (item.entry) {
      const e = item.entry;
      knowledge += `[${item.id}] entry (${e.kind}) «${e.title}»: ${e.summary}`;
      if (e.anchorPaths.length > 0) knowledge += `; anchors ${e.anchorPaths.join(', ')}`;
      if (e.topics.length > 0) knowledge += `; topics ${e.topics.join(', ')}`;
      knowledge += '\n';
    }
  }
  let catalogue = '';
  for (const category of plan.categories) {
    catalogue += `## Category \`${category.key}\` «${category.title}»`;
    if (category.question) catalogue += ` — ${category.question}`;
    catalogue += '\n';
    for (const doc of plan.docs) {
      if (doc.category !== category.key) continue;
      const titles = doc.sections.map((section, n) => `${n + 1}.${section.title} (${section.kind})`);
      catalogue += `- \`${doc.slug}\` «${doc.title}» | ${doc.question} | Includes: ${doc.scopeIn.join('; ')}\n  Sections: ${titles.join(' ')}\n`;
    }
  }
  return `
# Task: the maintenance run's proposed change to the plan
This wiki's documents are written section by section to the plan the owner confirmed (version ${plan.version}; its catalogue is below). The maintenance run found some new knowledge that no section of the plan covers ("New knowledge" below).
From it, pick one group that belongs together — a few items about the same thing, which read coherently in one place (at least one item; if no group can be picked, pick just one; when there is a new design document, consider it first) — and propose which document of the plan it goes into: an existing document (adding a section or a few to it), or a new one.
New knowledge that is not about the same thing as this group is not placed this time; leave it for the next maintenance run to propose: do not put unrelated knowledge together into one document or one section to place it all at once, and do not add a document with no specific subject, such as "Miscellaneous", "Other" or "Loose entries". Do not change any other document, and do not delete a section.

## New knowledge
${knowledge}
## The plan's catalogue
${catalogue}
## Where each section's material comes from
- A section on a mechanism (concepts / flow / interface / data / ops): its sources are the design documents and the code. For a new design document, write "- Docs: <path> § <section heading>", with the section heading copied exactly from those listed above; without §, it is the whole document.
- Known pitfalls, decisions and reasons, conventions (pitfalls / decisions / conventions): its source is the conditions to find the words in sessions by, "- Sessions: keywords <word>, <word>; anchors <path prefix>; kind <pitfall/decision/convention/…>; topics <slug>; look for: <what kind of original words to look for>". Choose keywords that really appear in the entries of the new knowledge.
- Use only the paths, section headings and topics that appear above; invent none.

## Output format
Output only what follows, with no preamble, no summary and no JSON:
Into: <the slug of an existing document, copied exactly from between the backticks in the catalogue> (or write "Into: new")
Reason: <a sentence or two: what the new knowledge is, and why it goes here>
Uses: <the numbers of the new knowledge this proposal uses, such as K1, K3>
For a new document, also write these lines:
Category: <the key of a category in the catalogue>
slug: <the new document's slug: lowercase letters and digits, joined by hyphens>
Title: <title>
Question: <the question the reader comes with, in one sentence>
Audience: <who>: <what they can do once they have read it>
Includes: <point>; <point>
Length: <a–b characters>
Then write the sections to add, one or a few:
### 1. <section title> | <type> | <length in characters>
Covers: <what exactly this section says, in 1–2 sentences>
- Docs: <docs/….md> § <section heading>
- Sessions: keywords …; anchors …; kind …; topics …; look for: …
`;
}

/** Hand back what was wrong with the last answer. */
export function wikiMaintainProposalRedo(problems: readonly string[]): string {
  const listed = problems.slice(0, 30);
  return `\n## The last answer had these problems: correct them, and write the whole answer again in the same format\n- ${listed.join('\n- ')}\n`;
}

/** Read the model's answer: its own lines first, then a document's header and sections in the plan's line format. */
export function parseWikiMaintainProposal(text: string): WikiMaintainProposalAnswer {
  const answer: WikiMaintainProposalAnswer = {
    target: '', newDoc: false, reason: '', covers: [], category: '', slug: '', header: emptyWikiPlanHeader(), sections: [], stray: [],
  };
  const rest: string[] = [];
  for (const raw of text.split('\n')) {
    const line = goTrimSpace(goTrimLeft(goTrimSpace(raw), '-*•'));
    const [label, value] = wikiPlanLabel(line);
    switch (label.toLowerCase()) {
      case 'into': {
        const trimmed = trimChars(value, '`「」《》«» ');
        const lower = trimmed.toLowerCase();
        if (lower === 'new' || lower.startsWith('new ')) answer.newDoc = true;
        else answer.target = trimmed;
        continue;
      }
      case 'reason':
        answer.reason = value;
        continue;
      case 'uses':
        answer.covers = (value.toUpperCase().match(COVER_ID) ?? []);
        continue;
      case 'category':
        answer.category = trimChars(value, '`「」 ');
        continue;
      case 'slug':
        answer.slug = trimChars(value, '`「」 ');
        continue;
      default:
        rest.push(raw);
    }
  }
  const body = parseWikiPlanDocBody(rest.join('\n'));
  answer.header = body.header;
  answer.sections = body.sections;
  answer.stray = body.stray;
  return answer;
}

/** Go's strings.Trim. */
function trimChars(value: string, cutset: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && cutset.includes(value[start])) start += 1;
  while (end > start && cutset.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** Go's strings.TrimLeft. */
function goTrimLeft(value: string, cutset: string): string {
  let start = 0;
  while (start < value.length && cutset.includes(value[start])) start += 1;
  return value.slice(start);
}

/**
 * Turn the answer into the proposal the server gates: the document as it should read — the plan's own, with
 * the new sections after its last, or a new one — and the facts it came from. What is wrong with it that this
 * side can see — a missing line, a kind the plan does not have, a file, document section, symbol or contract
 * origin/main does not have, a topic the space does not have (`topics`, the space's: docs.reads.affected) —
 * comes back as problems, for the model.
 */
export function assembleWikiMaintainProposal(
  plan: WikiMaintainPlanRead,
  answer: WikiMaintainProposalAnswer,
  items: readonly WikiMaintainProposalItem[],
  repo: WikiDocRepo,
  topics: readonly WikiPlanTopic[],
): { request: WikiMaintainProposalRequest; problems: string[] } {
  const problems: string[] = [];
  if (goTrimSpace(answer.reason) === '') problems.push('the Reason line is missing: say what the new knowledge is, and why it goes here');
  const byId = new Map(items.map((item) => [item.id, item]));
  const facts: Array<{ kind: string; id: string }> = [];
  const seen = new Set<string>();
  for (const id of answer.covers) {
    const item = byId.get(id);
    if (!item) {
      problems.push(`${wikiQuote(id)} on the Uses line is not the number of an item of new knowledge`);
      continue;
    }
    const fact = item.design ? { kind: 'commit', id: item.design.commit } : { kind: 'entry', id: item.entry!.id };
    if (!seen.has(`${fact.kind}${fact.id}`)) {
      seen.add(`${fact.kind}${fact.id}`);
      facts.push(fact);
    }
  }
  if (facts.length === 0) problems.push('the Uses line is missing: list the numbers of the new knowledge this proposal uses, such as K1, K2');
  if (answer.sections.length === 0) problems.push('there is no section to add: write one at least, "### 1. <section title> | <type> | <length in characters>"');
  const sections: WikiPlanSection[] = [];
  answer.sections.forEach((draft, i) => {
    const made = wikiMaintainProposalSection(`section ${i + 1}`, draft, repo, topics);
    problems.push(...made.problems);
    sections.push(made.section);
  });
  for (const line of answer.stray) problems.push(`${wikiQuote(cutRunes(line, 60))} is not a line of this format: drop it`);

  let doc: WikiPlanDoc;
  const category: WikiPlanCat | null = null;
  if (answer.newDoc) {
    const h = answer.header;
    doc = {
      category: answer.category,
      slug: answer.slug,
      title: h.title,
      question: h.question,
      audience: h.audience,
      scopeIn: h.scopeIn,
      scopeOut: [],
      length: { min: 0, max: 0 },
      sections,
    };
    if (!plan.categories.some((c) => c.key === answer.category)) {
      problems.push(`Category ${wikiQuote(answer.category)} is not a category of the catalogue: copy a category's key exactly`);
    }
    if (!new RegExp(WIKI_SLUG_PATTERN, 'u').test(answer.slug)) {
      problems.push(`slug ${wikiQuote(answer.slug)} is not a slug: lowercase letters and digits, joined by hyphens`);
    }
    for (const existing of plan.docs) {
      if (existing.slug === answer.slug) {
        problems.push(`slug ${wikiQuote(answer.slug)} is an existing document already: a new document takes a new slug, and to add to the existing one, `
          + `write "Into: ${answer.slug}"`);
      }
    }
    if (h.title === '' || h.question === '' || h.audience.length === 0 || h.scopeIn.length === 0) {
      problems.push('a new document needs all five lines: Title, Question, Audience, Includes and Length');
    }
    const range = wikiPlanRange(h.length);
    if (range.ok) doc.length = { min: range.min, max: range.max };
    else problems.push(`Length ${wikiQuote(h.length)} is not a length: write it as <a–b characters>`);
  } else {
    const target = plan.docs.find((one) => one.slug === answer.target);
    if (!target) {
      problems.push(`Into ${wikiQuote(answer.target)} is not a document of the catalogue: copy a document's slug exactly, or write "Into: new"`);
      doc = { category: '', slug: '', title: '', question: '', audience: [], scopeIn: [], scopeOut: [], length: { min: 0, max: 0 }, sections: [] };
    } else {
      if (target.protected) problems.push(`${target.slug} is a protected document and does not change: put it into another document, or add a new one`);
      const base = wikiPlanDocInput(target);
      doc = { ...base, protected: false, sections: [...base.sections, ...sections] };
    }
  }
  return {
    request: { reason: cutRunes(goTrimSpace(answer.reason), 2000), change: { doc, category }, facts },
    problems,
  };
}

/**
 * One new section as the model wrote it, checked on origin/main as the runner checks it (`wikiProposalSection`): its
 * kind, its length, every file, document section, symbol and contract it names — read in the files at the commit —
 * its session condition, its topics among the space's, and its lines.
 */
export function wikiMaintainProposalSection(
  at: string,
  draft: WikiPlanSectionDraft,
  repo: WikiDocRepo,
  topics: readonly WikiPlanTopic[],
): { section: WikiPlanSection; problems: string[] } {
  const problems: string[] = [];
  const section: WikiPlanSection = {
    title: draft.title,
    kind: wikiUnwrap(draft.kind),
    covers: draft.covers,
    length: 0,
    sources: { docs: [], code: [], contracts: [], sessions: null },
  };
  if (!(WIKI_PLAN_SECTION_KINDS as readonly string[]).includes(section.kind)) {
    problems.push(`${at}: the type ${wikiQuote(section.kind)} is not a section type: one of ${WIKI_PLAN_SECTION_KINDS.join(', ')}`);
  }
  const range = wikiPlanRange(draft.length);
  if (range.ok) section.length = range.min;
  else problems.push(`${at}: the length ${wikiQuote(draft.length)} is not a number`);
  if (goTrimSpace(draft.covers) === '') problems.push(`${at} has no Covers line`);
  section.sources.docs = draft.docs.map((source) => ({ path: source.path, section: source.section ?? null }));
  section.sources.code = draft.code.map((source) => ({ path: source.path, symbols: source.symbols ?? [] }));
  section.sources.contracts = draft.contracts.map((path) => ({ path }));
  for (const source of draft.docs) {
    const heading = source.section ?? '';
    const found = wikiDocDocSection(repo, source.path, heading);
    if (found.piece) continue;
    // A heading a bounded read did not reach is missing as the documents step says it is (design §7).
    if (!repo.show(source.path)) problems.push(`${at}: the document ${wikiQuote(source.path)} is not on origin/main`);
    else {
      problems.push(`${at}: the document ${source.path} has no section ${wikiQuote(heading)}: copy a section heading the new knowledge lists exactly, `
        + `or write no §${found.past ? ` ${PAST_THE_READ}` : ''}`);
    }
  }
  for (const source of draft.code) {
    const { missing } = wikiDocCodePieces(repo, source.path, source.symbols ?? [], []);
    if (missing.length > 0) problems.push(`${at}: code not found on origin/main: ${missing.join(', ')}`);
  }
  for (const path of draft.contracts) {
    if (!wikiDocContract(repo, path)) problems.push(`${at}: the contract ${wikiQuote(path)} is not on origin/main`);
  }
  const c = draft.sessions;
  if (c) {
    section.sources.sessions = {
      projects: c.projects ?? [],
      since: c.since || null,
      until: c.until || null,
      keywords: c.keywords ?? [],
      anchorPaths: c.anchorPaths ?? [],
      entryKinds: (c.entryKinds ?? []).map((kind) => wikiUnwrap(kind)),
      topics: (c.topics ?? []).map((topic) => wikiUnwrap(topic)),
      evidence: c.evidence ?? '',
    };
    for (const part of c.stray ?? []) {
      problems.push(`${at}: ${wikiQuote(cutRunes(part, 60))} is not a part of a session condition: it has projects, dates, keywords, `
        + 'anchors, kinds, topics and what to look for — drop it');
    }
    // The server's gate takes a topic only from the space's (plan.gate.references), and lists them with one it refuses:
    // so is it here, and listed the same, so the round that refuses it can fix it. A document's slug passed here until
    // 2026-10-10 and was refused at the gate in the run's last round (canary 3b2bd5f2, «wiki-maintenance»).
    const known = new Set(topics.map((topic) => topic.slug));
    for (const topic of section.sources.sessions.topics) {
      if (!known.has(topic)) problems.push(`${at}: ${wikiQuote(topic)} is not a topic of this space: ${wikiPlanTopicsBrief({ topics })}`);
    }
  }
  const { docs, code, contracts, sessions } = section.sources;
  if (docs.length + code.length + contracts.length === 0 && sessions === null) {
    problems.push(`${at} names no sources: a section on a mechanism names its design documents and code, one on pitfalls, `
      + 'decisions or conventions the sessions to find the words in');
  }
  for (const line of draft.stray ?? []) {
    problems.push(`${at}: ${wikiQuote(cutRunes(line, 60))} is not a line of a section: a section has what it covers, its documents, `
      + 'code, contracts and sessions, and nothing else — drop it');
  }
  return { section, problems };
}

/** Every file the answer's sections name — documents, code and contracts: what the check reads before it looks. */
export function wikiMaintainProposalPaths(answer: WikiMaintainProposalAnswer): string[] {
  return answer.sections.flatMap((draft) => [
    ...draft.docs.map((source) => source.path),
    ...draft.code.map((source) => source.path),
    ...draft.contracts,
  ]);
}

/** The numbers a run's proposal is held to, re-exported for the job: rounds at most, items at most. */
export const WIKI_MAINTAIN_PROPOSAL = {
  roundsMax: WIKI_MAINTAIN_JOB.proposalRoundsMax,
  itemsMax: WIKI_MAINTAIN_JOB.proposalItemsMax,
} as const;
