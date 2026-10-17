import {
  WIKI_KINDS,
  WIKI_PLAN_RULES,
  WIKI_PLAN_SECTION_KINDS,
  WIKI_SLUG_PATTERN,
  type WikiPlanGateCheck,
  type WikiPlanGateError,
  type WikiPlanRepoCheck,
} from '@orbit/shared';
import { cutRunes, goTrimSpace } from './wiki-import-extract';
import {
  WIKI_PLAN_IDS,
  WIKI_PLAN_SCOPE_OUT_REF,
  wikiPlanDocInput,
  wikiPlanRange,
  wikiPlanRenumber,
  type WikiPlanCategory,
  type WikiPlanDoc,
  type WikiPlanDraft,
  type WikiPlanSection,
  type WikiPlanSectionDraft,
  type WikiPlanSources,
  type WikiPlanUnit,
} from './wiki-plan-format';
import { wikiPlanTopicsBrief } from './wiki-plan-materials';
import { WIKI_PLAN_MATERIALS_PROJECTS_MAX, type WikiPlanRunState } from './wiki-plan-prompts';
import { shortWikiHash } from './wiki-plan-repo';

/**
 * The drafting job's own gate (contract `plan.jobs.server`): what the server's gate checks that a draft can be
 * held to here, and what only the repository can answer — before anything is submitted. Ported word for word
 * from `src/runner-go/wiki_plan_gate.go`; what differs is where the repository is read: the space's snapshot of
 * origin/main (wiki-plan-repo.ts), not a checkout — which is what lets the plan's gate on the server check the
 * repository at all.
 *
 *   schema      every line of the answers is a field of the plan, every field within its limits, a section's
 *               kind one of the closed set, a category for the agents' conventions there;
 *   docCount    the documents are as many as the target;
 *   protected   every document the version revised protects is there as it was, in its category, and what it
 *               leaves to other documents is still there; a revision moves a section out only if it is a
 *               convention, only into the agents' category, and never out of a protected one;
 *   references  every file, docs section, symbol and contract is on origin/main at the sha, every project,
 *               topic and entry kind is one there is, every document a scope leaves something to is one of the
 *               plan's, and every `→ 3.2` or `see 3.2` in the text names a document of this plan.
 *
 * Its errors carry the server's paths (`plan.docs[3].sections[1].sources.code[0].symbols[2]`), so one list of
 * errors — this gate's or the server's — is handed back to the model the same way.
 */

/** One round's draft: the plan as it would be submitted, which document each is, and what the gate found. */
export interface WikiPlanAssembled {
  plan: WikiPlanDraft;
  units: WikiPlanUnit[];
  errors: WikiPlanGateError[];
  repo: WikiPlanRepoCheck;
  sections: number;
  /** Each document's number now, by its slug. */
  slugIds: Map<string, string>;
}

const SLUG = new RegExp(WIKI_SLUG_PATTERN, 'u');
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const DOC_PATH = /^plan\.docs\[(\d+)\]/u;

/** What a message would not show, as Go's wikiQuote finds it: controls, format characters, separators and every space but U+0020. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;

/**
 * A value a model wrote as a refusal names it back (wiki_verify.go `wikiQuote`): a JSON string, with every
 * character that would not show written as \uXXXX — the backticks around a value, a space at either end and an
 * invisible character all show.
 */
export function wikiQuote(value: string): string {
  let b = '"';
  for (const r of value) {
    if (r === '"' || r === '\\') b += `\\${r}`;
    else if (r === '\b') b += '\\b';
    else if (r === '\f') b += '\\f';
    else if (r === '\n') b += '\\n';
    else if (r === '\r') b += '\\r';
    else if (r === '\t') b += '\\t';
    else if (r !== ' ' && UNSEEN.test(r)) {
      for (let i = 0; i < r.length; i += 1) b += `\\u${r.charCodeAt(i).toString(16).padStart(4, '0')}`;
    } else b += r;
  }
  return `${b}"`;
}

const WRAPPERS: ReadonlyArray<readonly [string, string]> = [['`', '`'], ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['«', '»']];

/**
 * A closed-set value as a check reads it (wiki_verify.go `wikiUnwrap`): the white space at either end taken off,
 * then whatever backticks or quotes wrap the whole of it — a pair at its two ends with no more of either inside —
 * as often as they do.
 */
export function wikiUnwrap(input: string): string {
  let value = input;
  for (;;) {
    value = goTrimSpace(value);
    const pair = WRAPPERS.find(([open, close]) => {
      if (value.length < open.length + close.length || !value.startsWith(open) || !value.endsWith(close)) return false;
      const inner = value.slice(open.length, value.length - close.length);
      return !inner.includes(open) && !inner.includes(close);
    });
    if (!pair) return value;
    value = value.slice(pair[0].length, value.length - pair[1].length);
  }
}

/** The documents' numbers in the catalogue: category by category, in order (the run's `number`). */
export function wikiPlanNumber(r: Pick<WikiPlanRunState, 'units'>): void {
  const counts = new Map<number, number>();
  r.units.sort((a, b) => a.cat - b.cat);
  for (const unit of r.units) {
    counts.set(unit.cat, (counts.get(unit.cat) ?? 0) + 1);
    unit.id = `${unit.cat + 1}.${counts.get(unit.cat)}`;
  }
}

/** The gate's error for a plan of n documents, when n is outside the target. */
export function wikiPlanCountError(n: number, target: { min: number; max: number }): WikiPlanGateError | null {
  if (n >= target.min && n <= target.max) return null;
  // How far off it is, said: a model told only to merge took a catalogue of 68 to 43 for a target of 20–35.
  const advice = n < target.min
    ? `split the broadest documents, or add the ones the categories are missing — ${target.min - n} too few`
    : `merge documents that answer the same reader's question — ${n - target.max} too many`;
  return { check: 'docCount', path: 'plan.docs', message: `the plan has ${n} documents; it must have ${target.min} to ${target.max}: ${advice}` };
}

/**
 * Whether an error is the catalogue's to fix rather than one document's: the count, the categories, the moves, a
 * protected document left out, and a document's slug, category or sources — what the catalogue says of it.
 */
export function wikiPlanCatalogueLevel(path: string): boolean {
  const m = DOC_PATH.exec(path);
  if (!m) return true;
  return ['.slug', '.category', '.sources', '.protected'].some((suffix) => path === m[0] + suffix);
}

/** The document an error's path is in. */
export function wikiPlanDocIndex(path: string): number | null {
  const m = DOC_PATH.exec(path);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Build the round's draft from the catalogue and what was written of each document, and gate it. */
export function wikiPlanAssemble(r: WikiPlanRunState): WikiPlanAssembled {
  wikiPlanNumber(r);
  const a: WikiPlanAssembled = {
    plan: { categories: [], docs: [] },
    units: [],
    errors: [],
    repo: { sha: r.repo.sha, checked: 0, missing: [] },
    sections: 0,
    slugIds: new Map(),
  };
  const g = new Gate(r, a);
  for (const unit of r.units) if (!a.slugIds.has(unit.slug)) a.slugIds.set(unit.slug, unit.id);
  const keys = new Set<string>();
  let agents = false;
  r.cats.forEach((cat, i) => {
    const path = `plan.categories[${i}]`;
    if (!SLUG.test(cat.key) || Buffer.byteLength(cat.key, 'utf8') > 64) {
      g.fail('schema', `${path}.key`, `${wikiQuote(cat.key)} is not a key: lowercase letters and digits joined by single hyphens`);
    }
    if (keys.has(cat.key)) g.fail('schema', `${path}.key`, `${wikiQuote(cat.key)} is the key of an earlier category`);
    keys.add(cat.key);
    g.text(`${path}.title`, cat.title, WIKI_PLAN_RULES.titleMaxChars, true);
    g.text(`${path}.question`, cat.question, WIKI_PLAN_RULES.questionMaxChars, false);
    agents = agents || cat.forAgents;
    const category: WikiPlanCategory = { key: cat.key, title: cat.title };
    if (cat.question !== '') category.question = cat.question;
    if (cat.forAgents) category.forAgents = true;
    a.plan.categories.push(category);
  });
  if (r.cats.length > WIKI_PLAN_RULES.categoriesMax) g.fail('schema', 'plan.categories', `a plan has at most ${WIKI_PLAN_RULES.categoriesMax} categories`);
  if (!agents) {
    g.fail('schema', 'plan.categories', "the plan has no category for the agents' development conventions (how to test, "
      + 'commit, land and run commands here): add one, last, with [agents] at the end of its line');
  }
  const slugs = new Set<string>();
  let extra = false;
  r.units.forEach((unit, i) => {
    const doc = g.doc(i, unit);
    if (slugs.has(doc.slug)) g.fail('schema', `plan.docs[${i}].slug`, `${wikiQuote(doc.slug)} is the slug of an earlier document`);
    slugs.add(doc.slug);
    if (doc.extra && Object.keys(doc.extra).length > 0) extra = true;
    for (const s of doc.sections) if (s.extra && Object.keys(s.extra).length > 0) extra = true;
    a.sections += doc.sections.length;
    a.plan.docs.push(doc);
    a.units.push(unit);
  });
  if (extra && r.base && r.base.newFields.length > 0) a.plan.newFields = r.base.newFields;
  g.whole(slugs, keys);
  if (a.repo.missing.length > WIKI_PLAN_RULES.repoMissingMax) a.repo.missing = a.repo.missing.slice(0, WIKI_PLAN_RULES.repoMissingMax);
  return a;
}

class Gate {
  constructor(private readonly r: WikiPlanRunState, private readonly a: WikiPlanAssembled) {}

  fail(check: WikiPlanGateCheck, path: string, message: string): void {
    this.a.errors.push({ check, path, message });
  }

  /** What no one document can say: the count, and the protected documents and moves. */
  whole(slugs: ReadonlySet<string>, keys: ReadonlySet<string>): void {
    const r = this.r;
    const count = wikiPlanCountError(this.a.plan.docs.length, r.target);
    if (count) this.a.errors.push(count);
    if (!r.base) return;
    for (const [id, slug] of r.baseIds) {
      const base = r.baseDocs.get(slug)!;
      if (!base.protected) continue;
      let i = -1;
      this.a.units.forEach((unit, j) => {
        if (unit.slug === slug) i = j;
      });
      if (i < 0) {
        this.fail('protected', 'plan.docs', `${id} «${base.title}» (\`${slug}\`) is protected: it stays in every new version as it is, and this `
          + `catalogue leaves it out — list it, with its slug, in its category \`${base.category}\``);
        continue;
      }
      if (!keys.has(base.category)) {
        this.fail('protected', `plan.docs[${i}].category`, `${this.a.units[i].id} «${base.title}» is protected and stays in its category `
          + `\`${base.category}\`, which this catalogue no longer has: keep that category, with its key`);
      }
      for (const out of base.scopeOut) {
        for (const target of out.docs) {
          if (!slugs.has(target)) {
            this.fail('protected', 'plan.docs', `${this.a.units[i].id} «${base.title}» is protected and leaves «${out.text}» to \`${target}\`, which this catalogue no `
              + 'longer has: keep that document');
          }
        }
      }
    }
    // A protected document is kept as it is, never merged into another as well.
    this.a.units.forEach((unit, i) => {
      for (const source of unit.sources) {
        const slug = r.baseIds.get(source);
        if (slug !== undefined && r.baseDocs.get(slug)!.protected && slug !== unit.slug) {
          this.fail('protected', `plan.docs[${i}].sources`, `${unit.id} is made from ${source}, which is protected: a protected `
            + 'document is kept as it is and not merged into another');
        }
      }
    });
    r.moves.forEach((move, k) => {
      const path = `plan.moves[${k}]`;
      const slug = r.baseIds.get(move.from);
      if (slug === undefined) {
        this.fail('protected', path, `moves §${move.section} of ${wikiQuote(move.from)}, which the version revised has no document numbered`);
        return;
      }
      const base = r.baseDocs.get(slug)!;
      if (base.protected) {
        this.fail('protected', path, `moves §${move.section} out of ${move.from} «${base.title}», which is protected: no section of it moves out`);
        return;
      }
      if (move.section < 1 || move.section > base.sections.length) {
        this.fail('protected', path, `moves §${move.section} of ${move.from} «${base.title}», which has ${base.sections.length} sections`);
        return;
      }
      const section = base.sections[move.section - 1];
      if (section.kind !== 'conventions') {
        this.fail('protected', path, `moves §${move.section} «${section.title}» of ${move.from}, a ${section.kind} section: only a conventions section moves into the agents' `
          + 'category — keep it where it is');
      }
      if (!move.target) {
        this.fail('protected', path, `moves §${move.section} of ${move.from} to ${wikiQuote(move.to)}, which is no document of the new catalogue`);
        return;
      }
      if (move.target.cat >= r.cats.length || !r.cats[move.target.cat].forAgents) {
        this.fail('protected', path, `moves §${move.section} of ${move.from} into ${move.target.id}, which is not in the agents' category`);
      }
    });
  }

  /** The number a document has now, from its number in the catalogue refs was written against (the catalogue as it stands when refs is null). */
  renamer(refs: ReadonlyMap<string, string> | null): (id: string) => string | null {
    return (id) => {
      let slug = refs?.get(id);
      if (refs === null) {
        for (const unit of this.r.units) if (unit.id === id) slug = unit.slug;
      }
      if (slug === undefined) return null;
      return this.a.slugIds.get(slug) ?? null;
    };
  }

  /** The numbers in one text renumbered, and each one that points at no document of this plan named. */
  crossRefs(path: string, text: string, refs: ReadonlyMap<string, string> | null): string {
    const { text: out, unknown } = wikiPlanRenumber(text, this.renamer(refs));
    for (const id of unknown) {
      const slug = refs?.get(id);
      if (slug !== undefined) {
        this.fail('references', path, `«${cutRunes(text, 80)}» points at ${wikiQuote(id)}, which was \`${slug}\` and is no document of this plan any more: point at `
          + 'the document that covers it now, or drop the pointer');
        continue;
      }
      this.fail('references', path, `«${cutRunes(text, 80)}» points at ${wikiQuote(id)}, which is no document of this plan: name a document by its number in `
        + 'the catalogue, or drop the pointer');
    }
    return out;
  }

  /** One document of the draft: carried as it is, carried less its moved sections, or built from what the model wrote of it. */
  doc(i: number, unit: WikiPlanUnit): WikiPlanDoc {
    const r = this.r;
    const path = `plan.docs[${i}]`;
    if (unit.protectedDoc) {
      const doc = unit.protectedDoc;
      // The owner's: what it names that is gone is reported with the draft, and is not the model's to fix.
      doc.sections.forEach((s, j) => this.sources(`${path}.sections[${j}]`, s.sources, false));
      return doc;
    }
    const catKey = unit.cat < r.cats.length ? r.cats[unit.cat].key : '';
    if (unit.kept) {
      const doc = wikiPlanDocInput(unit.kept);
      doc.category = catKey;
      delete doc.protected;
      if (unit.title !== '') doc.title = unit.title;
      if (unit.question !== '') doc.question = this.crossRefs(`${path}.question`, unit.question, null);
      if (unit.cardScope.length > 0) doc.scopeIn = unit.cardScope.map((item, k) => this.crossRefs(`${path}.scopeIn[${k}]`, item, null));
      doc.scopeOut.forEach((out, k) => {
        const original = out.text;
        out.text = this.crossRefs(`${path}.scopeOut[${k}].text`, original, unit.refs);
        out.docs.forEach((target, m) => {
          if (!this.a.slugIds.has(target)) {
            this.fail('references', `${path}.scopeOut[${k}].docs[${m}]`, `leaves «${original}» to \`${target}\`, which is no `
              + 'document of this plan any more: leave it to the document that covers it now');
          }
        });
      });
      const sections: WikiPlanSection[] = [];
      doc.sections.forEach((s, n) => {
        if (unit.keptDrop?.has(n + 1)) return;
        const sp = `${path}.sections[${sections.length}]`;
        s.covers = this.crossRefs(`${sp}.covers`, s.covers, unit.refs);
        this.sources(sp, s.sources, true);
        sections.push(s);
      });
      doc.sections = sections;
      this.limits(path, doc);
      return doc;
    }
    const h = unit.header;
    const doc: WikiPlanDoc = {
      category: catKey,
      slug: unit.slug,
      title: h.title !== '' ? h.title : unit.title,
      question: '',
      audience: [],
      scopeIn: [],
      scopeOut: [],
      length: { min: 0, max: 0 },
      sections: [],
    };
    doc.question = this.crossRefs(`${path}.question`, h.question !== '' ? h.question : unit.question, unit.refs);
    if (!unit.hasBody && h.audience.length === 0) {
      this.fail('schema', path, `${unit.id} «${doc.title}» has no body: its reader, scope and outline were not written (the call for it did `
        + 'not answer) — write the whole document');
    }
    doc.audience = [...h.audience];
    (h.scopeIn.length > 0 ? h.scopeIn : unit.cardScope).forEach((item, k) => {
      doc.scopeIn.push(this.crossRefs(`${path}.scopeIn[${k}]`, item, unit.refs));
    });
    h.scopeOut.forEach((item, k) => {
      const out = { text: item, docs: [] as string[] };
      const m = WIKI_PLAN_SCOPE_OUT_REF.exec(item);
      if (m) {
        out.text = goTrimSpace(item.slice(0, item.length - m[0].length));
        const rename = this.renamer(unit.refs);
        for (const id of m[1].match(WIKI_PLAN_IDS) ?? []) {
          const now = rename(id);
          if (now === null) {
            this.fail('references', `${path}.scopeOut[${k}]`, `«${cutRunes(item, 80)}» leaves it to ${wikiQuote(id)}, which is no document of `
              + 'this plan: name the document it is left to by its number in the catalogue');
            continue;
          }
          for (const [slug, sid] of this.a.slugIds) if (sid === now) out.docs.push(slug);
        }
      }
      out.text = this.crossRefs(`${path}.scopeOut[${k}].text`, out.text, unit.refs);
      doc.scopeOut.push(out);
    });
    const length = wikiPlanRange(h.length);
    if (length.ok) doc.length = { min: length.min, max: length.max };
    else if (unit.hasBody || h.length !== '') this.fail('schema', `${path}.length`, `Length ${wikiQuote(h.length)} is not a length: write it as <a–b characters>`);
    for (const line of unit.stray) {
      this.fail('schema', path, `${wikiQuote(cutRunes(line, 80))} is not a field of the plan: a document has Title, Question, Audience, Includes, Excludes `
        + 'and Length, then its sections — drop it');
    }
    unit.sections.forEach((s, j) => doc.sections.push(this.section(`${path}.sections[${j}]`, s, unit.refs)));
    this.limits(path, doc);
    return doc;
  }

  /** One section of a document the model wrote, checked. */
  section(path: string, s: WikiPlanSectionDraft, refs: ReadonlyMap<string, string> | null): WikiPlanSection {
    const out: WikiPlanSection = {
      title: s.title,
      kind: wikiUnwrap(s.kind),
      covers: '',
      length: 0,
      sources: { docs: s.docs.map((d) => ({ ...d })), code: s.code.map((c) => ({ path: c.path, symbols: [...c.symbols] })), contracts: [], sessions: null },
    };
    if (!(WIKI_PLAN_SECTION_KINDS as readonly string[]).includes(out.kind)) {
      this.fail('schema', `${path}.kind`, `${wikiQuote(out.kind)} is not a section kind: one of ${WIKI_PLAN_SECTION_KINDS.join(', ')}`);
    }
    const length = wikiPlanRange(s.length);
    if (length.ok) out.length = length.min;
    else this.fail('schema', `${path}.length`, `the length ${wikiQuote(s.length)} is not a number of characters`);
    out.covers = this.crossRefs(`${path}.covers`, s.covers, refs);
    for (const c of s.contracts) out.sources.contracts.push({ path: c });
    const c = s.sessions;
    if (c) {
      out.sources.sessions = {
        projects: [...c.projects],
        since: c.since !== '' ? c.since : null,
        until: c.until !== '' ? c.until : null,
        keywords: [...c.keywords],
        anchorPaths: [...c.anchorPaths],
        entryKinds: c.entryKinds.map(wikiUnwrap),
        topics: c.topics.map(wikiUnwrap),
        evidence: c.evidence,
      };
      for (const part of c.stray) {
        this.fail('schema', `${path}.sources.sessions`, `${wikiQuote(cutRunes(part, 80))} is not a part of a session condition: it has projects, dates, `
          + 'keywords, anchors, kind, topics and look for — drop it');
      }
    }
    for (const line of s.stray) {
      this.fail('schema', path, `${wikiQuote(cutRunes(line, 80))} is not a line of a section: a section has Covers, Docs, Code, Contracts and Sessions lines and `
        + 'nothing else — drop it');
    }
    this.sources(path, out.sources, true);
    return out;
  }

  /** The server's schema check of one document's fields, run here first. */
  limits(path: string, doc: WikiPlanDoc): void {
    if (!SLUG.test(doc.slug) || Buffer.byteLength(doc.slug, 'utf8') > 64) {
      this.fail('schema', `${path}.slug`, `${wikiQuote(doc.slug)} is not a slug: lowercase letters and digits joined by single hyphens`);
    }
    this.text(`${path}.title`, doc.title, WIKI_PLAN_RULES.titleMaxChars, true);
    this.text(`${path}.question`, doc.question, WIKI_PLAN_RULES.questionMaxChars, true);
    this.texts(`${path}.audience`, doc.audience, 1);
    this.texts(`${path}.scopeIn`, doc.scopeIn, 1);
    doc.scopeOut.forEach((out, k) => this.text(`${path}.scopeOut[${k}].text`, out.text, WIKI_PLAN_RULES.textMaxChars, true));
    if (doc.scopeOut.length > WIKI_PLAN_RULES.listMaxItems) this.fail('schema', `${path}.scopeOut`, `has at most ${WIKI_PLAN_RULES.listMaxItems} items`);
    if (doc.length.min < 1 || doc.length.max > WIKI_PLAN_RULES.lengthMaxChars || doc.length.max < doc.length.min) {
      if (doc.length.min !== 0 || doc.length.max !== 0) {
        this.fail('schema', `${path}.length`, `the length is from 1 to ${WIKI_PLAN_RULES.lengthMaxChars} characters, its max not below its min`);
      }
    }
    if (doc.sections.length === 0) this.fail('schema', `${path}.sections`, "is required: the document's outline, one section at least");
    else if (doc.sections.length > WIKI_PLAN_RULES.sectionsMax) this.fail('schema', `${path}.sections`, `a document has at most ${WIKI_PLAN_RULES.sectionsMax} sections`);
    doc.sections.forEach((s, j) => {
      const sp = `${path}.sections[${j}]`;
      this.text(`${sp}.title`, s.title, WIKI_PLAN_RULES.titleMaxChars, true);
      this.text(`${sp}.covers`, s.covers, WIKI_PLAN_RULES.coversMaxChars, true);
      if (s.length < 1 || s.length > WIKI_PLAN_RULES.lengthMaxChars) this.fail('schema', `${sp}.length`, `must be from 1 to ${WIKI_PLAN_RULES.lengthMaxChars}`);
      const c = s.sources.sessions;
      if (c) {
        for (const date of [c.since, c.until]) {
          if (date !== null && !DATE_ONLY.test(date)) this.fail('schema', `${sp}.sources.sessions`, `${wikiQuote(date)} is not a date written YYYY-MM-DD`);
        }
        if (c.since !== null && c.until !== null && c.until < c.since) this.fail('schema', `${sp}.sources.sessions.until`, 'must not be before since');
      }
    });
  }

  text(path: string, value: string, max: number, required: boolean): void {
    if (required && goTrimSpace(value) === '') this.fail('schema', path, 'is required');
    if ([...goTrimSpace(value)].length > max) this.fail('schema', path, `is at most ${max} characters`);
  }

  texts(path: string, values: readonly string[], minItems: number): void {
    if (values.length < minItems) this.fail('schema', path, `is required: at least ${minItems}`);
    if (values.length > WIKI_PLAN_RULES.listMaxItems) this.fail('schema', path, `has at most ${WIKI_PLAN_RULES.listMaxItems} items`);
    values.forEach((v, k) => this.text(`${path}[${k}]`, v, WIKI_PLAN_RULES.textMaxChars, true));
  }

  /** A repository reference not found at the sha; `fail` makes it an error of the gate as well. */
  miss(kind: 'file' | 'docSection' | 'symbol' | 'contract', ref: string, at: string, fail: boolean, message: string): void {
    this.a.repo.missing.push({ kind, ref, at });
    if (fail) this.fail('references', at, message);
  }

  /** What one section names, checked: in the repository at the sha, and in Orbit. */
  sources(path: string, s: WikiPlanSources, fail: boolean): void {
    const r = this.r;
    const sha = shortWikiHash(r.repo.sha);
    s.docs.forEach((d, k) => {
      const p = `${path}.sources.docs[${k}]`;
      this.a.repo.checked += 1;
      if (!r.repo.hasPath(d.path)) {
        this.miss('file', d.path, `${p}.path`, fail, `${wikiQuote(d.path)} is no file of the repository at ${sha}: name a document of the documents' list`);
        return;
      }
      if (d.section !== null && goTrimSpace(d.section) !== '') {
        this.a.repo.checked += 1;
        if (!r.repo.hasDocSection(d.path, d.section)) {
          this.miss('docSection', `${d.path} § ${d.section}`, `${p}.section`, fail,
            `${d.path} has no section ${wikiQuote(d.section)} at ${sha}; its sections are: ${oneOf(r.repo.headingsOf(d.path, 30))}`);
        }
      }
    });
    s.code.forEach((c, k) => {
      const p = `${path}.sources.code[${k}]`;
      this.a.repo.checked += 1;
      if (!r.repo.hasPath(c.path)) {
        this.miss('file', c.path, `${p}.path`, fail, `${wikiQuote(c.path)} is no file or directory of the repository at ${sha}: name one the `
          + "repository's structure lists");
        return;
      }
      c.symbols.forEach((symbol, m) => {
        this.a.repo.checked += 1;
        if (!r.repo.hasSymbol(c.path, symbol)) {
          this.miss('symbol', `${c.path}: ${symbol}`, `${p}.symbols[${m}]`, fail,
            `${wikiQuote(symbol)} is no symbol of ${c.path} at ${sha}; it declares: ${oneOf(r.repo.symbolsOf(c.path, 40))}`);
        }
      });
    });
    s.contracts.forEach((c, k) => {
      this.a.repo.checked += 1;
      if (!r.repo.hasPath(c.path)) {
        this.miss('contract', c.path, `${path}.sources.contracts[${k}].path`, fail, `${wikiQuote(c.path)} is no file of the `
          + `repository at ${sha}: name one the contracts list has`);
      }
    });
    if (!s.sessions || !fail) return;
    const sp = `${path}.sources.sessions`;
    if (r.materials.projects.length < WIKI_PLAN_MATERIALS_PROJECTS_MAX) {
      const titles = new Map<string, number>();
      const ids = new Set<string>();
      for (const p of r.materials.projects) {
        titles.set(p.title, (titles.get(p.title) ?? 0) + 1);
        ids.add(p.id);
      }
      s.sessions.projects.forEach((project, m) => {
        const n = titles.get(project) ?? 0;
        if (ids.has(project)) return;
        if (n === 0) {
          this.fail('references', `${sp}.projects[${m}]`, `no project is titled ${wikiQuote(project)}: name a project exactly `
            + 'as the projects\' list writes it, or leave it out');
        } else if (n > 1) {
          this.fail('references', `${sp}.projects[${m}]`, `${n} projects are titled ${wikiQuote(project)}: leave it out`);
        }
      });
    }
    const topics = new Set(r.materials.topics.map((t) => t.slug));
    s.sessions.topics.forEach((topic, m) => {
      if (!topics.has(topic)) this.fail('references', `${sp}.topics[${m}]`, `${wikiQuote(topic)} is not a topic of this space: ${wikiPlanTopicsBrief(r.materials)}`);
    });
    s.sessions.entryKinds.forEach((kind, m) => {
      if (!(WIKI_KINDS as readonly string[]).includes(kind)) {
        this.fail('references', `${sp}.entryKinds[${m}]`, `${wikiQuote(kind)} is no kind of entry: one of ${WIKI_KINDS.join(', ')}`);
      }
    });
  }
}

function oneOf(options: readonly string[]): string {
  return options.length === 0 ? '(none)' : options.join('; ');
}
