import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import {
  RunEventType,
  toUuid,
  WIKI_ENTRY_KINDS,
  WIKI_PLAN_JOB_OUTCOMES,
  WIKI_PLAN_JOB_RULES,
  wikiMaintenanceSettings,
  WIKI_PLAN_FACT_KINDS,
  WIKI_PLAN_GATE_CHECKS,
  WIKI_PLAN_NEW_FIELD_LEVELS,
  WIKI_PLAN_PROPOSAL_ACTIONS,
  WIKI_PLAN_REPO_REF_KINDS,
  WIKI_PLAN_RULES,
  WIKI_PLAN_SCHEMA,
  WIKI_PLAN_SECTION_KINDS,
  WIKI_SLUG_PATTERN,
  type WikiEntryKind,
  type WikiPlanBuildProgress,
  type WikiPlanCategory,
  type WikiPlanDecisionResult,
  type WikiPlanDoc,
  type WikiPlanDocInput,
  type WikiPlanDraftAnswer,
  type WikiPlanFactKind,
  type WikiPlanGateCheck,
  type WikiPlanGateError,
  type WikiPlanGateReport,
  type WikiPlanJob,
  type WikiPlanJobCheck,
  type WikiPlanJobContext,
  type WikiPlanJobOutcome,
  type WikiPlanMaterials,
  type WikiPlanRedraftResult,
  type WikiPlanNewField,
  type WikiPlanNewFieldLevel,
  type WikiPlanOrigin,
  type WikiPlanProposal,
  type WikiPlanProposalStatus,
  type WikiPlanRepoCheck,
  type WikiPlanRepoRefKind,
  type WikiPlanSchemaLevel,
  type WikiPlanSectionKind,
  type WikiPlanState,
  type WikiPlanStatus,
  type WikiPlanVersion,
  type WikiPlanVersionSummary,
} from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { isWikiMaintenanceSession } from './wiki-maintenance-settings';
import {
  finishWikiPlanJob,
  progressWikiPlanBuild,
  progressWikiPlanJob,
  requestWikiPlanBuild,
  requestWikiPlanJob,
  startWikiPlanJob,
  wikiPlanJobById,
  wikiPlanJobCheck,
  wikiPlanJobOfSession,
  wikiPlanJobOfSpace,
  wikiPlanMaterials,
  type WikiPlanJobEnd,
  type WikiPlanJobRow,
} from './wiki-plan-job';
import { WikiRefusalError, type WikiPrincipal } from './wiki.service';

/**
 * The plan (criterion 11; contracts/wiki.contract.json `plan`, migration 0325): the documents a wiki
 * is written as, drafted by the local model, checked by the gate below, and confirmed by the owner
 * before anything is written from it.
 *
 * VERSIONS, AND WHAT NEVER CHANGES. A version's documents and sections are only ever inserted. An
 * edit, a redraft or an accepted proposal is a new version, written in one transaction under the
 * space row's lock; the one row an existing version ever has updated is its own `wiki_plan` row, when
 * it is confirmed or superseded. So the version the owner confirmed is, byte for byte, the version the
 * documents are written from (`requireConfirmedPlan`), until the owner confirms another.
 *
 * THE GATE (contract `plan.gate`). The model drafts and revises; the gate decides what of that may be
 * stored, and answers everything it found at once, each with where it is and which check found it, so
 * the drafting job can hand the list back to the model and ask again:
 *
 *   schema      every field is one the schema has (`WIKI_PLAN_SCHEMA`) — or one the draft declares in
 *               `newFields` as needing adding, whose values are kept apart as `extra` — of the right
 *               type, within its limits, and a section's kind one of the closed set;
 *   docCount    the draft has as many documents as its target: `rules.docsMin`–`rules.docsMax` unless
 *               the request names its own;
 *   protected   a document the version it revises protects is in the new one exactly as it was, and
 *               only the owner protects one;
 *   references  every project, topic and entry kind a section's session condition names exists, every
 *               document's category is one of the plan's, and every document a scope leaves something
 *               to is one of the plan's.
 *
 * A closed-set value — a section's kind, an entry kind, a topic, a declared field's level, a fact's kind —
 * is read with whatever backticks or quotes wrap the whole of it taken off (`unwrapped`), and an error
 * names a value the request gave as a JSON string (`quoted`), so what is wrong with it shows (contract
 * `plan.gate.values`).
 *
 * What it does NOT check is the repository: a file, a docs section or a symbol exists only in a
 * checkout, which the server has none of. The drafting job checks those on the runner, at a sha, and
 * the server keeps what it reported beside the version (`repoCheck`, `repoSha`) for the owner to read.
 *
 * WHO. A draft and a proposal come through the runner door, from a Wiki maintenance run of the space
 * (`isWikiMaintenanceSession`, the one test criterion 2 exported); everything else a person does —
 * read, edit, confirm, accept or reject — comes through the user door and is refused
 * WIKI_OWNER_CHANNEL_ONLY when it carries a session header. No MCP tool reaches either (hard constraint 2).
 *
 * NOT A SESSIONS OR PROJECTS DEPENDENCY: this reads the wiki's rows, the owner's project titles and one
 * session row, through Prisma, like the articles beside it.
 */

// ── The shape a plan is kept in ─────────────────────────────────────────────────────────────────

/** A section's session condition, projects by id once references are resolved. */
interface PlanSessions {
  projects: string[];
  since: string | null;
  until: string | null;
  keywords: string[];
  anchorPaths: string[];
  entryKinds: string[];
  topics: string[];
  evidence: string;
}

interface PlanSources {
  docs: Array<{ path: string; section: string | null }>;
  code: Array<{ path: string; symbols: string[] }>;
  contracts: Array<{ path: string }>;
  sessions: PlanSessions | null;
}

interface PlanSection {
  /** Null until `assignKeys` gives it one. */
  key: string | null;
  title: string;
  kind: WikiPlanSectionKind;
  covers: string;
  length: number;
  sources: PlanSources;
  extra: Record<string, unknown>;
}

interface PlanDoc {
  category: string;
  slug: string;
  title: string;
  question: string;
  audience: string[];
  scopeIn: string[];
  scopeOut: Array<{ text: string; docs: string[] }>;
  length: { min: number; max: number };
  protected: boolean;
  extra: Record<string, unknown>;
  sections: PlanSection[];
}

interface PlanCategory {
  key: string;
  title: string;
  question: string;
  forAgents: boolean;
  extra: Record<string, unknown>;
}

/** A plan as the gate reads it and a version stores it. */
interface PlanContent {
  categories: PlanCategory[];
  docs: PlanDoc[];
  newFields: WikiPlanNewField[];
}

/** Where each of a plan's project and topic names sits, so a resolution can answer at the right path. */
interface Named {
  path: string;
  value: string;
}

// ── The schema check ────────────────────────────────────────────────────────────────────────────

const SLUG = new RegExp(WIKI_SLUG_PATTERN, 'u');
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** Characters, as code points: what every limit counts. */
function chars(text: string): number {
  return Array.from(text).length;
}

/** What a message would not show: controls, format characters (a zero-width space, a BOM), separators, and every space but U+0020. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu;

/**
 * A value the request gave, as an error names it back (contract `plan.gate.values`): a JSON string, with
 * every character that would not show written as \uXXXX, so the backticks around a value, a space at
 * either end and an invisible character all show. 10-01: «`decision` is no kind of entry: one of
 * principle, convention, decision, …» read as decision refused for not being decision, three rounds
 * running. The runner's gate writes the same (wiki_verify.go `wikiQuote`).
 */
function quoted(value: string): string {
  return JSON.stringify(value).replace(UNSEEN, (c) =>
    c === ' ' ? c : Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''));
}

/** What a model wraps a whole value in: backticks, and quotes of every kind. */
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [['`', '`'], ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['«', '»']];

/**
 * A closed-set value as the gate reads it (contract `plan.gate.values`): the whitespace at either end
 * taken off, then whatever backticks or quotes wrap the whole of it — a pair at its two ends with no more
 * of either inside — as often as they do: `decision` reads decision. Only the wrapping goes: `a` and `b`
 * is no wrapped value, and a value that is not in the set is still refused. The runner's gate reads the
 * same (wiki_verify.go `wikiUnwrap`).
 */
function unwrapped(value: string): string {
  let text = value.trim();
  for (;;) {
    const pair = WRAPPERS.find(([open, close]) => {
      if (text.length < open.length + close.length || !text.startsWith(open) || !text.endsWith(close)) return false;
      const held = text.slice(open.length, text.length - close.length);
      return !held.includes(open) && !held.includes(close);
    });
    if (!pair) return text;
    text = text.slice(pair[0].length, text.length - pair[1].length).trim();
  }
}

/**
 * One walk of a request, collecting every error rather than stopping at the first: the drafting job
 * hands the whole list back to the model, and a model told one mistake at a time needs a round each.
 */
class Walk {
  readonly errors: WikiPlanGateError[] = [];
  /** Every project and topic a session condition names, to be resolved against the database. */
  readonly projects: Named[] = [];
  readonly topics: Named[] = [];

  constructor(
    /** The fields the plan declares as needing adding, by level: what `extra` may carry. */
    private readonly declared: ReadonlyMap<WikiPlanNewFieldLevel, ReadonlySet<string>>,
  ) {}

  fail(check: WikiPlanGateCheck, path: string, message: string): void {
    this.errors.push({ check, path, message });
  }

  /** An object whose keys are all the schema's for `level`; anything else is named, once each. */
  object(value: unknown, path: string, level: WikiPlanSchemaLevel): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.fail('schema', path, 'must be an object');
      return null;
    }
    const record = value as Record<string, unknown>;
    const known = new Set<string>(WIKI_PLAN_SCHEMA[level]);
    const holdsExtra = (WIKI_PLAN_NEW_FIELD_LEVELS as readonly string[]).includes(level);
    for (const key of Object.keys(record)) {
      if (known.has(key)) continue;
      const declared = holdsExtra && this.declared.get(level as WikiPlanNewFieldLevel)?.has(key);
      this.fail(
        'schema',
        `${path}.${key}`,
        declared
          ? `${quoted(key)} is declared in newFields as needing adding: put its value under ${path}.extra.${key}, not beside the schema's fields`
          : `${quoted(key)} is not a field of the plan schema (${WIKI_PLAN_SCHEMA[level].join(', ')}): remove it`
            + (holdsExtra ? `, or declare it in newFields at "${level}" and put its value under extra` : ''),
      );
    }
    return record;
  }

  /** The values a level's declared new fields carry: only declared names, and within the size limit. */
  extra(value: unknown, path: string, level: WikiPlanNewFieldLevel): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.fail('schema', path, 'must be an object of the fields newFields declares, by name');
      return {};
    }
    const out: Record<string, unknown> = {};
    const declared = this.declared.get(level) ?? new Set<string>();
    for (const [name, field] of Object.entries(value as Record<string, unknown>)) {
      if (!declared.has(name)) {
        this.fail('schema', `${path}.${name}`, `${quoted(name)} is not declared in newFields at "${level}": declare it as needing adding, or remove it`);
        continue;
      }
      out[name] = field;
    }
    if (JSON.stringify(out).length > WIKI_PLAN_RULES.extraMaxChars) {
      this.fail('schema', path, `the declared fields' values are at most ${WIKI_PLAN_RULES.extraMaxChars} characters of JSON`);
    }
    return out;
  }

  text(value: unknown, path: string, max: number, required: boolean): string {
    if (value === undefined || value === null) {
      if (required) this.fail('schema', path, 'is required');
      return '';
    }
    if (typeof value !== 'string') {
      this.fail('schema', path, 'must be a string');
      return '';
    }
    const text = value.trim();
    if (required && text === '') this.fail('schema', path, 'must not be empty');
    if (chars(text) > max) this.fail('schema', path, `is at most ${max} characters`);
    return text;
  }

  slug(value: unknown, path: string): string {
    const text = this.text(value, path, 64, true);
    if (text !== '' && !SLUG.test(text)) this.fail('schema', path, `must be a slug: lowercase letters and digits joined by single hyphens (${WIKI_SLUG_PATTERN})`);
    return text;
  }

  integer(value: unknown, path: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.fail('schema', path, 'must be a whole number');
      return min;
    }
    if (value < min || value > max) this.fail('schema', path, `must be from ${min} to ${max}`);
    return value;
  }

  boolean(value: unknown, path: string): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'boolean') {
      this.fail('schema', path, 'must be true or false');
      return false;
    }
    return value;
  }

  list(value: unknown, path: string, minItems = 0): unknown[] {
    if (value === undefined || value === null) {
      if (minItems > 0) this.fail('schema', path, `is required: at least ${minItems}`);
      return [];
    }
    if (!Array.isArray(value)) {
      this.fail('schema', path, 'must be a list');
      return [];
    }
    if (value.length < minItems) this.fail('schema', path, `must have at least ${minItems}`);
    if (value.length > WIKI_PLAN_RULES.listMaxItems) this.fail('schema', path, `has at most ${WIKI_PLAN_RULES.listMaxItems} items`);
    return value.slice(0, WIKI_PLAN_RULES.listMaxItems);
  }

  texts(value: unknown, path: string, minItems = 0): string[] {
    return this.list(value, path, minItems).map((item, i) => this.text(item, `${path}[${i}]`, WIKI_PLAN_RULES.textMaxChars, true));
  }

  /** A required value of a closed set — a kind, a topic, a level — read unwrapped: what wraps the whole of it is no part of it. */
  closed(value: unknown, path: string, max: number): string {
    const refused = this.errors.length;
    const text = unwrapped(this.text(value, path, max, true));
    if (text === '' && this.errors.length === refused) this.fail('schema', path, 'must not be empty');
    return text;
  }

  closedList(value: unknown, path: string): string[] {
    return this.list(value, path).map((item, i) => this.closed(item, `${path}[${i}]`, WIKI_PLAN_RULES.textMaxChars));
  }

  date(value: unknown, path: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      this.fail('schema', path, 'must be a date written YYYY-MM-DD, or null');
      return null;
    }
    return value;
  }

  // ── The levels ──────────────────────────────────────────────────────────────────────────────

  category(value: unknown, path: string): PlanCategory | null {
    const raw = this.object(value, path, 'category');
    if (!raw) return null;
    return {
      key: this.slug(raw.key, `${path}.key`),
      title: this.text(raw.title, `${path}.title`, WIKI_PLAN_RULES.titleMaxChars, true),
      question: this.text(raw.question, `${path}.question`, WIKI_PLAN_RULES.questionMaxChars, false),
      forAgents: this.boolean(raw.forAgents, `${path}.forAgents`),
      extra: this.extra(raw.extra, `${path}.extra`, 'category'),
    };
  }

  doc(value: unknown, path: string): PlanDoc | null {
    const raw = this.object(value, path, 'doc');
    if (!raw) return null;
    const length = this.object(raw.length, `${path}.length`, 'length');
    const min = length ? this.integer(length.min, `${path}.length.min`, 1, WIKI_PLAN_RULES.lengthMaxChars) : 1;
    const max = length ? this.integer(length.max, `${path}.length.max`, 1, WIKI_PLAN_RULES.lengthMaxChars) : 1;
    if (length && max < min) this.fail('schema', `${path}.length`, 'max must not be below min');
    const sections = Array.isArray(raw.sections) ? raw.sections.slice(0, WIKI_PLAN_RULES.sectionsMax) : [];
    if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
      this.fail('schema', `${path}.sections`, 'is required: the document\'s outline, one section at least');
    } else if (raw.sections.length > WIKI_PLAN_RULES.sectionsMax) {
      this.fail('schema', `${path}.sections`, `a document has at most ${WIKI_PLAN_RULES.sectionsMax} sections`);
    }
    const doc: PlanDoc = {
      category: this.slug(raw.category, `${path}.category`),
      slug: this.slug(raw.slug, `${path}.slug`),
      title: this.text(raw.title, `${path}.title`, WIKI_PLAN_RULES.titleMaxChars, true),
      question: this.text(raw.question, `${path}.question`, WIKI_PLAN_RULES.questionMaxChars, true),
      audience: this.texts(raw.audience, `${path}.audience`, 1),
      scopeIn: this.texts(raw.scopeIn, `${path}.scopeIn`, 1),
      scopeOut: this.list(raw.scopeOut, `${path}.scopeOut`).flatMap((item, i) => {
        const at = `${path}.scopeOut[${i}]`;
        const out = this.object(item, at, 'scopeOut');
        if (!out) return [];
        return [{ text: this.text(out.text, `${at}.text`, WIKI_PLAN_RULES.textMaxChars, true), docs: this.list(out.docs, `${at}.docs`).map((slug, j) => this.slug(slug, `${at}.docs[${j}]`)) }];
      }),
      length: { min, max },
      protected: this.boolean(raw.protected, `${path}.protected`),
      extra: this.extra(raw.extra, `${path}.extra`, 'doc'),
      sections: sections.flatMap((item, i) => {
        const section = this.section(item, `${path}.sections[${i}]`);
        return section ? [section] : [];
      }),
    };
    const keys = new Set<string>();
    doc.sections.forEach((section, i) => {
      if (section.key === null) return;
      if (keys.has(section.key)) this.fail('schema', `${path}.sections[${i}].key`, `${quoted(section.key)} is the key of an earlier section of this document`);
      keys.add(section.key);
    });
    return doc;
  }

  section(value: unknown, path: string): PlanSection | null {
    const raw = this.object(value, path, 'section');
    if (!raw) return null;
    const kind = this.closed(raw.kind, `${path}.kind`, 64);
    if (kind !== '' && !(WIKI_PLAN_SECTION_KINDS as readonly string[]).includes(kind)) {
      this.fail('schema', `${path}.kind`, `${quoted(kind)} is not a section kind: one of ${WIKI_PLAN_SECTION_KINDS.join(', ')}`);
    }
    return {
      key: raw.key === undefined || raw.key === null ? null : this.slug(raw.key, `${path}.key`),
      title: this.text(raw.title, `${path}.title`, WIKI_PLAN_RULES.titleMaxChars, true),
      kind: kind as WikiPlanSectionKind,
      covers: this.text(raw.covers, `${path}.covers`, WIKI_PLAN_RULES.coversMaxChars, true),
      length: this.integer(raw.length, `${path}.length`, 1, WIKI_PLAN_RULES.lengthMaxChars),
      sources: this.sources(raw.sources, `${path}.sources`),
      extra: this.extra(raw.extra, `${path}.extra`, 'section'),
    };
  }

  sources(value: unknown, path: string): PlanSources {
    const raw = this.object(value, path, 'sources');
    const empty: PlanSources = { docs: [], code: [], contracts: [], sessions: null };
    if (!raw) return empty;
    const max = WIKI_PLAN_RULES.textMaxChars;
    return {
      docs: this.list(raw.docs, `${path}.docs`).flatMap((item, i) => {
        const at = `${path}.docs[${i}]`;
        const doc = this.object(item, at, 'docSource');
        if (!doc) return [];
        const section = doc.section === undefined || doc.section === null ? null : this.text(doc.section, `${at}.section`, max, true);
        return [{ path: this.text(doc.path, `${at}.path`, max, true), section }];
      }),
      code: this.list(raw.code, `${path}.code`).flatMap((item, i) => {
        const at = `${path}.code[${i}]`;
        const code = this.object(item, at, 'codeSource');
        if (!code) return [];
        return [{ path: this.text(code.path, `${at}.path`, max, true), symbols: this.texts(code.symbols, `${at}.symbols`) }];
      }),
      contracts: this.list(raw.contracts, `${path}.contracts`).flatMap((item, i) => {
        const at = `${path}.contracts[${i}]`;
        const contract = this.object(item, at, 'contractSource');
        return contract ? [{ path: this.text(contract.path, `${at}.path`, max, true) }] : [];
      }),
      sessions: raw.sessions === undefined || raw.sessions === null ? null : this.sessions(raw.sessions, `${path}.sessions`),
    };
  }

  sessions(value: unknown, path: string): PlanSessions | null {
    const raw = this.object(value, path, 'sessions');
    if (!raw) return null;
    const since = this.date(raw.since, `${path}.since`);
    const until = this.date(raw.until, `${path}.until`);
    if (since !== null && until !== null && since > until) this.fail('schema', `${path}.until`, 'must not be before since');
    const projects = this.texts(raw.projects, `${path}.projects`);
    projects.forEach((project, i) => project !== '' && this.projects.push({ path: `${path}.projects[${i}]`, value: project }));
    const topics = this.closedList(raw.topics, `${path}.topics`);
    topics.forEach((topic, i) => topic !== '' && this.topics.push({ path: `${path}.topics[${i}]`, value: topic }));
    const entryKinds = this.closedList(raw.entryKinds, `${path}.entryKinds`);
    entryKinds.forEach((kind, i) => {
      if (kind !== '' && !(WIKI_ENTRY_KINDS as readonly string[]).includes(kind)) {
        this.fail('references', `${path}.entryKinds[${i}]`, `${quoted(kind)} is no kind of entry: one of ${WIKI_ENTRY_KINDS.join(', ')}`);
      }
    });
    return {
      projects,
      since,
      until,
      keywords: this.texts(raw.keywords, `${path}.keywords`),
      anchorPaths: this.texts(raw.anchorPaths, `${path}.anchorPaths`),
      entryKinds,
      topics,
      evidence: this.text(raw.evidence, `${path}.evidence`, WIKI_PLAN_RULES.textMaxChars, false),
    };
  }

  newFields(value: unknown, path: string): WikiPlanNewField[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      this.fail('schema', path, 'must be a list');
      return [];
    }
    if (value.length > WIKI_PLAN_RULES.newFieldsMax) this.fail('schema', path, `has at most ${WIKI_PLAN_RULES.newFieldsMax} items`);
    return value.slice(0, WIKI_PLAN_RULES.newFieldsMax).flatMap((item, i) => {
      const at = `${path}[${i}]`;
      const raw = this.object(item, at, 'newField');
      if (!raw) return [];
      const level = this.closed(raw.at, `${at}.at`, 32);
      if (level !== '' && !(WIKI_PLAN_NEW_FIELD_LEVELS as readonly string[]).includes(level)) {
        this.fail('schema', `${at}.at`, `a field may be declared at ${WIKI_PLAN_NEW_FIELD_LEVELS.join(', ')}`);
      }
      const name = this.text(raw.name, `${at}.name`, 64, true);
      if (name !== '' && !/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) this.fail('schema', `${at}.name`, 'must be a camelCase name');
      if ((WIKI_PLAN_SCHEMA[level as WikiPlanSchemaLevel] as readonly string[] | undefined)?.includes(name)) {
        this.fail('schema', `${at}.name`, `${quoted(name)} is a field the schema already has at "${level}"`);
      }
      return [{ at: level as WikiPlanNewFieldLevel, name, why: this.text(raw.why, `${at}.why`, WIKI_PLAN_RULES.textMaxChars, true) }];
    });
  }
}

/** Which names each level's `extra` may carry. */
function declaredOf(newFields: readonly WikiPlanNewField[]): Map<WikiPlanNewFieldLevel, Set<string>> {
  const out = new Map<WikiPlanNewFieldLevel, Set<string>>();
  for (const field of newFields) {
    if (!out.has(field.at)) out.set(field.at, new Set());
    out.get(field.at)!.add(field.name);
  }
  return out;
}

/** The checks on a whole plan that no single document can make: unique keys and slugs, and the plan's own references. */
function checkWhole(walk: Walk, plan: PlanContent, prefix: string): void {
  const categories = new Set<string>();
  plan.categories.forEach((category, i) => {
    if (categories.has(category.key)) walk.fail('schema', `${prefix}categories[${i}].key`, `${quoted(category.key)} is the key of an earlier category`);
    categories.add(category.key);
  });
  const slugs = new Set<string>();
  plan.docs.forEach((doc, i) => {
    if (slugs.has(doc.slug)) walk.fail('schema', `${prefix}docs[${i}].slug`, `${quoted(doc.slug)} is the slug of an earlier document`);
    slugs.add(doc.slug);
  });
  plan.docs.forEach((doc, i) => {
    if (doc.category !== '' && !categories.has(doc.category)) {
      walk.fail('references', `${prefix}docs[${i}].category`, `${quoted(doc.category)} is not one of the plan's categories (${[...categories].join(', ')})`);
    }
    doc.scopeOut.forEach((out, j) => out.docs.forEach((slug, k) => {
      if (slug !== '' && !slugs.has(slug)) {
        walk.fail('references', `${prefix}docs[${i}].scopeOut[${j}].docs[${k}]`, `${quoted(slug)} is no document of this plan: name the document it is left to by its slug`);
      }
    }));
  });
}

/** A draft's plan, walked: its content and everything wrong with its shape. Paths start at `prefix`. */
function walkDraft(value: unknown, prefix = 'plan.'): { plan: PlanContent; walk: Walk } {
  const pre = new Walk(new Map());
  const raw = pre.object(value, prefix.replace(/\.$/u, ''), 'draft');
  const newFields = raw ? pre.newFields(raw.newFields, `${prefix}newFields`) : [];
  const walk = new Walk(declaredOf(newFields));
  walk.errors.push(...pre.errors);
  const categories = raw ? walk.list(raw.categories, `${prefix}categories`, 1) : [];
  if (raw && Array.isArray(raw.categories) && raw.categories.length > WIKI_PLAN_RULES.categoriesMax) {
    walk.fail('schema', `${prefix}categories`, `a plan has at most ${WIKI_PLAN_RULES.categoriesMax} categories`);
  }
  // Documents are counted by the docCount check, not cut by the list limit.
  const docs = raw && Array.isArray(raw.docs) ? raw.docs.slice(0, WIKI_PLAN_RULES.docsCeiling + 1) : [];
  if (raw && !Array.isArray(raw.docs)) walk.fail('schema', `${prefix}docs`, 'must be a list');
  const plan: PlanContent = {
    categories: categories.flatMap((item, i) => {
      const category = walk.category(item, `${prefix}categories[${i}]`);
      return category ? [category] : [];
    }),
    docs: docs.flatMap((item, i) => {
      const doc = walk.doc(item, `${prefix}docs[${i}]`);
      return doc ? [doc] : [];
    }),
    newFields,
  };
  checkWhole(walk, plan, prefix);
  return { plan, walk };
}

// ── The other three checks ──────────────────────────────────────────────────────────────────────

/**
 * A document as a comparison reads it: everything it says, but not the keys its sections were given.
 * Objects are read with their keys sorted, at every depth: a stored version comes back out of JSONB,
 * which keeps an object's keys in its own order (shortest first), not in the order they were written.
 */
function docFingerprint(doc: PlanDoc): string {
  return JSON.stringify(canonical([
    doc.category, doc.slug, doc.title, doc.question, doc.audience, doc.scopeIn, doc.scopeOut, doc.length, doc.protected, doc.extra,
    doc.sections.map((s) => [s.title, s.kind, s.covers, s.length, s.sources, s.extra]),
  ]));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

/** The document count a plan is held to: its target, and whether it is inside it. */
function checkDocCount(walk: Walk, plan: PlanContent, target: { min: number; max: number }, path: string): void {
  const count = plan.docs.length;
  if (count < target.min || count > target.max) {
    walk.fail(
      'docCount',
      path,
      `the plan has ${count} documents; it must have ${target.min} to ${target.max}: `
        + (count < target.min ? 'split the broadest documents, or add the ones the categories are missing' : 'merge documents that answer the same reader\'s question'),
    );
  }
}

/**
 * A version that revises another carries every document that version protected exactly as it was —
 * the same slug, category, fields and sections in the same order — and does not protect one itself:
 * protecting a document is the owner's (contract `plan.gate.protected`).
 */
function checkProtected(walk: Walk, plan: PlanContent, base: PlanContent | null, prefix: string): void {
  const before = new Map((base?.docs ?? []).map((doc) => [doc.slug, doc]));
  const index = new Map(plan.docs.map((doc, i) => [doc.slug, i]));
  for (const kept of base?.docs ?? []) {
    if (!kept.protected) continue;
    const i = index.get(kept.slug);
    if (i === undefined) {
      walk.fail('protected', `${prefix}docs`, `${kept.slug} is protected: it stays in every new version exactly as it is, and this one leaves it out`);
    } else if (docFingerprint(plan.docs[i]) !== docFingerprint(kept)) {
      walk.fail('protected', `${prefix}docs[${i}]`, `${kept.slug} is protected: it stays exactly as it is — its fields, its sections and their order — and this version changes it`);
    }
  }
  plan.docs.forEach((doc, i) => {
    if (doc.protected && !before.get(doc.slug)?.protected) {
      walk.fail('protected', `${prefix}docs[${i}].protected`, 'only the owner protects a document: leave protected out');
    }
  });
}

/** Keys for the sections that have none: a protected document's are its own, then the key its title had before, then the next `s<n>`. */
function assignKeys(plan: PlanContent, base: PlanContent | null): void {
  const before = new Map((base?.docs ?? []).map((doc) => [doc.slug, doc]));
  for (const doc of plan.docs) {
    const earlier = before.get(doc.slug);
    if (earlier?.protected && docFingerprint(earlier) === docFingerprint(doc)) {
      doc.sections.forEach((section, i) => (section.key = earlier.sections[i].key));
      continue;
    }
    const used = new Set(doc.sections.map((section) => section.key).filter((key): key is string => key !== null));
    const byTitle = new Map((earlier?.sections ?? []).map((section) => [section.title, section.key]));
    let next = 1;
    for (const section of doc.sections) {
      if (section.key !== null) continue;
      const kept = byTitle.get(section.title);
      if (kept && !used.has(kept)) {
        section.key = kept;
      } else {
        while (used.has(`s${next}`)) next += 1;
        section.key = `s${next}`;
      }
      used.add(section.key);
    }
  }
}

/** The refusal that carries everything the gate found, the first `rules.errorsMax` of it listed. */
function gateRefusal(errors: readonly WikiPlanGateError[], what: string): WikiRefusalError {
  const listed = errors.slice(0, WIKI_PLAN_RULES.errorsMax);
  const checks = [...new Set(errors.map((error) => error.check))];
  return new WikiRefusalError({
    code: 'WIKI_PLAN_GATE',
    message:
      `${what} did not pass the plan's gate (${checks.join(', ')}): ${errors.length} error${errors.length === 1 ? '' : 's'}`
        + (errors.length > listed.length ? `, the first ${listed.length} listed` : '')
        + '. Nothing was stored; fix every one and send it again.',
    errors: listed,
  });
}

function stale(message: string): WikiRefusalError {
  return new WikiRefusalError({ code: 'WIKI_PLAN_STALE', message });
}

function ownerChannel(actingSessionId: string | null, what: string): void {
  if (!actingSessionId) return;
  throw new WikiRefusalError({
    code: 'WIKI_OWNER_CHANNEL_ONLY',
    message:
      `${what} is the account owner's, through an owner channel with no acting session: `
        + 'report what should change in the plan, and let a person change it.',
  });
}

function report(plan: PlanContent, target: { min: number; max: number }, protectedCheck: boolean): WikiPlanGateReport {
  const checks = Object.fromEntries(WIKI_PLAN_GATE_CHECKS.map((check) => [check, 'passed'])) as WikiPlanGateReport['checks'];
  if (!protectedCheck) checks.protected = 'skipped';
  const holders = (at: WikiPlanNewFieldLevel): Array<Record<string, unknown>> =>
    at === 'category' ? plan.categories.map((c) => c.extra) : at === 'doc' ? plan.docs.map((d) => d.extra) : plan.docs.flatMap((d) => d.sections.map((s) => s.extra));
  return {
    checkedAt: new Date().toISOString(),
    checks,
    docs: plan.docs.length,
    target,
    needsNewFields: plan.newFields.map((field) => ({ ...field, values: holders(field.at).filter((extra) => field.name in extra).length })),
  };
}

// ── What is read back ───────────────────────────────────────────────────────────────────────────

const VERSION_SELECT = {
  id: true,
  spaceId: true,
  version: true,
  status: true,
  origin: true,
  baseVersion: true,
  proposalId: true,
  categories: true,
  newFields: true,
  docsMin: true,
  docsMax: true,
  gate: true,
  repoSha: true,
  repoCheck: true,
  model: true,
  authorSessionId: true,
  authorUserId: true,
  confirmedByUserId: true,
  confirmedAt: true,
  supersededAt: true,
  createdAt: true,
  docs: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      position: true,
      category: true,
      slug: true,
      title: true,
      question: true,
      audience: true,
      scopeIn: true,
      scopeOut: true,
      lengthMin: true,
      lengthMax: true,
      protected: true,
      extra: true,
      sections: {
        orderBy: { position: 'asc' },
        select: { id: true, position: true, key: true, title: true, kind: true, covers: true, length: true, sources: true, extra: true },
      },
    },
  },
} satisfies Prisma.WikiPlanSelect;

type VersionRow = Prisma.WikiPlanGetPayload<{ select: typeof VERSION_SELECT }>;

const PROPOSAL_SELECT = {
  id: true,
  spaceId: true,
  status: true,
  baseVersion: true,
  reason: true,
  change: true,
  facts: true,
  gate: true,
  authorSessionId: true,
  decidedByUserId: true,
  decidedAt: true,
  decisionNote: true,
  resultVersion: true,
  createdAt: true,
} satisfies Prisma.WikiPlanProposalSelect;

type ProposalRow = Prisma.WikiPlanProposalGetPayload<{ select: typeof PROPOSAL_SELECT }>;

/** A stored version as the gate reads it. */
function contentOf(row: VersionRow): PlanContent {
  return {
    categories: row.categories as unknown as PlanCategory[],
    newFields: row.newFields as unknown as WikiPlanNewField[],
    docs: row.docs.map((doc) => ({
      category: doc.category,
      slug: doc.slug,
      title: doc.title,
      question: doc.question,
      audience: doc.audience,
      scopeIn: doc.scopeIn,
      scopeOut: doc.scopeOut as unknown as PlanDoc['scopeOut'],
      length: { min: doc.lengthMin, max: doc.lengthMax },
      protected: doc.protected,
      extra: doc.extra as Record<string, unknown>,
      sections: doc.sections.map((section) => ({
        key: section.key,
        title: section.title,
        kind: section.kind as WikiPlanSectionKind,
        covers: section.covers,
        length: section.length,
        sources: section.sources as unknown as PlanSources,
        extra: section.extra as Record<string, unknown>,
      })),
    })),
  };
}

/** A proposal's document in the shape a draft writes one, projects by id. */
function docInputOf(doc: PlanDoc): WikiPlanDocInput {
  return {
    category: doc.category,
    slug: doc.slug,
    title: doc.title,
    question: doc.question,
    audience: doc.audience,
    scopeIn: doc.scopeIn,
    scopeOut: doc.scopeOut,
    length: doc.length,
    protected: doc.protected,
    ...(Object.keys(doc.extra).length > 0 ? { extra: doc.extra } : {}),
    sections: doc.sections.map((section) => ({
      ...(section.key !== null ? { key: section.key } : {}),
      title: section.title,
      kind: section.kind,
      covers: section.covers,
      length: section.length,
      sources: section.sources,
      ...(Object.keys(section.extra).length > 0 ? { extra: section.extra } : {}),
    })),
  } as WikiPlanDocInput;
}

// ── The guard ───────────────────────────────────────────────────────────────────────────────────

/** Anything that reads a plan: the Prisma service, or a transaction a writer holds. */
type PlanReader = Pick<Prisma.TransactionClient, 'wikiPlan'>;

/**
 * The version of the space's plan the owner confirmed, or WIKI_PLAN_UNCONFIRMED (contract
 * `plan.guard`): what every writer of the space's documents asks before it writes one, so no document
 * is written from a plan nobody confirmed. It reads one row by the partial unique index the migration
 * made; pass the transaction a writer holds to read it there.
 */
export async function requireConfirmedPlan(
  db: PlanReader,
  space: { ownerId: string; spaceId: string },
): Promise<{ id: string; version: number; confirmedAt: Date }> {
  const confirmed = await db.wikiPlan.findFirst({
    where: { ownerId: space.ownerId, spaceId: space.spaceId, status: 'confirmed' },
    select: { id: true, version: true, confirmedAt: true },
  });
  if (!confirmed?.confirmedAt) {
    throw new WikiRefusalError({
      code: 'WIKI_PLAN_UNCONFIRMED',
      message:
        'this space has no plan its owner confirmed, so no document is written from one: draft a plan '
          + '(orbit wiki plan draft), and let the owner confirm it in the Wiki.',
    });
  }
  return { id: confirmed.id, version: confirmed.version, confirmedAt: confirmed.confirmedAt };
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

/** A version about to be written: everything but the number, which is taken under the lock. */
interface NewVersion {
  origin: WikiPlanOrigin;
  baseVersion: number | null;
  proposalId: string | null;
  plan: PlanContent;
  target: { min: number; max: number };
  gate: WikiPlanGateReport;
  repoCheck: WikiPlanRepoCheck | null;
  model: string | null;
  authorSessionId: string | null;
  authorUserId: string | null;
  /** A drafting job's draft under an idempotency key; nothing else has one. */
  idempotency?: DraftIdempotency;
}

/**
 * A draft's idempotency key, and the digest of the request it came with (contract `plan.idempotency`):
 * what tells the same draft landing again — sent again after its first answer was lost on the way
 * back — from a key reused for another. The digest is of the request's JSON with its keys sorted, so
 * the same draft digests the same however it was spelled, and it names the space: the key is the
 * owner's, as a changeset's is.
 */
interface DraftIdempotency {
  key: string;
  requestSha256: string;
}

/** The longest idempotency key a draft carries, as a changeset's. */
const IDEMPOTENCY_KEY_MAX_CHARS = 200;

/** A draft's key: null when it carries none, or one the schema refuses — the refusal is in the walk. */
function keyOf(walk: Walk, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const refused = walk.errors.length;
  const key = walk.text(value, 'idempotencyKey', IDEMPOTENCY_KEY_MAX_CHARS, true);
  return walk.errors.length === refused ? key : null;
}

function draftIdempotency(spaceId: string, key: string, raw: Record<string, unknown>): DraftIdempotency {
  const request = {
    spaceId,
    baseVersion: raw.baseVersion ?? null,
    target: raw.target ?? null,
    plan: raw.plan ?? null,
    repoCheck: raw.repoCheck ?? null,
    model: raw.model ?? null,
  };
  return { key, requestSha256: createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex') };
}

/**
 * The version the same draft stored under this key, or null when the key stored none: a replay is
 * answered with it and writes nothing. The key with another request is WIKI_IDEMPOTENCY_KEY_REUSED.
 */
async function storedUnder(db: PlanReader, ownerId: string, idempotency: DraftIdempotency): Promise<number | null> {
  const earlier = await db.wikiPlan.findFirst({
    where: { ownerId, idempotencyKey: idempotency.key },
    select: { version: true, requestSha256: true },
  });
  if (!earlier) return null;
  if (earlier.requestSha256 !== idempotency.requestSha256) {
    throw new WikiRefusalError({
      code: 'WIKI_IDEMPOTENCY_KEY_REUSED',
      message:
        'this idempotency key was used for a different draft: the same draft under the same key replays the version it '
          + 'stored, and another draft needs another key',
    });
  }
  return earlier.version;
}

@Injectable()
export class WikiPlans {
  private readonly logger = new Logger(WikiPlans.name);

  constructor(
    private readonly prisma: PrismaService,
    // `wiki.changed` after a version or a proposal is written (contract `realtime.publishedWhen`): an
    // accelerant, defaulted so a spec that builds this by hand need not stub it. `RealtimeModule` is global.
    private readonly realtime: RealtimeService = undefined as unknown as RealtimeService,
  ) {}

  // ── Who asks ──────────────────────────────────────────────────────────────────────────────────

  /** Another owner's space is the plain 404 every tenancy check answers (contract `refusalRules.notFound`). */
  private async requireSpace(ownerId: string, spaceId: string): Promise<void> {
    const space = await this.prisma.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { id: true } });
    if (!space) throw new NotFoundException('no such wiki space');
  }

  /** The runner door's callers: a maintenance run of this space, and nobody else. The space is found first. */
  async assertMaintainer(principal: WikiPrincipal, spaceId: string): Promise<void> {
    await this.requireSpace(principal.ownerId, spaceId);
    if (
      principal.origin === 'maintenance'
      && principal.sessionId !== null
      && (await isWikiMaintenanceSession(this.prisma, { ownerId: principal.ownerId, sessionId: principal.sessionId, spaceId }))
    ) {
      return;
    }
    throw new WikiRefusalError({
      code: 'WIKI_NOT_MAINTENANCE_SESSION',
      message:
        "only a Wiki maintenance run of this space drafts its plan or proposes a change to it — a session whose task is in the space's hidden "
          + '«Wiki maintenance» list. This caller is not one.',
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────────

  /** The version in force, the draft waiting for the owner, and the proposals waiting for them. */
  async state(ownerId: string, spaceId: string, actingSessionId: string | null = null): Promise<WikiPlanState> {
    ownerChannel(actingSessionId, 'the plan');
    await this.requireSpace(ownerId, spaceId);
    return this.stateOf(ownerId, spaceId);
  }

  /** The same read for a maintenance run of the space, which drafts from it and places knowledge in it. */
  async stateForMaintainer(principal: WikiPrincipal, spaceId: string): Promise<WikiPlanState> {
    await this.assertMaintainer(principal, spaceId);
    return this.stateOf(principal.ownerId, spaceId);
  }

  private async stateOf(ownerId: string, spaceId: string): Promise<WikiPlanState> {
    const [rows, proposals] = await Promise.all([
      this.prisma.wikiPlan.findMany({
        where: { ownerId, spaceId, status: { in: ['draft', 'confirmed'] } },
        select: VERSION_SELECT,
      }),
      this.prisma.wikiPlanProposal.findMany({
        where: { ownerId, spaceId, status: 'pending' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: PROPOSAL_SELECT,
      }),
    ]);
    const views = await this.views(ownerId, rows);
    return {
      spaceId,
      confirmed: views.find((view) => view.status === 'confirmed') ?? null,
      draft: views.find((view) => view.status === 'draft') ?? null,
      proposals: proposals.map(proposalView),
      job: await wikiPlanJobOfSpace(this.prisma, ownerId, spaceId),
    };
  }

  /** Every version, newest first. */
  async versions(ownerId: string, spaceId: string, actingSessionId: string | null = null): Promise<{ spaceId: string; versions: WikiPlanVersionSummary[] }> {
    ownerChannel(actingSessionId, 'the plan');
    await this.requireSpace(ownerId, spaceId);
    const rows = await this.prisma.wikiPlan.findMany({
      where: { ownerId, spaceId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        status: true,
        origin: true,
        baseVersion: true,
        proposalId: true,
        createdAt: true,
        confirmedAt: true,
        supersededAt: true,
        _count: { select: { docs: true } },
      },
    });
    return {
      spaceId,
      versions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        status: row.status as WikiPlanStatus,
        origin: row.origin as WikiPlanOrigin,
        baseVersion: row.baseVersion,
        proposalId: row.proposalId,
        docCount: row._count.docs,
        createdAt: row.createdAt.toISOString(),
        confirmedAt: row.confirmedAt?.toISOString() ?? null,
        supersededAt: row.supersededAt?.toISOString() ?? null,
      })),
    };
  }

  /** One version, whole, whatever its status. */
  async version(ownerId: string, spaceId: string, version: number, actingSessionId: string | null = null): Promise<WikiPlanVersion> {
    ownerChannel(actingSessionId, 'the plan');
    await this.requireSpace(ownerId, spaceId);
    const row = await this.prisma.wikiPlan.findFirst({ where: { ownerId, spaceId, version }, select: VERSION_SELECT });
    if (!row) throw new NotFoundException('no such version of this plan');
    return (await this.views(ownerId, [row]))[0];
  }

  /** Versions as the doors answer them: every session condition's projects named as they stand now. */
  private async views(ownerId: string, rows: readonly VersionRow[]): Promise<WikiPlanVersion[]> {
    const ids = new Set<string>();
    for (const row of rows) {
      for (const doc of row.docs) {
        for (const section of doc.sections) (section.sources as unknown as PlanSources).sessions?.projects.forEach((id) => ids.add(id));
      }
    }
    const titles = ids.size === 0
      ? new Map<string, string>()
      : new Map(
        (await this.prisma.project.findMany({ where: { ownerId, id: { in: [...ids] } }, select: { id: true, title: true } }))
          .map((project) => [project.id, project.title]),
      );
    return rows.map((row) => ({
      id: row.id,
      spaceId: row.spaceId,
      version: row.version,
      status: row.status as WikiPlanStatus,
      origin: row.origin as WikiPlanOrigin,
      baseVersion: row.baseVersion,
      proposalId: row.proposalId,
      categories: (row.categories as unknown as PlanCategory[]).map((c): WikiPlanCategory => ({ ...c, extra: c.extra ?? {} })),
      newFields: row.newFields as unknown as WikiPlanNewField[],
      target: { min: row.docsMin, max: row.docsMax },
      gate: row.gate as unknown as WikiPlanGateReport,
      repoCheck: row.repoCheck === null ? null : (row.repoCheck as unknown as WikiPlanRepoCheck),
      model: row.model,
      authorSessionId: row.authorSessionId,
      authorUserId: row.authorUserId,
      confirmedByUserId: row.confirmedByUserId,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      supersededAt: row.supersededAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      docs: row.docs.map((doc): WikiPlanDoc => ({
        id: doc.id,
        position: doc.position,
        category: doc.category,
        slug: doc.slug,
        title: doc.title,
        question: doc.question,
        audience: doc.audience,
        scopeIn: doc.scopeIn,
        scopeOut: doc.scopeOut as unknown as WikiPlanDoc['scopeOut'],
        length: { min: doc.lengthMin, max: doc.lengthMax },
        protected: doc.protected,
        extra: doc.extra as Record<string, unknown>,
        sections: doc.sections.map((section) => {
          const sources = section.sources as unknown as PlanSources;
          return {
            id: section.id,
            key: section.key,
            position: section.position,
            title: section.title,
            kind: section.kind as WikiPlanSectionKind,
            covers: section.covers,
            length: section.length,
            extra: section.extra as Record<string, unknown>,
            sources: {
              docs: sources.docs,
              code: sources.code,
              contracts: sources.contracts,
              sessions: sources.sessions === null
                ? null
                : {
                  ...sources.sessions,
                  entryKinds: sources.sessions.entryKinds as WikiEntryKind[],
                  projects: sources.sessions.projects.map((id) => ({ id, title: titles.get(id) ?? null })),
                },
            },
          };
        }),
      })),
    }));
  }

  /** The newest version that is not superseded: the draft when there is one, else the confirmed version. */
  private async latest(db: Pick<Prisma.TransactionClient, 'wikiPlan'>, ownerId: string, spaceId: string): Promise<VersionRow | null> {
    return db.wikiPlan.findFirst({
      where: { ownerId, spaceId, status: { in: ['draft', 'confirmed'] } },
      orderBy: { version: 'desc' },
      select: VERSION_SELECT,
    });
  }

  // ── References ────────────────────────────────────────────────────────────────────────────────

  /**
   * Every project and topic the walk collected, looked up at once (contract `plan.gate.references`): a
   * project by its id, or failing that by its exact title — one project, not two — and a topic by its
   * slug among the space's. Each session condition's projects become their ids.
   */
  private async resolve(walk: Walk, ownerId: string, spaceId: string, plan: PlanContent): Promise<void> {
    const asId = (value: string): string | null => {
      try {
        return toUuid(value);
      } catch {
        return null;
      }
    };
    const values = [...new Set(walk.projects.map((named) => named.value))];
    const ids = [...new Set(values.map(asId).filter((id): id is string => id !== null))];
    const projects = values.length === 0
      ? []
      : await this.prisma.project.findMany({
        where: { ownerId, OR: [{ id: { in: ids } }, { title: { in: values } }] },
        select: { id: true, title: true },
      });
    const byId = new Map(projects.map((project) => [project.id, project.id]));
    const byTitle = new Map<string, string[]>();
    for (const project of projects) byTitle.set(project.title, [...(byTitle.get(project.title) ?? []), project.id]);
    const resolved = new Map<string, string>();
    for (const named of walk.projects) {
      const id = asId(named.value);
      const found = (id !== null ? byId.get(id) : undefined) ?? (byTitle.get(named.value)?.length === 1 ? byTitle.get(named.value)![0] : undefined);
      if (found) {
        resolved.set(named.value, found);
      } else if ((byTitle.get(named.value)?.length ?? 0) > 1) {
        walk.fail('references', named.path, `${byTitle.get(named.value)!.length} projects are titled ${quoted(named.value)}: name the one meant by its id`);
      } else {
        walk.fail('references', named.path, `no project of this account is titled ${quoted(named.value)} or has that id: name one of the account's projects exactly`);
      }
    }
    const slugs = [...new Set(walk.topics.map((named) => named.value))];
    const topics = new Set(
      slugs.length === 0
        ? []
        : (await this.prisma.wikiTopic.findMany({ where: { ownerId, spaceId, slug: { in: slugs } }, select: { slug: true } })).map((t) => t.slug),
    );
    for (const named of walk.topics) {
      if (!topics.has(named.value)) walk.fail('references', named.path, `${quoted(named.value)} is not a topic of this space`);
    }
    for (const doc of plan.docs) {
      for (const section of doc.sections) {
        const sessions = section.sources.sessions;
        if (sessions) sessions.projects = sessions.projects.map((value) => resolved.get(value) ?? value);
      }
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Store a version under the space row's lock (contract `plan.versions`): it is numbered after every
   * version the space has had, it supersedes the draft there was, and its documents and sections are
   * inserted with it. `expectLatest` is the version the caller built it on; another one found under the
   * lock is WIKI_PLAN_STALE, and nothing is written. A draft under an idempotency key that the same
   * request stored already — committed while this one waited for the lock — is answered with that
   * version first, replayed, and nothing is written (contract `plan.idempotency`).
   */
  private async store(
    ownerId: string,
    spaceId: string,
    expectLatest: number | null,
    next: NewVersion,
    after?: (tx: Prisma.TransactionClient, version: number) => Promise<void>,
  ): Promise<{ version: number; replayed: boolean }> {
    const stored = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`);
        if (next.idempotency) {
          const earlier = await storedUnder(tx, ownerId, next.idempotency);
          if (earlier !== null) return { version: earlier, replayed: true };
        }
        const latest = await tx.wikiPlan.findFirst({
          where: { ownerId, spaceId, status: { in: ['draft', 'confirmed'] } },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        if ((latest?.version ?? null) !== expectLatest) {
          throw stale(
            `the plan changed while this was prepared: it was built on ${expectLatest === null ? 'no version' : `version ${expectLatest}`}, `
              + `and the plan now stands at ${latest ? `version ${latest.version}` : 'no version'}. Nothing was stored; read the plan again.`,
          );
        }
        const top = await tx.wikiPlan.aggregate({ where: { ownerId, spaceId }, _max: { version: true } });
        const number = (top._max.version ?? 0) + 1;
        const now = new Date();
        await tx.wikiPlan.updateMany({ where: { ownerId, spaceId, status: 'draft' }, data: { status: 'superseded', supersededAt: now } });
        const planId = randomUUID();
        await tx.wikiPlan.create({
          data: {
            id: planId,
            spaceId,
            ownerId,
            version: number,
            status: 'draft',
            origin: next.origin,
            baseVersion: next.baseVersion,
            proposalId: next.proposalId,
            categories: next.plan.categories as unknown as Prisma.InputJsonValue,
            newFields: next.plan.newFields as unknown as Prisma.InputJsonValue,
            docsMin: next.target.min,
            docsMax: next.target.max,
            gate: next.gate as unknown as Prisma.InputJsonValue,
            repoSha: next.repoCheck?.sha ?? null,
            repoCheck: next.repoCheck === null ? Prisma.DbNull : (next.repoCheck as unknown as Prisma.InputJsonValue),
            model: next.model,
            authorSessionId: next.authorSessionId,
            authorUserId: next.authorUserId,
            idempotencyKey: next.idempotency?.key ?? null,
            requestSha256: next.idempotency?.requestSha256 ?? null,
          },
          select: { id: true },
        });
        const docIds = next.plan.docs.map(() => randomUUID());
        if (next.plan.docs.length > 0) {
          await tx.wikiPlanDoc.createMany({
            data: next.plan.docs.map((doc, position) => ({
              id: docIds[position],
              planId,
              ownerId,
              position,
              category: doc.category,
              slug: doc.slug,
              title: doc.title,
              question: doc.question,
              audience: doc.audience,
              scopeIn: doc.scopeIn,
              scopeOut: doc.scopeOut as unknown as Prisma.InputJsonValue,
              lengthMin: doc.length.min,
              lengthMax: doc.length.max,
              protected: doc.protected,
              extra: doc.extra as Prisma.InputJsonValue,
            })),
          });
          const sections = next.plan.docs.flatMap((doc, d) => doc.sections.map((section, position) => ({
            docId: docIds[d],
            ownerId,
            position,
            key: section.key!,
            title: section.title,
            kind: section.kind,
            covers: section.covers,
            length: section.length,
            sources: section.sources as unknown as Prisma.InputJsonValue,
            extra: section.extra as Prisma.InputJsonValue,
          })));
          if (sections.length > 0) await tx.wikiPlanSection.createMany({ data: sections });
        }
        if (after) await after(tx, number);
        return { version: number, replayed: false };
      },
      loggedRetry(this.logger, 'wiki.storePlanVersion'),
    );
    // A replay changed nothing to announce (contract `realtime.notPublishedWhen`).
    if (!stored.replayed) this.realtime?.publishWikiChanged(ownerId, spaceId);
    return stored;
  }

  /**
   * A draft from a maintenance run's drafting job (contract `plan.routes.draft`): the whole plan, the
   * target it was drafted to, and what the runner found when it checked the repository references. It
   * is gated as a whole — the protection check included, since the model wrote it — and stored as the
   * space's new draft, or refused WIKI_PLAN_GATE with every error. Under an idempotency key, the same
   * draft landing again is answered with the version it stored (contract `plan.idempotency`).
   */
  async submitDraft(principal: WikiPrincipal, spaceId: string, body: unknown): Promise<WikiPlanDraftAnswer> {
    await this.assertMaintainer(principal, spaceId);
    const { ownerId } = principal;
    const envelope = new Walk(new Map());
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (!raw) throw gateRefusal([{ check: 'schema', path: '', message: 'the body is an object: { baseVersion, target, plan, repoCheck, model, idempotencyKey }' }], 'The draft');
    for (const key of Object.keys(raw)) {
      if (!['baseVersion', 'target', 'plan', 'repoCheck', 'model', 'idempotencyKey'].includes(key)) envelope.fail('schema', key, `${quoted(key)} is not a field of a draft: baseVersion, target, plan, repoCheck, model, idempotencyKey`);
    }
    const baseVersion = raw.baseVersion === null || raw.baseVersion === undefined ? null : envelope.integer(raw.baseVersion, 'baseVersion', 1, 2_147_483_647);
    const target = targetOf(envelope, raw.target);
    const repoCheck = repoCheckOf(envelope, raw.repoCheck);
    const model = raw.model === undefined || raw.model === null ? null : envelope.text(raw.model, 'model', 200, true);
    // The same draft landing again under its key is answered before the plan is read: the version it
    // stored is the newest now, so its base no longer is, and it is no STALE draft but the same one.
    const key = keyOf(envelope, raw.idempotencyKey);
    const idempotency = key === null ? undefined : draftIdempotency(spaceId, key, raw);
    if (idempotency) {
      const earlier = await storedUnder(this.prisma, ownerId, idempotency);
      if (earlier !== null) return { ...(await this.version(ownerId, spaceId, earlier)), replayed: true };
    }

    const base = await this.latest(this.prisma, ownerId, spaceId);
    if ((base?.version ?? null) !== baseVersion) {
      throw stale(
        `this draft revises ${baseVersion === null ? 'no version' : `version ${baseVersion}`}, and the plan stands at `
          + `${base ? `version ${base.version}` : 'no version'}: read the plan again and draft from what it is now.`,
      );
    }
    const baseContent = base ? contentOf(base) : null;
    const { plan, walk } = walkDraft(raw.plan);
    walk.errors.unshift(...envelope.errors);
    await this.resolve(walk, ownerId, spaceId, plan);
    checkDocCount(walk, plan, target, 'plan.docs');
    checkProtected(walk, plan, baseContent, 'plan.');
    if (walk.errors.length > 0) throw gateRefusal(walk.errors, 'The draft');
    assignKeys(plan, baseContent);
    const stored = await this.store(ownerId, spaceId, base?.version ?? null, {
      origin: 'maintenance',
      baseVersion: base?.version ?? null,
      proposalId: null,
      plan,
      target,
      gate: report(plan, target, true),
      repoCheck,
      model,
      authorSessionId: principal.sessionId,
      authorUserId: null,
      idempotency,
    });
    return { ...(await this.version(ownerId, spaceId, stored.version)), replayed: stored.replayed };
  }

  /**
   * The owner's edit of one document, or of one section of one (contract `plan.routes.edit`): a new
   * draft on top of the version named, which must still be the newest. The owner's hand needs no
   * protection check — protecting is theirs — and the rest of the gate runs as for a draft.
   */
  async edit(ownerId: string, spaceId: string, body: unknown, actingSessionId: string | null): Promise<WikiPlanVersion> {
    ownerChannel(actingSessionId, 'editing the plan');
    await this.requireSpace(ownerId, spaceId);
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const envelope = new Walk(new Map());
    if (!raw) throw gateRefusal([{ check: 'schema', path: '', message: 'the body is an object: { baseVersion, docSlug, doc } or { baseVersion, docSlug, sectionKey, section }' }], 'The edit');
    for (const key of Object.keys(raw)) {
      if (!['baseVersion', 'docSlug', 'doc', 'sectionKey', 'section'].includes(key)) envelope.fail('schema', key, `${quoted(key)} is not a field of an edit: baseVersion, docSlug, doc, sectionKey, section`);
    }
    const baseVersion = envelope.integer(raw.baseVersion, 'baseVersion', 1, 2_147_483_647);
    const docSlug = envelope.slug(raw.docSlug, 'docSlug');
    const bySection = raw.section !== undefined;
    if (bySection === (raw.doc !== undefined)) envelope.fail('schema', 'doc', 'send the document (doc) or one of its sections (sectionKey and section), one of the two');
    if (bySection) envelope.slug(raw.sectionKey, 'sectionKey');
    if (envelope.errors.length > 0) throw gateRefusal(envelope.errors, 'The edit');

    const base = await this.prisma.wikiPlan.findFirst({ where: { ownerId, spaceId, version: baseVersion }, select: VERSION_SELECT });
    if (!base) throw new NotFoundException('no such version of this plan');
    const latest = await this.latest(this.prisma, ownerId, spaceId);
    if (latest?.version !== base.version) {
      throw stale(`version ${base.version} is no longer the newest version of this plan (${latest ? `version ${latest.version} is` : 'none is'}): edit that one`);
    }
    const baseContent = contentOf(base);
    const at = baseContent.docs.findIndex((doc) => doc.slug === docSlug);
    if (at < 0) throw new NotFoundException(`version ${base.version} has no document ${docSlug}`);
    const walk = new Walk(declaredOf(baseContent.newFields));
    const plan: PlanContent = { ...baseContent, docs: baseContent.docs.map((doc) => ({ ...doc, sections: doc.sections.map((s) => ({ ...s })) })) };
    if (bySection) {
      const key = String(raw.sectionKey).trim();
      const s = plan.docs[at].sections.findIndex((section) => section.key === key);
      if (s < 0) throw new NotFoundException(`document ${docSlug} has no section ${key}`);
      const section = walk.section(raw.section, 'section');
      if (section) {
        if (section.key !== null && section.key !== key && plan.docs[at].sections.some((other, i) => i !== s && other.key === section.key)) {
          walk.fail('schema', 'section.key', `${quoted(section.key)} is the key of another section of ${docSlug}`);
        }
        plan.docs[at].sections[s] = { ...section, key: section.key ?? key };
      }
    } else {
      const doc = walk.doc(raw.doc, 'doc');
      if (doc) plan.docs[at] = doc;
    }
    checkWhole(walk, plan, 'plan.');
    await this.resolve(walk, ownerId, spaceId, plan);
    const target = { min: base.docsMin, max: base.docsMax };
    checkDocCount(walk, plan, target, 'plan.docs');
    if (walk.errors.length > 0) throw gateRefusal(walk.errors, 'The edit');
    assignKeys(plan, baseContent);
    const { version: number } = await this.store(ownerId, spaceId, base.version, {
      origin: 'owner',
      baseVersion: base.version,
      proposalId: null,
      plan,
      target,
      gate: report(plan, target, false),
      repoCheck: null,
      model: null,
      authorSessionId: null,
      authorUserId: ownerId,
    });
    return this.version(ownerId, spaceId, number);
  }

  /**
   * The owner's confirmation of the space's draft (contract `plan.routes.confirm`): it becomes the
   * version in force, and the one that was is superseded. The owner channel's alone.
   *
   * A confirmation is a fact, and it asks for the build of the version's documents (contract
   * `plan.jobs.request`, criterion 11): a job of kind build, made at once as a task of the space's
   * maintenance list, queued behind the list's unfinished task, or held with why — after the
   * confirmation committed, and never failing it.
   */
  async confirm(ownerId: string, spaceId: string, version: number, actingSessionId: string | null): Promise<WikiPlanVersion> {
    ownerChannel(actingSessionId, 'confirming the plan');
    await this.requireSpace(ownerId, spaceId);
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`);
        const row = await tx.wikiPlan.findFirst({ where: { ownerId, spaceId, version }, select: { id: true, status: true } });
        if (!row) throw new NotFoundException('no such version of this plan');
        if (row.status !== 'draft') {
          throw stale(`version ${version} is ${row.status === 'confirmed' ? 'already the confirmed plan' : 'superseded by a newer version'}: only the space's draft is confirmed`);
        }
        const now = new Date();
        // The one in force steps down first: a space has one confirmed version at a time.
        await tx.wikiPlan.updateMany({ where: { ownerId, spaceId, status: 'confirmed' }, data: { status: 'superseded', supersededAt: now } });
        await tx.wikiPlan.update({ where: { id: row.id }, data: { status: 'confirmed', confirmedByUserId: ownerId, confirmedAt: now } });
      },
      loggedRetry(this.logger, 'wiki.confirmPlan'),
    );
    await this.buildAfterConfirmation(ownerId, spaceId, version);
    this.realtime?.publishWikiChanged(ownerId, spaceId);
    return this.version(ownerId, spaceId, version);
  }

  /** The build a confirmation asks for; the task it made published. Logged, never thrown: the confirmation stands. */
  private async buildAfterConfirmation(ownerId: string, spaceId: string, version: number): Promise<void> {
    try {
      const answer = await requestWikiPlanBuild(this.prisma, { ownerId, spaceId, version, requestedByUserId: ownerId });
      if (answer.madeTaskId && typeof this.realtime?.publishForUser === 'function') {
        this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [answer.madeTaskId], resync: false });
      }
    } catch (error) {
      this.logger.warn(`the build of version ${version} of a space's plan was not asked for: ${(error as Error).message}`);
    }
  }

  /**
   * A change a maintenance run proposes (contract `plan.proposals`): knowledge that fits no section of
   * the plan, as the document it would take — a new one, or one of the plan's rewritten — with why and
   * the facts it came from. It is gated against the confirmed plan, protection included, and stored
   * pending; the plan does not change until the owner accepts it.
   */
  async propose(principal: WikiPrincipal, spaceId: string, body: unknown): Promise<WikiPlanProposal> {
    await this.assertMaintainer(principal, spaceId);
    const { ownerId } = principal;
    const confirmed = await requireConfirmedPlan(this.prisma, { ownerId, spaceId });
    const row = await this.prisma.wikiPlan.findFirstOrThrow({ where: { id: confirmed.id }, select: VERSION_SELECT });
    const base = contentOf(row);
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const walk = new Walk(declaredOf(base.newFields));
    if (!raw) throw gateRefusal([{ check: 'schema', path: '', message: 'the body is an object: { reason, change: { doc, category }, facts }' }], 'The proposal');
    for (const key of Object.keys(raw)) {
      if (!['reason', 'change', 'facts'].includes(key)) walk.fail('schema', key, `${quoted(key)} is not a field of a proposal: reason, change, facts`);
    }
    const reason = walk.text(raw.reason, 'reason', WIKI_PLAN_RULES.reasonMaxChars, true);
    const facts = this.factsOf(walk, raw.facts);
    const change = raw.change && typeof raw.change === 'object' && !Array.isArray(raw.change) ? (raw.change as Record<string, unknown>) : null;
    if (!change) walk.fail('schema', 'change', 'must be an object: { doc, category }');
    for (const key of Object.keys(change ?? {})) {
      if (!['doc', 'category'].includes(key)) walk.fail('schema', `change.${key}`, `${quoted(key)} is not a field of a change: doc, category`);
    }
    const doc = change ? walk.doc(change.doc, 'change.doc') : null;
    const category = change?.category === undefined || change?.category === null ? null : walk.category(change.category, 'change.category');
    const opens = category !== null && !base.categories.some((c) => c.key === category.key);
    if (category && !opens) {
      walk.fail('schema', 'change.category.key', `${quoted(category.key)} is already a category of the plan: leave category out, and file the document under it`);
    }
    const plan = doc ? applyChange(base, doc, opens ? category : null) : base;
    checkWhole(walk, plan, 'plan.');
    await this.resolve(walk, ownerId, spaceId, plan);
    await this.checkFacts(walk, ownerId, spaceId, facts);
    const target = { min: row.docsMin, max: row.docsMax };
    checkDocCount(walk, plan, target, 'plan.docs');
    checkProtected(walk, plan, base, 'plan.');
    if (walk.errors.length > 0 || !doc) throw gateRefusal(walk.errors, 'The proposal');
    const made = await this.prisma.wikiPlanProposal.create({
      data: {
        spaceId,
        ownerId,
        baseVersion: confirmed.version,
        reason,
        change: { doc: docInputOf(doc), category } as unknown as Prisma.InputJsonValue,
        facts: facts as unknown as Prisma.InputJsonValue,
        gate: report(plan, target, true) as unknown as Prisma.InputJsonValue,
        authorSessionId: principal.sessionId!,
      },
      select: PROPOSAL_SELECT,
    });
    this.realtime?.publishWikiChanged(ownerId, spaceId);
    return proposalView(made);
  }

  private factsOf(walk: Walk, value: unknown): Array<{ kind: WikiPlanFactKind; id: string }> {
    const items = Array.isArray(value) ? value : [];
    if (!Array.isArray(value) || value.length === 0) {
      walk.fail('schema', 'facts', 'must name at least one fact: the entries, sessions and commits this change comes from');
    }
    if (items.length > WIKI_PLAN_RULES.factsMax) walk.fail('schema', 'facts', `names at most ${WIKI_PLAN_RULES.factsMax} facts`);
    return items.slice(0, WIKI_PLAN_RULES.factsMax).flatMap((item, i) => {
      const at = `facts[${i}]`;
      const fact = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
      if (!fact) {
        walk.fail('schema', at, 'must be an object: { kind, id }');
        return [];
      }
      for (const key of Object.keys(fact)) if (!['kind', 'id'].includes(key)) walk.fail('schema', `${at}.${key}`, `${quoted(key)} is not a field of a fact: kind, id`);
      const kind = typeof fact.kind === 'string' ? unwrapped(fact.kind) : fact.kind;
      if (!(WIKI_PLAN_FACT_KINDS as readonly unknown[]).includes(kind)) {
        walk.fail('schema', `${at}.kind`, `a fact is one of ${WIKI_PLAN_FACT_KINDS.join(', ')}`);
        return [];
      }
      if (kind === 'commit') {
        // A commit is named by its full sha, which the maintenance run found on origin/main: the server has
        // no checkout to look it up in (contract `plan.proposals.factKinds`).
        const sha = String(fact.id ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{40}$/u.test(sha)) {
          walk.fail('schema', `${at}.id`, "a commit is named by its full sha: 40 hex characters, as origin/main has it");
          return [];
        }
        return [{ kind: 'commit' as WikiPlanFactKind, id: sha }];
      }
      let id: string;
      try {
        id = toUuid(String(fact.id ?? '').trim());
      } catch {
        walk.fail('schema', `${at}.id`, 'must be an id');
        return [];
      }
      return [{ kind: kind as WikiPlanFactKind, id }];
    });
  }

  /** A fact is an entry of this space or a session of its owner; a commit the runner found is taken as it named it. */
  private async checkFacts(walk: Walk, ownerId: string, spaceId: string, facts: ReadonlyArray<{ kind: WikiPlanFactKind; id: string }>): Promise<void> {
    const of = (kind: WikiPlanFactKind): string[] => facts.filter((fact) => fact.kind === kind).map((fact) => fact.id);
    const [entries, sessions] = await Promise.all([
      of('entry').length === 0 ? [] : this.prisma.wikiEntry.findMany({ where: { ownerId, spaceId, id: { in: of('entry') } }, select: { id: true } }),
      of('session').length === 0 ? [] : this.prisma.session.findMany({ where: { ownerId, id: { in: of('session') } }, select: { id: true } }),
    ]);
    const found = new Set([...entries, ...sessions].map((row) => row.id));
    facts.forEach((fact, i) => {
      if (fact.kind === 'commit') return;
      if (!found.has(fact.id)) walk.fail('references', `facts[${i}].id`, fact.kind === 'entry' ? 'no entry of this space has this id' : 'no session of this account has this id');
    });
  }

  /**
   * The owner's answer to a proposal (contract `plan.routes.decide`). A rejection changes nothing but
   * the proposal. An acceptance applies its document to the newest version — the draft when there is
   * one — gates the result again, since the plan may have moved since it was proposed, and stores it
   * as a new draft for the owner to confirm. The owner channel's alone.
   */
  async decide(ownerId: string, proposalId: string, body: unknown, actingSessionId: string | null): Promise<WikiPlanDecisionResult> {
    ownerChannel(actingSessionId, 'deciding a change to the plan');
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const walk = new Walk(new Map());
    for (const key of Object.keys(raw)) if (!['action', 'note'].includes(key)) walk.fail('schema', key, `${quoted(key)} is not a field of a decision: action, note`);
    const action = raw.action;
    if (!(WIKI_PLAN_PROPOSAL_ACTIONS as readonly unknown[]).includes(action)) walk.fail('schema', 'action', `must be one of ${WIKI_PLAN_PROPOSAL_ACTIONS.join(', ')}`);
    const note = raw.note === undefined || raw.note === null ? null : walk.text(raw.note, 'note', WIKI_PLAN_RULES.reasonMaxChars, false) || null;
    if (walk.errors.length > 0) throw gateRefusal(walk.errors, 'The decision');
    const proposal = await this.prisma.wikiPlanProposal.findFirst({ where: { id: proposalId, ownerId }, select: PROPOSAL_SELECT });
    if (!proposal) throw new NotFoundException('no such plan proposal');
    const spaceId = proposal.spaceId;
    if (proposal.status !== 'pending') throw stale(`this proposal was already ${proposal.status}`);
    const settle = async (tx: Prisma.TransactionClient, status: WikiPlanProposalStatus, resultVersion: number | null): Promise<void> => {
      const settled = await tx.wikiPlanProposal.updateMany({
        where: { id: proposalId, ownerId, status: 'pending' },
        data: { status, decidedByUserId: ownerId, decidedAt: new Date(), decisionNote: note, resultVersion },
      });
      if (settled.count !== 1) throw stale('this proposal was decided while this answer was on its way');
    };

    if (action === 'reject') {
      await withTransactionRetry(
        this.prisma,
        async (tx) => {
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`);
          await settle(tx, 'rejected', null);
        },
        loggedRetry(this.logger, 'wiki.rejectPlanProposal'),
      );
      this.realtime?.publishWikiChanged(ownerId, spaceId);
      const rejected = await this.prisma.wikiPlanProposal.findFirstOrThrow({ where: { id: proposalId }, select: PROPOSAL_SELECT });
      return { proposal: proposalView(rejected), draft: null };
    }

    const base = await this.latest(this.prisma, ownerId, spaceId);
    if (!base) throw stale('this space has no plan left to change');
    const baseContent = contentOf(base);
    const recorded = proposal.change as unknown as { doc: unknown; category: unknown };
    const check = new Walk(declaredOf(baseContent.newFields));
    const doc = check.doc(recorded.doc, 'change.doc');
    const category = recorded.category === null || recorded.category === undefined ? null : check.category(recorded.category, 'change.category');
    const plan = doc ? applyChange(baseContent, doc, category && !baseContent.categories.some((c) => c.key === category.key) ? category : null) : baseContent;
    checkWhole(check, plan, 'plan.');
    await this.resolve(check, ownerId, spaceId, plan);
    const target = { min: base.docsMin, max: base.docsMax };
    checkDocCount(check, plan, target, 'plan.docs');
    checkProtected(check, plan, baseContent, 'plan.');
    if (check.errors.length > 0 || !doc) throw gateRefusal(check.errors, `This proposal, applied to version ${base.version},`);
    assignKeys(plan, baseContent);
    const { version: number } = await this.store(
      ownerId,
      spaceId,
      base.version,
      {
        origin: 'owner',
        baseVersion: base.version,
        proposalId,
        plan,
        target,
        gate: report(plan, target, true),
        repoCheck: null,
        model: null,
        authorSessionId: null,
        authorUserId: ownerId,
      },
      (tx, version) => settle(tx, 'accepted', version),
    );
    const accepted = await this.prisma.wikiPlanProposal.findFirstOrThrow({ where: { id: proposalId }, select: PROPOSAL_SELECT });
    return { proposal: proposalView(accepted), draft: await this.version(ownerId, spaceId, number) };
  }

  // ── The plan's jobs (contract `plan.jobs`) ────────────────────────────────────────────────────

  /**
   * The owner asks for a draft of the space's plan — with instructions, a revision of its newest version
   * (contract `plan.routes.redraft`). The owner channel only: a request with a session header is refused
   * before anything is read. The space's draft that has not ended answers it, asked again whether it may
   * be made now; otherwise a job is recorded, and made as a task of the space's maintenance list, queued
   * behind the list's unfinished task, or held with why.
   */
  async redraft(ownerId: string, spaceId: string, body: unknown, actingSessionId: string | null): Promise<WikiPlanRedraftResult> {
    ownerChannel(actingSessionId, "asking for a draft of the space's plan");
    await this.requireSpace(ownerId, spaceId);
    const raw = body === undefined || body === null ? {} : body;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw schemaRefusal('the body is an object: { instructions? }');
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'instructions') throw schemaRefusal(`${key} is not a field of a redraft: instructions`);
    }
    let instructions: string | null = null;
    if (record.instructions !== undefined && record.instructions !== null) {
      if (typeof record.instructions !== 'string') throw schemaRefusal('instructions is a string: what the owner wants the plan to change');
      const text = record.instructions.trim();
      if (chars(text) > WIKI_PLAN_JOB_RULES.instructionsMaxChars) {
        throw schemaRefusal(`instructions are at most ${WIKI_PLAN_JOB_RULES.instructionsMaxChars} characters`);
      }
      instructions = text === '' ? null : text;
    }
    const answer = await requestWikiPlanJob(this.prisma, {
      ownerId,
      spaceId,
      kind: instructions ? 'revise' : 'draft',
      instructions,
      trigger: 'owner',
      requestedByUserId: ownerId,
    });
    if (answer.madeTaskId && typeof this.realtime?.publishForUser === 'function') {
      this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [answer.madeTaskId], resync: false });
    }
    this.realtime?.publishWikiChanged(ownerId, spaceId);
    const job = await wikiPlanJobById(this.prisma, ownerId, answer.jobId);
    if (!job) throw new NotFoundException('no such plan job');
    return { created: answer.created, job };
  }

  /**
   * Where a job's run starts (contract `plan.jobs.context`): the job its maintenance session runs, and the
   * space, its repository and the maintenance workspace's checkout. Records that the run started.
   */
  async jobContext(principal: WikiPrincipal, spaceId: string): Promise<WikiPlanJobContext> {
    await this.assertMaintainer(principal, spaceId);
    const row = await this.jobOfRun(principal, spaceId);
    await startWikiPlanJob(this.prisma, row.id, principal.sessionId!);
    const job = await wikiPlanJobById(this.prisma, principal.ownerId, row.id);
    const space = await this.prisma.wikiSpace.findFirstOrThrow({
      where: { id: spaceId, ownerId: principal.ownerId },
      select: { id: true, title: true, repoUrlNorm: true, rootCommitSha: true, settings: true },
    });
    const stored = space.settings !== null && typeof space.settings === 'object' && !Array.isArray(space.settings)
      ? (space.settings as Record<string, unknown>).maintenance
      : undefined;
    const workspaceId = wikiMaintenanceSettings(stored).workspaceId;
    const workspace = workspaceId
      ? await this.prisma.workspace.findFirst({ where: { id: workspaceId, ownerId: principal.ownerId }, select: { id: true, workDir: true } })
      : null;
    this.realtime?.publishWikiChanged(principal.ownerId, spaceId);
    return {
      job: job!,
      space: {
        id: space.id,
        title: space.title,
        repo: { urlNorm: space.repoUrlNorm, rootCommitSha: space.rootCommitSha },
        workspace: workspace ? { id: workspace.id, workDir: workspace.workDir } : null,
      },
    };
  }

  /**
   * The gate round a job's run is on, or how far a build's has got (contract `plan.jobs.progress`): what the
   * plan page shows as it runs.
   */
  async jobProgress(principal: WikiPrincipal, spaceId: string, body: unknown): Promise<WikiPlanJob> {
    await this.assertMaintainer(principal, spaceId);
    const row = await this.jobOfRun(principal, spaceId);
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (row.state !== 'made') throw jobEnded();
    if (row.kind === 'build') {
      if (!(await progressWikiPlanBuild(this.prisma, row.id, principal.sessionId!, buildProgressOf(raw)))) throw jobEnded();
      this.realtime?.publishWikiChanged(principal.ownerId, spaceId);
      return (await wikiPlanJobById(this.prisma, principal.ownerId, row.id))!;
    }
    const attempt = raw.attempt;
    if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > WIKI_PLAN_JOB_RULES.attemptsMax) {
      throw schemaRefusal(`attempt is the gate round the run is on, from 1 to ${WIKI_PLAN_JOB_RULES.attemptsMax}`);
    }
    if (!(await progressWikiPlanJob(this.prisma, row.id, principal.sessionId!, attempt))) throw jobEnded();
    this.realtime?.publishWikiChanged(principal.ownerId, spaceId);
    return (await wikiPlanJobById(this.prisma, principal.ownerId, row.id))!;
  }

  /**
   * How a job's run ended (contract `plan.jobs.finish`): succeeded with the version it stored — a draft of
   * this space this very session submitted — or failed with the gate's errors on its last round, what went
   * wrong, its report and the last draft it had. Kept on its job, which is ended; a job ended already is
   * refused WIKI_PLAN_NO_JOB.
   */
  async jobFinish(principal: WikiPrincipal, spaceId: string, body: unknown): Promise<WikiPlanJob> {
    await this.assertMaintainer(principal, spaceId);
    const row = await this.jobOfRun(principal, spaceId);
    if (row.state !== 'made') {
      // The same end said again by the run that said it — its first send landed and the answer was lost on
      // the way back (the runner sends it again, `Transport.doWiki`) — is answered with what was kept. Any
      // other word to an ended job is refused.
      if (row.sessionId === principal.sessionId && sameJobEnd(row, body)) {
        return (await wikiPlanJobById(this.prisma, principal.ownerId, row.id))!;
      }
      throw jobEnded();
    }
    const end = jobEndOf(body);
    if (end.outcome === 'succeeded' && row.kind === 'build') {
      // A build that succeeded wrote the documents of a version the owner confirmed: the one it was made for,
      // or — confirmed while it waited — a newer one.
      const written = await this.prisma.wikiPlan.findFirst({
        where: { ownerId: principal.ownerId, spaceId, version: end.version!, confirmedAt: { not: null } },
        select: { id: true },
      });
      if (!written) {
        throw schemaRefusal(`version ${end.version} is not a version of this space its owner confirmed: a build that succeeded names the confirmed version it wrote`);
      }
    } else if (end.outcome === 'succeeded') {
      const stored = await this.prisma.wikiPlan.findFirst({
        where: { ownerId: principal.ownerId, spaceId, version: end.version!, authorSessionId: principal.sessionId },
        select: { id: true },
      });
      if (!stored) {
        throw schemaRefusal(`version ${end.version} is not a draft of this space this run stored: a run that succeeded names the version its draft became`);
      }
    }
    if (!(await finishWikiPlanJob(this.prisma, row.id, principal.sessionId!, end, new Date(), row.kind as WikiPlanJob['kind']))) throw jobEnded();
    this.realtime?.publishWikiChanged(principal.ownerId, spaceId);
    return (await wikiPlanJobById(this.prisma, principal.ownerId, row.id))!;
  }

  /**
   * `orbit wiki plan check` (contract `plan.jobs.check`): whether a job's run did what its task was made
   * for. The owner's runner with no session — a task's acceptance command runs with none — or a
   * maintenance run of the space; another owner's space or job is a 404. It writes nothing.
   */
  async jobCheck(ownerId: string, spaceId: string, jobId: string): Promise<WikiPlanJobCheck> {
    await this.requireSpace(ownerId, spaceId);
    const check = await wikiPlanJobCheck(this.prisma, ownerId, spaceId, jobId);
    if (!check) throw new NotFoundException('no such plan job');
    return { spaceId, jobId, ...check };
  }

  /** What a draft reads of Orbit besides the repository (contract `plan.jobs.materials`): a maintenance run's alone. */
  async materials(principal: WikiPrincipal, spaceId: string): Promise<WikiPlanMaterials> {
    await this.assertMaintainer(principal, spaceId);
    return wikiPlanMaterials(this.prisma, principal.ownerId, spaceId);
  }

  /** The job the calling maintenance run runs, or WIKI_PLAN_NO_JOB. */
  private async jobOfRun(principal: WikiPrincipal, spaceId: string): Promise<WikiPlanJobRow> {
    const row = await wikiPlanJobOfSession(this.prisma, principal.ownerId, spaceId, principal.sessionId!);
    if (!row) {
      throw new WikiRefusalError({
        code: 'WIKI_PLAN_NO_JOB',
        message:
          "this maintenance run runs no job of this space's plan: its task was not made for one. A draft or a revision "
            + "of the plan is asked for by the space's creation or by its owner, and runs as a task the server makes.",
      });
    }
    return row;
  }
}

/** A malformed request of the plan's jobs. */
function schemaRefusal(message: string): WikiRefusalError {
  return new WikiRefusalError({ code: 'WIKI_SCHEMA', message });
}

/** A build's progress as its run said it, checked (contract `plan.jobs.progress`). */
function buildProgressOf(raw: Record<string, unknown>): WikiPlanBuildProgress {
  for (const key of Object.keys(raw)) {
    if (!['docs', 'current'].includes(key)) throw schemaRefusal(`${key} is not a field of a build's progress: docs, current`);
  }
  const docs = raw.docs && typeof raw.docs === 'object' && !Array.isArray(raw.docs) ? (raw.docs as Record<string, unknown>) : null;
  const count = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000 ? value : null);
  const done = count(docs?.done);
  const total = count(docs?.total);
  if (done === null || total === null || done > total) {
    throw schemaRefusal("docs is { done, total }: the documents the build went through, of the confirmed version's, done not above total");
  }
  let current: WikiPlanBuildProgress['current'] = null;
  if (raw.current !== undefined && raw.current !== null) {
    const at = typeof raw.current === 'object' && !Array.isArray(raw.current) ? (raw.current as Record<string, unknown>) : null;
    if (!at || typeof at.slug !== 'string' || !SLUG.test(at.slug) || typeof at.title !== 'string' || at.title.trim() === '') {
      throw schemaRefusal('current is { slug, title }: the document the build is writing now, or null');
    }
    current = { slug: at.slug, title: at.title.trim().slice(0, WIKI_PLAN_RULES.titleMaxChars) };
  }
  return { docs: { done, total }, current };
}

/**
 * Whether body says the end an ended job has: the same outcome, and for a success the same version (a
 * build that failed keeps the version it was made for, whatever its run named).
 */
function sameJobEnd(row: WikiPlanJobRow, body: unknown): boolean {
  try {
    const end = jobEndOf(body);
    return end.outcome === row.outcome && (end.outcome === 'failed' || (end.version ?? null) === (row.version ?? null));
  } catch {
    return false;
  }
}

/** A job that ended already is told so, whichever way it ended. */
function jobEnded(): WikiRefusalError {
  return new WikiRefusalError({
    code: 'WIKI_PLAN_NO_JOB',
    message: "this run's plan job has ended — its run said how, or its task ended first — so nothing more is kept of it.",
  });
}

/** A run's end as it said it, checked (contract `plan.jobs.finish`). */
function jobEndOf(body: unknown): WikiPlanJobEnd {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!raw) throw schemaRefusal('the body is an object: { outcome, version?, errors?, error?, report?, draft?, attempt? }');
  const known = ['outcome', 'version', 'errors', 'error', 'report', 'draft', 'attempt'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw schemaRefusal(`${key} is not a field of a job's end: ${known.join(', ')}`);
  }
  if (!(WIKI_PLAN_JOB_OUTCOMES as readonly unknown[]).includes(raw.outcome)) {
    throw schemaRefusal(`outcome is one of ${WIKI_PLAN_JOB_OUTCOMES.join(', ')}`);
  }
  const outcome = raw.outcome as WikiPlanJobOutcome;
  const version = raw.version === undefined || raw.version === null ? null : raw.version;
  if (version !== null && (typeof version !== 'number' || !Number.isInteger(version) || version < 1)) {
    throw schemaRefusal('version is the number of the version the run stored, 1 or more');
  }
  if (outcome === 'succeeded' && version === null) throw schemaRefusal('a run that succeeded names the version its draft became');
  const errors: WikiPlanGateError[] = [];
  if (raw.errors !== undefined && raw.errors !== null) {
    if (!Array.isArray(raw.errors)) throw schemaRefusal('errors is a list of the gate\'s errors: [{ check, path, message }]');
    for (const item of raw.errors.slice(0, WIKI_PLAN_RULES.errorsMax)) {
      const error = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
      if (!error || typeof error.check !== 'string' || typeof error.path !== 'string' || typeof error.message !== 'string') {
        throw schemaRefusal('each of errors is { check, path, message }, three strings');
      }
      errors.push({
        check: error.check.slice(0, 40) as WikiPlanGateCheck,
        path: error.path.slice(0, WIKI_PLAN_RULES.textMaxChars),
        message: error.message.slice(0, WIKI_PLAN_RULES.reasonMaxChars),
      });
    }
  }
  let error: string | null = null;
  if (raw.error !== undefined && raw.error !== null) {
    if (typeof raw.error !== 'string') throw schemaRefusal('error is what went wrong, in words');
    error = redactSecrets(raw.error.trim()).text.slice(0, WIKI_PLAN_JOB_RULES.errorMaxChars).trim() || null;
  }
  const object = (value: unknown, name: string, max: number): Record<string, unknown> | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw schemaRefusal(`${name} is an object`);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > max) throw schemaRefusal(`${name} is at most ${max} bytes of JSON`);
    return value as Record<string, unknown>;
  };
  const attempt = raw.attempt === undefined || raw.attempt === null ? null : raw.attempt;
  if (attempt !== null && (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > WIKI_PLAN_JOB_RULES.attemptsMax)) {
    throw schemaRefusal(`attempt is the gate round the run ended on, from 1 to ${WIKI_PLAN_JOB_RULES.attemptsMax}`);
  }
  return {
    outcome,
    version: version as number | null,
    errors,
    error,
    report: object(raw.report, 'report', WIKI_PLAN_JOB_RULES.reportMaxBytes),
    draft: object(raw.draft, 'draft', WIKI_PLAN_JOB_RULES.draftMaxBytes),
    attempt: attempt as number | null,
  };
}

/** The plan with one document put in: in place of the one of its slug, or after the last of its category. */
function applyChange(base: PlanContent, doc: PlanDoc, category: PlanCategory | null): PlanContent {
  const docs = base.docs.map((d) => ({ ...d, sections: d.sections.map((s) => ({ ...s })) }));
  const categories = category ? [...base.categories, category] : [...base.categories];
  const at = docs.findIndex((d) => d.slug === doc.slug);
  if (at >= 0) {
    docs[at] = doc;
  } else {
    const last = docs.map((d) => d.category).lastIndexOf(doc.category);
    docs.splice(last < 0 ? docs.length : last + 1, 0, doc);
  }
  return { categories, docs, newFields: base.newFields };
}

/** The document count a draft asks to be held to, or the contract's. */
function targetOf(walk: Walk, value: unknown): { min: number; max: number } {
  if (value === undefined || value === null) return { min: WIKI_PLAN_RULES.docsMin, max: WIKI_PLAN_RULES.docsMax };
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!raw) {
    walk.fail('schema', 'target', 'must be an object: { min, max }');
    return { min: WIKI_PLAN_RULES.docsMin, max: WIKI_PLAN_RULES.docsMax };
  }
  for (const key of Object.keys(raw)) if (!['min', 'max'].includes(key)) walk.fail('schema', `target.${key}`, `${quoted(key)} is not a field of a target: min, max`);
  const min = walk.integer(raw.min, 'target.min', 1, WIKI_PLAN_RULES.docsCeiling);
  const max = walk.integer(raw.max, 'target.max', 1, WIKI_PLAN_RULES.docsCeiling);
  if (max < min) walk.fail('schema', 'target', 'max must not be below min');
  return { min, max };
}

/** What the runner reported of the repository references it checked, as it is kept (contract `plan.gate.repo`). */
function repoCheckOf(walk: Walk, value: unknown): WikiPlanRepoCheck {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!raw) {
    walk.fail('schema', 'repoCheck', 'is required: { sha, checked, missing }, what the drafting job found when it checked the repository references on the runner');
    return { sha: '', checked: 0, missing: [] };
  }
  for (const key of Object.keys(raw)) if (!['sha', 'checked', 'missing'].includes(key)) walk.fail('schema', `repoCheck.${key}`, `${quoted(key)} is not a field of a repository check: sha, checked, missing`);
  const sha = typeof raw.sha === 'string' ? raw.sha.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{7,64}$/u.test(sha)) walk.fail('schema', 'repoCheck.sha', 'must be the commit the references were checked at: 7 to 64 hex characters');
  const checked = walk.integer(raw.checked, 'repoCheck.checked', 0, 1_000_000);
  const listed = Array.isArray(raw.missing) ? raw.missing : [];
  if (!Array.isArray(raw.missing)) walk.fail('schema', 'repoCheck.missing', 'must be a list, empty when every reference was found');
  if (listed.length > WIKI_PLAN_RULES.repoMissingMax) walk.fail('schema', 'repoCheck.missing', `lists at most ${WIKI_PLAN_RULES.repoMissingMax}`);
  const missing = listed.slice(0, WIKI_PLAN_RULES.repoMissingMax).flatMap((item, i) => {
    const at = `repoCheck.missing[${i}]`;
    const miss = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (!miss) {
      walk.fail('schema', at, 'must be an object: { kind, ref, at }');
      return [];
    }
    if (!(WIKI_PLAN_REPO_REF_KINDS as readonly unknown[]).includes(miss.kind)) walk.fail('schema', `${at}.kind`, `must be one of ${WIKI_PLAN_REPO_REF_KINDS.join(', ')}`);
    return [{
      kind: miss.kind as WikiPlanRepoRefKind,
      ref: walk.text(miss.ref, `${at}.ref`, WIKI_PLAN_RULES.textMaxChars, true),
      at: miss.at === undefined || miss.at === null ? null : walk.text(miss.at, `${at}.at`, 200, true),
    }];
  });
  return { sha, checked, missing };
}

function proposalView(row: ProposalRow): WikiPlanProposal {
  return {
    id: row.id,
    spaceId: row.spaceId,
    status: row.status as WikiPlanProposalStatus,
    baseVersion: row.baseVersion,
    reason: row.reason,
    change: row.change as unknown as WikiPlanProposal['change'],
    facts: row.facts as unknown as WikiPlanProposal['facts'],
    gate: row.gate as unknown as WikiPlanGateReport,
    authorSessionId: row.authorSessionId,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    resultVersion: row.resultVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

