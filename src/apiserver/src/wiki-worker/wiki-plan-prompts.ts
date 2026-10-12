import { WIKI_PLAN_SERVER_JOB, type WikiPlanGateError, type WikiPlanMaterials } from '@orbit/shared';
import { cutRunes, goTrimSpace } from './wiki-import-extract';
import type { WikiPlanAssembled } from './wiki-plan-gate';
import {
  goCompare,
  wikiPlanDocInput,
  wikiPlanDocLines,
  wikiPlanSectionLines,
  wikiPlanSessionsLine,
  wikiPlanSessionsOf,
  type WikiPlanCat,
  type WikiPlanDoc,
  type WikiPlanDocRead,
  type WikiPlanMove,
  type WikiPlanNewFieldDraft,
  type WikiPlanSectionDraft,
  type WikiPlanUnit,
} from './wiki-plan-format';
import { wikiPlanProjectsText, wikiPlanSpaceText, wikiPlanTopicBlocks, wikiPlanTopicsBrief } from './wiki-plan-materials';
import { shortWikiHash, WIKI_PLAN_MATERIAL_CAPS, type WikiPlanRepo } from './wiki-plan-repo';

/**
 * What the drafting job asks the model, step by step (contract `plan.jobs.server`) — ported word for word from
 * `src/runner-go/wiki_plan_prompts.go` (the sample's draft_plan.py and p1_revise.py, made general): the materials
 * each step reads, and the line format each answer is written in. The prompts are English, as all of Orbit's copy
 * is (AGENTS.md section 5); the paths, symbols and commands in them are the repository's own. `wiki-plan.fixture.json`
 * holds them to the runner's bytes.
 */

/** A version as the plan's read gives it: what a draft revises (WikiPlanVersion of @orbit/shared, the fields read here). */
export interface WikiPlanVersionRead {
  version: number;
  status: string;
  target: { min: number; max: number };
  categories: Array<{ key: string; title: string; question: string; forAgents: boolean }>;
  newFields: WikiPlanNewFieldDraft[];
  docs: WikiPlanDocRead[];
}

/**
 * What the prompts and the gate read of a run: the space, the repository at the sha, the materials, the version
 * revised and the catalogue being drafted (the runner's `wikiPlanRun`, its fields).
 */
export interface WikiPlanRunState {
  spaceTitle: string;
  /** YYYY-MM-DD: the day the materials were read. */
  date: string;
  repo: WikiPlanRepo;
  materials: WikiPlanMaterials;
  /** The sessions' text, clustered once (the clustering hands the event loop back, so it is read ahead). */
  sessionsText: string;
  target: { min: number; max: number };
  instructions: string;
  base: WikiPlanVersionRead | null;
  /** The version revised: number → slug, and slug → document. */
  baseIds: Map<string, string>;
  baseDocs: Map<string, WikiPlanDocRead>;
  cats: WikiPlanCat[];
  units: WikiPlanUnit[];
  moves: WikiPlanMove[];
}

/** Every drafting call's whole system prompt: what the model is for (wikiPlanSystemPrompt). */
export const WIKI_PLAN_SYSTEM_PROMPT = WIKI_PLAN_SERVER_JOB.systemPrompt;

export const WIKI_PLAN_BACKGROUND = `
## Background
The main view this wiki gives people to read is a set of "product and technical documents": a reader who opens one learns what the feature is, how it works, where its interfaces are, how it is operated, what its known pitfalls are and why it was designed this way.
First a plan is drafted for the owner to confirm; then, following the plan, the material of each section is gathered and the documents are written section by section: a section on a mechanism draws on the design documents, the code and the contracts; pitfalls, decisions and conventions draw on the words said in sessions.
The plan is held by a gate in code: every file, document section, symbol, project and topic must be found in the materials, the number of documents must be within the target, and any field outside the format is sent back.
`;

/** One material, numbered and labelled. */
function material(n: number, label: string, body: string): string {
  return `<material ${n}: ${label}>\n${goTrimSpace(body)}\n</material ${n}>\n`;
}

function materialsHead(r: WikiPlanRunState): string {
  return `# Materials (read-only from origin/main ${shortWikiHash(r.repo.sha)} and Orbit, ${r.date}; space «${r.spaceTitle}»)\n\n`;
}

/** `1 document`, `3 documents`: the runner's `wikiCount`. */
function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/**
 * What the catalogue is drafted from: the repository's overview, structure, documents and contracts, and the
 * owner's projects, the space's sessions and what the wiki already holds.
 */
export function wikiPlanFullMaterials(r: WikiPlanRunState): string {
  let b = materialsHead(r);
  let n = 0;
  const add = (label: string, body: string): void => {
    if (goTrimSpace(body) === '') return;
    n += 1;
    b += `${material(n, label, body)}\n`;
  };
  add('Repository overview (docs/README.md and docs/architecture.md, or README.md)', r.repo.overviewText(WIKI_PLAN_MATERIAL_CAPS.overview.full));
  add('Repository structure: packages, directories and source files, entry points, data model', r.repo.layoutText(WIKI_PLAN_MATERIAL_CAPS.layout.full));
  add('Document heading tree: the sections of the design, contract and operations documents', r.repo.docsTreeText(WIKI_PLAN_MATERIAL_CAPS.docsTree.full));
  add('contracts inventory', r.repo.contractsText());
  add('Project titles', wikiPlanProjectsText(r.materials));
  add('Recent sessions: counts and title clusters', r.sessionsText);
  add("This space's entries and topics", wikiPlanSpaceText(r.materials));
  return b;
}

/** What each category's documents are detailed from. */
export function wikiPlanDetailMaterials(r: WikiPlanRunState): string {
  return materialsHead(r)
    + `${material(1, 'Repository overview', r.repo.overviewText(WIKI_PLAN_MATERIAL_CAPS.overview.detail))}\n`
    + `${material(2, 'Documents and their second-level sections (use only the document paths that appear here)', r.repo.docsTreeText(WIKI_PLAN_MATERIAL_CAPS.docsTree.detail))}\n`
    + `${material(3, 'Repository structure (use only the code paths that appear here)', r.repo.layoutText(WIKI_PLAN_MATERIAL_CAPS.layout.detail))}\n`
    + `${material(4, 'contracts inventory', r.repo.contractsText())}\n`
    + `${material(5, 'Project titles (copy a title exactly)', wikiPlanProjectsText(r.materials))}\n`
    + `${material(6, "This space's topics", wikiPlanTopicsBrief(r.materials))}\n`;
}

/**
 * What one document's outline is written from: its documents' whole heading trees, its code's symbols, and the
 * topics it names — the targeted materials of the sample's doc_materials.
 */
export function wikiPlanDocMaterials(r: WikiPlanRunState, unit: WikiPlanUnit): string {
  const docs = [...unit.header.keyDocs];
  const code = [...unit.header.keyCode];
  const topics = [...unit.header.topics];
  const sections: Array<Pick<WikiPlanSectionDraft, 'docs' | 'code' | 'sessions'>> = [...unit.sections];
  if (unit.kept) {
    for (const s of wikiPlanDocInput(unit.kept).sections) {
      sections.push({ docs: s.sources.docs, code: s.sources.code, sessions: null });
      if (s.sources.sessions) topics.push(...s.sources.sessions.topics);
    }
  }
  for (const s of sections) {
    for (const d of s.docs) docs.push(d.path);
    for (const c of s.code) code.push(c.path);
    if (s.sessions) topics.push(...s.sessions.topics);
  }
  let trees = '';
  const seen = new Set<string>();
  for (const raw of docs) {
    let file = goTrimSpace(raw);
    if (file.startsWith('./')) file = file.slice(2);
    if (seen.has(file) || !r.repo.hasHeadings(file)) continue;
    seen.add(file);
    trees += r.repo.docBlock(file, 6);
  }
  if (trees === '') trees = '(this document has no main source documents yet, or they are not in the documents list)\n';
  return materialsHead(r)
    + `${material(1, 'Repository overview', r.repo.overviewText(WIKI_PLAN_MATERIAL_CAPS.overview.doc))}\n`
    + `${material(2, 'All documents (path [bytes] — title)', r.repo.docIndexText())}\n`
    + `${material(3, "The section trees of this document's main source documents (after § on a Docs line, copy a section heading from here exactly)", trees)}\n`
    + `${material(4, 'The symbols of the code this document is about (written "path: symbol, Class.method [HTTP route], function()"; on a Code line, copy the paths and symbols from here exactly)', r.repo.codeExcerpt(code, WIKI_PLAN_MATERIAL_CAPS.codeExcerpt))}\n`
    + `${material(5, 'contracts inventory', r.repo.contractsText())}\n`
    + `${material(6, 'Project titles (the projects on a Sessions line copy a title from here exactly)', wikiPlanProjectsText(r.materials))}\n`
    + `${material(7, "This space's topics, and the newest entries of the topics this document is about (the topics on a Sessions line use only the slugs here)", wikiPlanTopicBlocks(r.materials, topics))}\n`;
}

/** The catalogue as it stands, in the line format, with the documents' numbers now. */
export function wikiPlanCatalogueText(r: WikiPlanRunState): string {
  let b = '';
  r.cats.forEach((cat, c) => {
    b += `## ${c + 1}. ${cat.title} \`${cat.key}\` — ${cat.question}${cat.forAgents ? ' [agents]' : ''}\n`;
    for (const unit of r.units) {
      if (unit.cat !== c) continue;
      const scope = unit.header.scopeIn.length > 0 ? unit.header.scopeIn : unit.cardScope;
      const mark = unit.protectedDoc ? ' [protected]' : '';
      b += `- ${unit.id} ${unit.title} \`${unit.slug}\`${mark} | ${unit.question} | Includes: ${scope.join('; ')}\n`;
    }
    b += '\n';
  });
  return b;
}

/** The documents of the version revised the owner protected: a draft keeps them as they are. */
export function wikiPlanProtectedBlock(r: WikiPlanRunState): string {
  if (!r.base) return '';
  const lines: string[] = [];
  for (const [id, slug] of r.baseIds) {
    const doc = r.baseDocs.get(slug)!;
    if (doc.protected) lines.push(`- \`${doc.slug}\` ${doc.title} (now ${id}, category \`${doc.category}\`)`);
  }
  if (lines.length === 0) return '';
  lines.sort(goCompare);
  return '\n## Protected documents (set by the owner, kept as they are)\nThese documents must appear in the catalogue: with the same slug, in the '
    + 'category with the same key (whose key must not change either); you do not write their content, and no section moves out of them.\n'
    + `${lines.join('\n')}\n`;
}

function guidanceBlock(r: WikiPlanRunState): string {
  return r.instructions === '' ? '' : `\n## What the owner asks (do it)\n${r.instructions}\n`;
}

const CATALOGUE_FORMAT = '## Output format\nOutput only the Markdown below, with no preamble and no summary:\n'
  + '## <category number>. <category title> `<category key: lowercase letters and hyphens>` — <what this category answers for the reader> '
  + "(end the line of the agents' category with [agents])\n"
  + '- <document id, such as 1.2> <title> `<slug: lowercase letters and hyphens>` | <the question the reader comes with, in one sentence> | '
  + 'Includes: <point>; <point>; <point>\n';

/** Step 1: the catalogue's skeleton. */
export function wikiPlanSkeletonPrompt(r: WikiPlanRunState): string {
  return `
# Task: draft the plan of the wiki «${r.spaceTitle}» — step 1: the skeleton of the document catalogue
${WIKI_PLAN_BACKGROUND}
## Requirements
- Organize by product feature, not by code directory. A category holds several documents; a document answers one set of related questions a reader has.
- Cover the main product features the materials show (see the repository structure, the document heading tree, the contracts, and the project and session clusters). A one-off data or experiment project gets no document of its own.
- Size: ${r.target.min}–${r.target.max} documents in all (the gate holds the plan to this number and sends back too few or too many), in 5–12 categories. Neighbouring documents do not overlap.
- The development conventions for the agents that write code (how to run the tests, set up dependencies, commit and merge, run commands in a session) get a category of their own, last, with [agents] at the end of its line.
- No document's slug appears twice in the whole catalogue, and no category's key appears twice.
${wikiPlanProtectedBlock(r)}${guidanceBlock(r)}
${CATALOGUE_FORMAT}`;
}

/** The catalogue again, with what the gate found in it. */
export function wikiPlanCatalogueRedoPrompt(r: WikiPlanRunState, errorLines: string): string {
  return `
# Task: correct the catalogue of the plan of the wiki «${r.spaceTitle}»
This catalogue did not pass the gate; its errors are listed one by one below. Correct each of them and keep the rest as it is: keep every document that can be kept, with its slug.
## Errors
${errorLines}
## This round's catalogue
${wikiPlanCatalogueText(r)}
## Requirements (as in step 1)
- ${r.target.min}–${r.target.max} documents in all; the development conventions for the agents that write code get a category of their own, last, with [agents] at the end of its line; no document's slug and no category's key appears twice.
${wikiPlanProtectedBlock(r)}${guidanceBlock(r)}
${CATALOGUE_FORMAT}`;
}

/** Step 2: one category's documents, each with its reader, scope, length and key materials. */
export function wikiPlanDetailPrompt(r: WikiPlanRunState, cat: number, ids: readonly string[]): string {
  return `
# Task: draft the plan — step 2: complete each document of the category «${r.cats[cat].title}»
The whole catalogue is above. Handle only these documents of category ${cat + 1}: ${ids.join(', ')}.
${WIKI_PLAN_BACKGROUND}
## What to write for each document
- Audience: whom it is written for (such as "a developer new to the project", "the people who deploy and operate it", "the people who write agent prompts", "the owner"), each with what they can do once they have read it;
- Includes: what it covers, 3–6 points; Excludes: what it deliberately does not cover, each with the document it is left to (that document's id in the catalogue);
- Length: a range of characters;
- Docs: the design or contract documents it mainly draws on (only paths that appear in material 2);
- Code: where in the code it mainly draws on (directories or files, only paths that appear in material 3);
- Contracts: the contract files it concerns (material 4; write "none" if there are none);
- Topics: the topics its existing entries are mostly in (only slugs from material 6; write "none" if there are none);
- Projects: the titles of the projects it concerns (copied exactly from material 5, at most 5; write "none" if there are none).

## Output format
Output only the Markdown below, one block a document, with no preamble and no summary:
### <document id> <title>
Audience: <who>: <what they can do once they have read it>; <who>: <what they can do once they have read it>
Includes: <point>; <point>; <point>
Excludes: <content> (see <document id>); <content> (see <document id>)
Length: <a–b characters>
Docs: <docs/…>, <docs/…>
Code: <src/…>, <src/…>
Contracts: <contracts/… or none>
Topics: <slug>, <slug>
Projects: 「<project title>」「<project title>」
`;
}

const OUTLINE_RULES = `
## Outline
- Order to start from: overview → concepts → flow/state machine → interface → data and configuration → operations → known pitfalls → decisions and reasons → conventions. Add, drop, merge or rename sections to fit what this document covers; not every document needs them all.
- 5–9 sections. For each, give: the section title, its type (one of overview / concepts / flow / interface / data / ops / pitfalls / decisions / conventions / other), its length in characters, and what it covers (what exactly this section says, in 1–2 sentences: the actual content, no filler).
- Write only what is within this document's scope; what the catalogue leaves to another document stays out. To mention another document, write "see <document id>", with the id the catalogue gives it.

## Where each section's material comes from
- A section on a mechanism (concepts / flow / interface / data / ops) draws on the code and the design documents: a document down to its section heading (copied exactly from the section headings in material 3), code down to its file and symbols (copied exactly from the paths and symbols in material 4).
- The known pitfalls, decisions and reasons, and conventions sections draw on first-hand words said in sessions, which the existing entries lead to. Say by what conditions to look for them: the projects concerned (titles copied exactly from material 6), a time window, keywords, anchor paths (code path prefixes), entry kinds (principle / convention / decision / pitfall / recipe / concept), existing topic slugs (only those in material 7), and what kind of original words to look for.
- An overview section may have no sources of its own, but its Covers line says which sections it sums up.
- Cite only files, section headings, symbols, project names and topics that really appear in the materials; when nothing fits, write less rather than invent.

## Each section's format (one item a line; leave out the lines you have no use for, and add no other line)
### <number>. <section title> | <type> | <length in characters>
Covers: <what exactly this section says, in 1–2 sentences>
- Docs: <docs/….md> § <section heading, copied exactly>
- Code: <src/… file path>: <symbol name, copied exactly>, <symbol name>
- Contracts: <contracts/…>
- Sessions: projects 「<project title>」「…」; dates <YYYY-MM-DD> to <YYYY-MM-DD or now>; keywords <word>, <word>; anchors <path prefix>, <…>; kind <pitfall/decision/convention/…>; topics <slug>; look for: <what kind of original words to look for>
Docs and Code may each take several lines, one place a line.
`;

function firstNonEmptyList(...lists: string[][]): string[] {
  return lists.find((list) => list.length > 0) ?? [];
}

/** Step 3: one document's outline, and where each section's material comes from. */
export function wikiPlanOutlinePrompt(unit: WikiPlanUnit): string {
  const h = unit.header;
  const card = `- ${unit.id} ${unit.title} \`${unit.slug}\` | ${unit.question}\nAudience: ${h.audience.join('; ')}\n`
    + `Includes: ${firstNonEmptyList(h.scopeIn, unit.cardScope).join('; ')}\nExcludes: ${h.scopeOut.join('; ')}\nLength: ${h.length}\n`;
  return `
# This document
${card}
# Task: step 3 of drafting the plan — write the outline of «${unit.title}», and where each section's material comes from
${OUTLINE_RULES}
## Output format
Output only this document's outline, starting at the first "### 1.", with no preamble, no summary and no JSON.
`;
}

const DOC_FORMAT = `## Output format
Output only this document, with no preamble, no summary and no JSON. First write these six lines, then the outline:
Title: <title>
Question: <the question the reader comes with, in one sentence>
Audience: <who>: <what they can do once they have read it>; <who>: <what they can do once they have read it>
Includes: <point>; <point>; <point>
Excludes: <content> (see <document id>); <content> (see <document id>)
Length: <a–b characters>

### 1. <section title> | <type> | <length in characters>
Covers: …
- Docs: …
- Code: …
- Contracts: …
- Sessions: …
`;

/**
 * A revision's rewrite of one document: the documents of the version revised it is made from, and the sections
 * moved into it, as one coherent outline.
 */
export function wikiPlanRewritePrompt(r: WikiPlanRunState, unit: WikiPlanUnit, catalogue: string): string {
  let sources = '';
  const names = wikiPlanProjectNames(r);
  for (const id of unit.sources) {
    const slug = r.baseIds.get(id);
    if (slug === undefined) continue;
    const doc = wikiPlanDocNamed(wikiPlanDocInput(r.baseDocs.get(slug)!), names);
    const drop = new Set<number>();
    for (const move of r.moves) if (move.from === id) drop.add(move.section);
    sources += `[Now ${id} «${doc.title}»]\n${wikiPlanDocLines(doc, true, drop)}\n`;
  }
  for (const move of r.moves) {
    if (move.target !== unit) continue;
    const slug = r.baseIds.get(move.from);
    if (slug === undefined) continue;
    const doc = wikiPlanDocNamed(wikiPlanDocInput(r.baseDocs.get(slug)!), names);
    if (move.section >= 1 && move.section <= doc.sections.length) {
      sources += `[Now ${move.from}, section ${move.section} (moved into this document)]${wikiPlanSectionLines(1, doc.sections[move.section - 1])}\n`;
    }
  }
  if (sources === '') sources = '(a new document: there is no current content; write it from the catalogue and what the owner asks)\n';
  return `${wikiPlanDocMaterials(r, unit)}
# The new catalogue (document ids as given here)
${catalogue}
# Task: write the audience, scope and outline of «${unit.title}» in the new draft
## This document in the new catalogue
- ${unit.id} ${unit.title} \`${unit.slug}\` | ${unit.question} | Includes: ${unit.cardScope.join('; ')}
## What the owner asks
${r.instructions}
## What it is made of now (the current outlines, with each section's sources)
${sources}
## Requirements
- Make the content above into one coherent document outline: drop what repeats, and order it as the reader's questions come; 5–10 sections; keep the existing sources exactly as they are under their sections, and invent no new source.
- On the Excludes line, say which document each item is left to, by its id in the new catalogue.
${OUTLINE_RULES}
${DOC_FORMAT}`;
}

/** One document again, with what the gate found in it. */
export function wikiPlanRedoDocPrompt(
  r: WikiPlanRunState,
  unit: WikiPlanUnit,
  errs: readonly WikiPlanGateError[],
  last: WikiPlanAssembled,
  catalogue: string,
): string {
  let current = '';
  last.units.forEach((u, i) => {
    if (u === unit) current = wikiPlanDocLinesWithRefs(wikiPlanDocNamed(last.plan.docs[i], wikiPlanProjectNames(r)), last.slugIds);
  });
  return `
# The catalogue (document ids as given here)
${catalogue}
# Task: correct the document «${unit.title}» (${unit.id}) of the plan
This document did not pass the gate; its errors are listed one by one below. Correct each of them: use only files, sections, symbols, projects and topics that the materials have; where no fitting source can be found, delete that reference rather than invent one; keep the rest as it is.
## Errors
${wikiPlanErrorLines(errs, last)}
## This document as it stands
${current}
${OUTLINE_RULES}
${DOC_FORMAT}`;
}

/**
 * How a revision's prompts name the projects of the version it revises: by title, the way the drafting prompts
 * name every project and the gate reads them back — never by id, which a local model copies wrong. A project
 * keeps its id where its title is not one only it has in the owner's list (a title two projects share names
 * neither), where the list may be cut short (materialsProjectsMax), or where the title would not read back whole
 * from a session line.
 */
export function wikiPlanProjectNames(r: WikiPlanRunState): Map<string, string> {
  const names = new Map<string, string>();
  if (r.materials.projects.length >= WIKI_PLAN_MATERIALS_PROJECTS_MAX) return names;
  const titled = new Map<string, number>();
  for (const p of r.materials.projects) titled.set(p.title, (titled.get(p.title) ?? 0) + 1);
  for (const doc of r.baseDocs.values()) {
    for (const s of doc.sections) {
      const c = s.sources.sessions;
      if (!c) continue;
      for (const p of c.projects) {
        if (p.title === null || titled.get(p.title) !== 1) continue;
        const back = wikiPlanSessionsOf(wikiPlanSessionsLine({
          projects: [p.title], since: null, until: null, keywords: [], anchorPaths: [], entryKinds: [], topics: [], evidence: '',
        })).projects;
        if (back.length === 1 && back[0] === p.title) names.set(p.id, p.title);
      }
    }
  }
  return names;
}

/** `plan.jobs.rules.materialsProjectsMax`: a list that long may leave some out. */
export const WIKI_PLAN_MATERIALS_PROJECTS_MAX = 500;

/** A document as a prompt shows it: its session conditions' projects by the names given (wikiPlanProjectNames), any other as it is. */
export function wikiPlanDocNamed(doc: WikiPlanDoc, names: ReadonlyMap<string, string>): WikiPlanDoc {
  return {
    ...doc,
    sections: doc.sections.map((s) => (s.sources.sessions
      ? { ...s, sources: { ...s.sources, sessions: { ...s.sources.sessions, projects: s.sources.sessions.projects.map((p) => names.get(p) || p) } } }
      : s)),
  };
}

/**
 * A document in the line format with its scope-out targets as numbers of the catalogue now: what the model is
 * shown of what it wrote.
 */
export function wikiPlanDocLinesWithRefs(doc: WikiPlanDoc, slugIds: ReadonlyMap<string, string>): string {
  const shown: WikiPlanDoc = {
    ...doc,
    scopeOut: doc.scopeOut.map((out) => {
      const ids = out.docs.map((slug) => slugIds.get(slug) ?? slug);
      return { text: ids.length > 0 ? `${out.text} (see ${ids.join(', ')})` : out.text, docs: [] };
    }),
  };
  return wikiPlanDocLines(shown, true, null);
}

/**
 * A revision's catalogue (R1): the version revised, the owner's instructions, and — in a later round — what the
 * gate found in the last one.
 */
export function wikiPlanRevisionCataloguePrompt(r: WikiPlanRunState, errs: readonly WikiPlanGateError[], errorLines: string): string {
  const base = r.base!;
  let brief = '';
  base.categories.forEach((cat, c) => {
    brief += `## ${c + 1}. ${cat.title} \`${cat.key}\` — ${cat.question}${cat.forAgents ? ' [agents]' : ''}\n`;
    let n = 0;
    for (const doc of base.docs) {
      if (doc.category !== cat.key) continue;
      n += 1;
      const mark = doc.protected ? ' [protected]' : '';
      brief += `- ${c + 1}.${n} ${doc.title} \`${doc.slug}\`${mark} (${doc.length.min}–${doc.length.max} characters): ${doc.question} | `
        + `Includes: ${doc.scopeIn.join('; ')}\n`;
      doc.sections.forEach((s, i) => {
        brief += `    §${i + 1} ${s.title} (${s.kind}): ${cutRunes(s.covers, 120)}\n`;
      });
    }
    brief += '\n';
  });
  const again = errs.length > 0
    ? `\n## The catalogue the last round of the revision made did not pass the gate; its errors are listed one by one below: correct each of them\n`
      + `${errorLines}\n## The catalogue the last round of the revision made\n${wikiPlanCatalogueText(r)}\n`
    : '';
  return `
# Task: revise the catalogue of the plan as the owner asks (v${base.version} → a new draft)

## What the owner asks
${r.instructions}

# The plan now (v${base.version}, ${count(base.categories.length, 'category', 'categories')}, ${count(base.docs.length, 'document', 'documents')}; each document lists its sections and their types)
${brief}${again}
## Requirements
- Target: ${r.target.min}–${r.target.max} documents in all (the gate holds the plan to this number and sends back too few or too many). When documents merge, the content of each merged one becomes sections of the new one and nothing is lost; the new document's title and question cover what was merged into it.
- A document marked [protected] is kept as it is: its title, slug and category (key) do not change, and no section moves out of it.
- The development conventions for the agents that write code get a category of their own, with [agents] at the end of its line; only sections of type conventions may move into it, and sections of any other type stay where they are.
- Every document says its Sources: which documents of the plan now it is made of (their current ids); a new document writes "Sources: none".
- The new document ids are numbered in the order of the new categories; a document keeps the slug of its source (when documents merge, the main source's), and a new document gets a new slug; keep the category keys where you can.

## Output format
Output only the Markdown below, with no preamble:
## <category number>. <category title> \`<category key>\` — <what this category answers for the reader>
- <new id> <title> \`<slug>\` | <the question the reader comes with> | Sources: <current id>, <current id> | Includes: <point>; <point>; <point>
(one line a document)

Last, write:
### Sections moved into the agents' category
- <current id> §<section number> → <new id>
(one section a line; write "none" if there are none)
`;
}

/** Step 4: a draft of the rules the documents are written and maintained by. */
export function wikiPlanRulesPrompt(r: WikiPlanRunState): string {
  return `${r.repo.overviewText(WIKI_PLAN_MATERIAL_CAPS.overview.doc)}\n# Document catalogue\n${wikiPlanCatalogueText(r)}
# Task: step 4 of drafting the plan — a draft of the three rules
The maintenance runs and the writing of the documents follow these three rules. Write them as rules that can be followed, and checked in code.

## Constraints that may not be broken
- A source can only be a first-hand record: turn / event / tool_call / task / task_comment / approval / evidence / owner_decision / merge_receipt / criterion / commit / note, and the code and documents on origin/main; a wiki entry or a document itself can never be a source.
- A session's text is redacted before it is handed to a model.
- Maintenance is triggered by facts (a new session settled, a task reaching a final state, an approval answered, a merge receipt, a criterion revised), never by a timer.
- A document is only a view: it is not pushed to agents, and cannot be cited as a source.
- A section on a mechanism draws on the code and the design documents; pitfalls, decisions and conventions draw on the words said in sessions, with an entry only as the layer between them (via entry).

## What each of the three rules answers
### 1. Citation rules: what counts as a statement of fact; how each kind of source is located; what a footnote shows and where it links; which original words stand up, and which to choose when an old and a new statement conflict; how summary and transition sentences are handled; what becomes of a sentence that fails its check.
### 2. Merge rules: how several entries and several original passages about one thing combine into "the current state"; where a statement that was overturned goes; how each material is recorded as adopted, merged or dropped.
### 3. Maintenance rules: how new knowledge finds the section of the plan it belongs in, with only the sections it affects written again; how the sentences that cite an entry are withdrawn when the entry is rejected or retired; how new knowledge that fits no section becomes a proposed change to the plan.

## Output format
Output only Markdown: three second-level headings, "## Citation rules", "## Merge rules" and "## Maintenance rules", each followed by numbered items. 2000–3500 characters in all.
`;
}

const SECTION_PATH = /^plan\.docs\[(\d+)\](?:\.sections\[(\d+)\])?([^\n]*)$/u;

/** Errors as the model reads them: which document and section, then what is wrong. */
export function wikiPlanErrorLines(errs: readonly WikiPlanGateError[], last: WikiPlanAssembled): string {
  let b = '';
  for (const e of errs) {
    let where = e.path;
    const m = SECTION_PATH.exec(e.path);
    if (m) {
      const i = Number.parseInt(m[1], 10);
      if (i < last.plan.docs.length) {
        const doc = last.plan.docs[i];
        where = `${last.units[i].id} «${doc.title}»`;
        if (m[2] !== undefined && m[2] !== '') {
          const j = Number.parseInt(m[2], 10);
          if (j < doc.sections.length) where += `, section ${j + 1} «${doc.sections[j].title}»`;
        }
        const tail = (m[3] ?? '').startsWith('.') ? m[3].slice(1) : m[3] ?? '';
        if (tail !== '') where += ` · ${tail}`;
      }
    }
    b += `- [${e.check}] ${where}: ${e.message}\n`;
  }
  return b;
}
