// The scanner of sessions/session-status-column.spec.ts (docs/session-status-retirement-plan.md §5). It reads source
// text, not types: a small tokenizer and bracket tree over the comment-stripped file, the Prisma relations read from
// schema.prisma, and the raw SQL held in string and template literals.

import { stripComments } from './strip-comments';

export type HitKind =
  /** `session.status` is read: a query filter or select, a property of a session row, a raw SQL mention. */
  | 'read'
  /** `session.status` is written: a Prisma data object, a nested write, an SQL SET or INSERT column, an assignment. */
  | 'write'
  /** The column's Prisma type, `RunStatus` of `@prisma/client`, is imported or reached. */
  | 'enum'
  /** A write of `status` with no `turnState` beside it: the dual write of deploy 2. */
  | 'alone'
  /** `session.phase` is read where slots, claims and dispatch are decided. Never allowed. */
  | 'phase';

export interface Hit {
  kind: HitKind;
  line: number;
  how: string;
}

// ── The schema ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface Schema {
  /** Model name to field name to the model it relates to, or null for a scalar or enum field. */
  models: Map<string, Map<string, string | null>>;
  /** `prisma.<delegate>` to model name. */
  delegates: Map<string, string>;
}

export function readSchema(text: string): Schema {
  const blocks = [...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const names = new Set(blocks.map((b) => b[1]));
  const models = new Map<string, Map<string, string | null>>();
  const delegates = new Map<string, string>();
  for (const [, model, body] of blocks) {
    const fields = new Map<string, string | null>();
    for (const line of body.split('\n')) {
      const field = /^\s+(\w+)\s+(\w+)(\[\]|\?)?(\s|$)/.exec(line);
      if (field) fields.set(field[1], names.has(field[2]) ? field[2] : null);
    }
    models.set(model, fields);
    delegates.set(model[0].toLowerCase() + model.slice(1), model);
  }
  return { models, delegates };
}

// ── Tokens and brackets ─────────────────────────────────────────────────────────────────────────────────────────

interface Token {
  type: 'id' | 'str' | 'tpl' | 'num' | 'punct' | 'regex';
  /** For `str` and `tpl`, the text between the quotes; a template keeps its `${…}` as written. */
  value: string;
  pos: number;
}

interface Group {
  type: 'group';
  open: '{' | '(' | '[';
  pos: number;
  items: Node[];
  parent: Group | null;
}

type Node = Token | Group;

const PUNCT = ['===', '!==', '...', '?.', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '++', '--', '+=', '-='];
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', '===', '!==', '==', '!=']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

/** The end of the template literal that opens at `from` (the index after its closing backtick). */
function templateEnd(code: string, from: number): number {
  let i = from + 1;
  let depth = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '\\') i += 2;
    else if (depth === 0 && c === '`') return i + 1;
    else if (c === '$' && code[i + 1] === '{') {
      depth += 1;
      i += 2;
    } else if (depth > 0 && c === '`') i = templateEnd(code, i);
    else if (depth > 0 && (c === '\'' || c === '"')) {
      i += 1;
      while (i < code.length && code[i] !== c && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1;
      i += 1;
    } else {
      if (depth > 0 && c === '{') depth += 1;
      if (depth > 0 && c === '}') depth -= 1;
      i += 1;
    }
  }
  return code.length;
}

function tokenize(code: string, from = 0, to = code.length): Token[] {
  const tokens: Token[] = [];
  let i = from;
  while (i < to) {
    const c = code[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < to && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      tokens.push({ type: 'str', value: code.slice(i + 1, j), pos: i });
      i = j + 1;
    } else if (c === '`') {
      const end = templateEnd(code, i);
      tokens.push({ type: 'tpl', value: code.slice(i + 1, end - 1), pos: i });
      i = end;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < to && /[\w$]/.test(code[j])) j += 1;
      tokens.push({ type: 'id', value: code.slice(i, j), pos: i });
      i = j;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < to && /[\w.]/.test(code[j])) j += 1;
      tokens.push({ type: 'num', value: code.slice(i, j), pos: i });
      i = j;
    } else if (c === '/' && regexStarts(tokens[tokens.length - 1])) {
      let j = i + 1;
      let inClass = false;
      while (j < to && code[j] !== '\n') {
        if (code[j] === '\\') j += 1;
        else if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        else if (code[j] === '/' && !inClass) break;
        j += 1;
      }
      tokens.push({ type: 'regex', value: code.slice(i, j + 1), pos: i });
      i = j + 1;
    } else {
      const long = PUNCT.find((p) => code.startsWith(p, i));
      tokens.push({ type: 'punct', value: long ?? c, pos: i });
      i += long ? long.length : 1;
    }
  }
  return tokens;
}

function regexStarts(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (previous.type === 'punct') return REGEX_AFTER.has(previous.value);
  return previous.type === 'id' && REGEX_AFTER_WORD.has(previous.value);
}

const CLOSE: Record<string, string> = { '{': '}', '(': ')', '[': ']' };

function tree(tokens: Token[]): Group {
  const root: Group = { type: 'group', open: '{', pos: 0, items: [], parent: null };
  let current = root;
  for (const token of tokens) {
    if (token.type === 'punct' && token.value in CLOSE) {
      const group: Group = { type: 'group', open: token.value as Group['open'], pos: token.pos, items: [], parent: current };
      current.items.push(group);
      current = group;
    } else if (token.type === 'punct' && current.parent && token.value === CLOSE[current.open]) {
      current = current.parent;
    } else {
      current.items.push(token);
    }
  }
  return root;
}

const isPunct = (node: Node | undefined, value: string): boolean => node?.type === 'punct' && node.value === value;
const isId = (node: Node | undefined, value?: string): boolean =>
  node?.type === 'id' && (value === undefined || node.value === value);
const isGroup = (node: Node | undefined, open?: Group['open']): node is Group =>
  node?.type === 'group' && (open === undefined || node.open === open);

/** The runs of `items` between the commas (or semicolons) at this level. */
function split(items: Node[], separators = [',']): Node[][] {
  const parts: Node[][] = [[]];
  for (const item of items) {
    if (item.type === 'punct' && separators.includes(item.value)) parts.push([]);
    else parts[parts.length - 1].push(item);
  }
  return parts.filter((part) => part.length > 0);
}

interface Property {
  key: string;
  pos: number;
  value: Node[];
  shorthand: boolean;
}

/** An object literal's properties, and the expressions it spreads. */
function properties(group: Group): { props: Property[]; spreads: Node[][] } {
  const props: Property[] = [];
  const spreads: Node[][] = [];
  for (const part of split(group.items, [',', ';'])) {
    const [first, second] = part;
    if (isPunct(first, '...')) {
      spreads.push(part.slice(1));
    } else if (first.type === 'id' || first.type === 'str') {
      if (isPunct(second, ':')) props.push({ key: first.value, pos: first.pos, value: part.slice(2), shorthand: false });
      else if (part.length === 1 && first.type === 'id') props.push({ key: first.value, pos: first.pos, value: part, shorthand: true });
    }
  }
  return { props, spreads };
}

/** Every `{…}` an expression builds, without looking inside another one. */
function objectsIn(nodes: Node[]): Group[] {
  return nodes.flatMap((node) => {
    if (!isGroup(node)) return [];
    return node.open === '{' ? [node] : objectsIn(node.items);
  });
}

/** Every token of `nodes`, groups included. */
function* tokensOf(nodes: Node[]): Generator<Token> {
  for (const node of nodes) {
    if (isGroup(node)) yield* tokensOf(node.items);
    else yield node;
  }
}

// ── The scan ────────────────────────────────────────────────────────────────────────────────────────────────────

const QUERY_METHODS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy',
  'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete',
  'deleteMany',
]);
/** The methods that hand back session rows, so a variable they fill holds session rows. */
const ROW_METHODS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow', 'create', 'createManyAndReturn',
  'update', 'updateManyAndReturn', 'upsert', 'delete',
]);
const ARGUMENT_KEYS = new Set(['where', 'data', 'create', 'update', 'select', 'omit', 'include', 'orderBy', 'distinct', 'by', 'cursor', 'having']);
const WRITE_KEYS = new Set(['data', 'create', 'update', 'createMany', 'updateMany', 'upsert', 'connectOrCreate']);
const READ_KEYS = new Set(['where', 'select', 'omit', 'include', 'orderBy', 'connect', 'disconnect', 'set', 'delete', 'deleteMany', 'cursor']);

/** The suffixes of the generated `Prisma.<Model><Suffix>` object types, with whether an object of one writes. */
const TYPE_SUFFIXES: Array<[RegExp, boolean]> = [
  [/^(Unchecked)?(Create|Update)(ManyMutation|ManyAndReturn|ManyData|Many)?[A-Za-z]*Input$/, true],
  [/^(Where|WhereUnique|ScalarWhere|ScalarWhereWithAggregates|OrderByWithRelation|OrderByWithAggregation|RelationFilter|ScalarRelationFilter|NullableScalarRelationFilter|ListRelationFilter)Input$/, false],
  [/^(Select|Include|Omit)(<[\s\S]*)?$/, false],
  [/^ScalarFieldEnum$/, false],
];

function prismaType(name: string, schema: Schema): { model: string; write: boolean } | null {
  // The longest model name that leaves a known suffix: `SessionTagSelect` is SessionTag's, not Session's.
  const models = [...schema.models.keys()].filter((m) => name.startsWith(m)).sort((a, b) => b.length - a.length);
  for (const model of models) {
    const suffix = TYPE_SUFFIXES.find(([pattern]) => pattern.test(name.slice(model.length)));
    if (suffix) return { model, write: suffix[1] };
  }
  return null;
}

/** The files where slots, claims and dispatch are decided: none of them may read `session.phase`. */
export function decidesSlots(file: string): boolean {
  return /(^|\/)(queue|runners|managed-runners)\//.test(file)
    || /(^|\/)common\/session-(tree-sql|scheduling)\.ts$/.test(file);
}

const STATUS_WORDS = new Set(['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
const SESSION_NAME = /(^s|S)ession$/;
const SESSION_LIST_NAME = /(^s|S)essions$/;
/** A status word only a session has, beside which a bare `<alias>.status` in an SQL fragment is the session's. */
const SESSION_ONLY_WORD = /^\s*(=|<>|!=|NOT\s+IN\s*\(|IN\s*\()\s*[^)]*'(AWAITING_INPUT|INTERRUPTED|SUCCEEDED)'/i;

class Scan {
  readonly hits: Hit[] = [];
  private readonly seen = new Set<string>();
  private readonly root: Group;
  private readonly lineStarts: number[] = [0];
  /** The local names this file gives the Prisma `RunStatus`. */
  private readonly enumNames = new Set<string>();
  /** The constants this file declares from a member of it, such as `const DISPATCHED = RunStatus.RUNNING`. */
  private readonly enumConstants = new Set<string>();

  constructor(
    private readonly code: string,
    private readonly schema: Schema,
    private readonly field: 'status' | 'phase',
  ) {
    for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) this.lineStarts.push(i + 1);
    this.root = tree(tokenize(code));
  }

  private lineOf(pos: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lineStarts[middle] <= pos) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  private hit(kind: HitKind, pos: number, how: string): void {
    const key = `${kind === 'read' || kind === 'write' ? 'access' : kind}:${pos}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.hits.push({ kind, line: this.lineOf(pos), how });
  }

  run(): Hit[] {
    this.imports();
    // The rooted readings go first: where two readings meet one position, the one that knows read from write wins.
    this.eachGroup(this.root, (group) => {
      this.queryCalls(group);
      this.typedObjects(group);
      this.bindings(group);
    });
    this.eachGroup(this.root, (group) => {
      this.propertyReads(group);
      this.enumValues(group);
      this.comparedWithTheEnum(group);
    });
    this.literals(this.root);
    return this.hits.sort((a, b) => a.line - b.line);
  }

  private eachGroup(group: Group, visit: (group: Group) => void): void {
    visit(group);
    for (const item of group.items) if (isGroup(item)) this.eachGroup(item, visit);
  }

  // ── The enum ──

  private imports(): void {
    for (const m of this.code.matchAll(/\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@prisma\/client['"]/g)) {
      const named = /(?<![\w$])(?:type\s+)?(RunStatus)(?:\s+as\s+([\w$]+))?(?![\w$])/.exec(m[1]);
      if (!named) continue;
      this.enumNames.add(named[2] ?? named[1]);
      this.hit('enum', m.index + m[0].indexOf(named[0]), 'RunStatus imported from @prisma/client');
    }
    for (const name of this.enumNames) {
      for (const m of this.code.matchAll(new RegExp(`\\bconst\\s+([\\w$]+)\\s*(?::[^=;]*)?=\\s*\\[?\\s*${name}\\s*\\.`, 'g'))) this.enumConstants.add(m[1]);
    }
    for (const m of this.code.matchAll(/(?:\$Enums|import\(\s*['"]@prisma\/client['"]\s*\))\s*\.\s*RunStatus\b/g)) {
      this.hit('enum', m.index, 'the Prisma RunStatus reached without an import');
    }
  }

  /** `status: RunStatus.RUNNING` and `status: heldStatusFilter()`: a session filter or write, wherever it is built. */
  private enumValues(group: Group): void {
    if (group.open !== '{' || this.field !== 'status') return;
    for (const prop of properties(group).props) {
      if (prop.key !== 'status' || prop.shorthand) continue;
      // A type annotation names the enum with no member; a value names a member or the held filter.
      const values = [...tokensOf(prop.value)];
      const member = values.some((t, i) => this.enumNames.has(t.value) && values[i + 1]?.value === '.');
      const named = values.some((t) => t.value === 'heldStatusFilter' || /SESSION_STATUSES$/.test(t.value) || this.enumConstants.has(t.value));
      if (member || named) this.hit('read', prop.pos, 'a status of the column\'s enum');
    }
  }

  /**
   * A row handed in by a caller, told by what its `status` is asked: `row.status === RunStatus.PENDING` with the
   * Prisma enum, or `OPEN_SESSION_STATUSES.includes(row.status)`. What a runner reports (`dto.status`, and the `input`
   * of runner-api/turn-outcome.ts) is the protocol's word, not the column (the plan's translation V).
   */
  private comparedWithTheEnum(group: Group): void {
    if (this.field !== 'status') return;
    const items = group.items;
    items.forEach((node, i) => {
      if (isId(node, 'status') && (isPunct(items[i - 1], '.') || isPunct(items[i - 1], '?.'))) {
        const operator = (items[i + 1] as Token | undefined)?.value ?? '';
        const reported = /^(dto|input)$/.test((items[i - 2] as Token | undefined)?.value ?? '');
        if (!reported && /^[!=]==?$/.test(operator) && this.enumNames.has((items[i + 2] as Token | undefined)?.value ?? '')) {
          this.hit('read', node.pos, 'compared with the column\'s enum');
        }
      }
      const call = items[i + 3];
      if (isId(node) && /SESSION_STATUSES$/.test((node as Token).value) && isId(items[i + 2], 'includes') && isGroup(call, '(')) {
        const last = call.items[call.items.length - 1];
        if (isId(last, 'status') && isPunct(call.items[call.items.length - 2], '.')) this.hit('read', last!.pos, 'asked of a held-status set');
      }
    });
  }

  // ── Prisma query arguments ──

  private queryCalls(group: Group): void {
    const items = group.items;
    for (let i = 2; i + 1 < items.length; i += 1) {
      const method = items[i];
      const call = items[i + 1];
      const delegate = items[i - 2];
      if (!isId(method) || !isPunct(items[i - 1], '.') && !isPunct(items[i - 1], '?.')) continue;
      if (!isGroup(call, '(') || delegate?.type !== 'id') continue;
      const name = (method as Token).value;
      const model = this.schema.delegates.get(delegate.value);
      if (!model || !QUERY_METHODS.has(name)) continue;
      if (!isPunct(items[i - 3], '.') && !isPunct(items[i - 3], '?.')) continue;
      const args = split(call.items)[0];
      if (!args) continue;
      for (const object of this.objectsOf(args, group)) this.arguments(object, model, name, group);
    }
  }

  /** The objects an expression builds, following a plain variable to the object it was declared with. */
  private objectsOf(nodes: Node[], scope: Group): Group[] {
    if (nodes.length === 1 && isId(nodes[0])) {
      const name = (nodes[0] as Token).value;
      for (let at: Group | null = scope; at; at = at.parent) {
        const items = at.items;
        const i = items.findIndex((n, j) => isId(n, name) && (isId(items[j - 1], 'const') || isId(items[j - 1], 'let')));
        if (i < 0) continue;
        const equals = items.findIndex((n, j) => j > i && isPunct(n, '='));
        const end = items.findIndex((n, j) => j > i && (isPunct(n, ';') || isId(n, 'const')));
        return equals > 0 && (end < 0 || equals < end) ? objectsIn(items.slice(equals + 1, end < 0 ? undefined : end)) : [];
      }
      return [];
    }
    return objectsIn(nodes);
  }

  private arguments(object: Group, model: string, method: string, scope: Group): void {
    const { props, spreads } = properties(object);
    for (const spread of spreads) for (const inner of this.objectsOf(spread, scope)) this.arguments(inner, model, method, scope);
    for (const prop of props) {
      if (!ARGUMENT_KEYS.has(prop.key)) continue;
      const write = ['data', 'create', 'update'].includes(prop.key) && !['findMany', 'count', 'groupBy'].includes(method);
      if (prop.key === 'distinct' || prop.key === 'by') {
        for (const token of tokensOf(prop.value)) {
          if (model === 'Session' && token.type === 'str' && token.value === this.field) this.hit('read', token.pos, `Prisma ${prop.key}`);
        }
        continue;
      }
      for (const inner of this.objectsOf(prop.value, scope)) this.walk(inner, model, write, `Prisma ${prop.key}`, scope);
      if (prop.value.length === 1 && isId(prop.value[0])) this.assignments(prop.value[0] as Token, model, write, scope);
    }
  }

  /** `where.status = …` on a variable that a session query takes as its argument. */
  private assignments(name: Token, model: string, write: boolean, scope: Group): void {
    if (model !== 'Session') return;
    let top = scope;
    while (top.parent && top.parent.parent) top = top.parent;
    this.eachGroup(top, (group) => {
      group.items.forEach((node, i) => {
        if (isId(node, name.value) && isPunct(group.items[i + 1], '.') && isId(group.items[i + 2], this.field)) {
          this.hit(write ? 'write' : 'read', (group.items[i + 2] as Token).pos, 'assigned on a session query argument');
        }
      });
    });
  }

  /** One object of the given model: its own `status`, and whatever its relations lead to. */
  private walk(object: Group, model: string, write: boolean, how: string, scope: Group): void {
    const fields = this.schema.models.get(model);
    const { props, spreads } = properties(object);
    for (const spread of spreads) for (const inner of this.objectsOf(spread, scope)) this.walk(inner, model, write, how, scope);
    for (const prop of props) {
      if (model === 'Session' && prop.key === this.field) {
        this.hit(write ? 'write' : 'read', prop.pos, how);
        if (write && this.field === 'status' && !props.some((p) => p.key === 'turnState')) {
          this.hit('alone', prop.pos, 'status written without turnState beside it');
        }
        continue;
      }
      const target = fields?.get(prop.key);
      // A scalar field's value is its own business (a JSON column may well hold a `status`).
      if (target === null) continue;
      const writes = WRITE_KEYS.has(prop.key) ? true : READ_KEYS.has(prop.key) ? false : write;
      const label = target === 'Session' ? `relation ${prop.key}` : how;
      for (const inner of this.objectsOf(prop.value, scope)) this.walk(inner, target ?? model, writes, label, scope);
    }
  }

  // ── Objects typed `Prisma.<Model>…`, and `Prisma.SessionScalarFieldEnum.status` ──

  private typedObjects(group: Group): void {
    const items = group.items;
    for (let i = 0; i + 2 < items.length; i += 1) {
      if (!isId(items[i], 'Prisma') || !isPunct(items[i + 1], '.') || !isId(items[i + 2])) continue;
      const type = prismaType((items[i + 2] as Token).value, this.schema);
      if (!type) continue;
      if ((items[i + 2] as Token).value.endsWith('ScalarFieldEnum')) {
        if (type.model === 'Session' && isPunct(items[i + 3], '.') && isId(items[i + 4], this.field)) {
          this.hit('read', (items[i + 4] as Token).pos, 'Prisma.SessionScalarFieldEnum');
        }
        continue;
      }
      for (const object of this.typedBy(group, i)) this.walk(object, type.model, type.write, `typed Prisma.${(items[i + 2] as Token).value}`, group);
    }
  }

  /** The objects the type named at `items[at]` describes: annotated, `satisfies`, `as`, or a return type. */
  private typedBy(group: Group, at: number): Group[] {
    const items = group.items;
    const before = items[at - 1];
    if (isId(before, 'satisfies') || isId(before, 'as')) {
      // Back to the start of the expression the clause closes.
      let start = at - 2;
      while (start >= 0 && !isPunct(items[start], '=') && !isPunct(items[start], ';') && !isPunct(items[start], ',')
        && !isPunct(items[start], ':') && !isId(items[start], 'return')) start -= 1;
      return objectsIn(items.slice(start + 1, at - 1));
    }
    if (!isPunct(before, ':')) return [];
    // After the type: array brackets and a generic's `<…>` may stand before the `=`, the `=>` or the body.
    let i = at + 3;
    let angle = 0;
    for (; i < items.length; i += 1) {
      const node = items[i];
      if (isPunct(node, '<')) angle += 1;
      else if (isPunct(node, '>')) angle -= 1;
      else if (angle > 0 || (isGroup(node, '[') && node.items.length === 0) || isPunct(node, '|') || isId(node, 'null') || isId(node, 'undefined')) continue;
      else break;
    }
    const next = items[i];
    const returnType = isGroup(items[at - 2], '(');
    if (isPunct(next, '=')) {
      const end = items.findIndex((n, j) => j > i && (isPunct(n, ';') || (isPunct(n, ',') && group.open !== '{')));
      const value = items.slice(i + 1, end < 0 ? undefined : end);
      return objectsIn(value);
    }
    if (isPunct(next, '=>') && returnType) {
      const body = items[i + 1];
      if (isGroup(body, '(')) return objectsIn(body.items);
      return isGroup(body, '{') ? returned(body) : [];
    }
    if (returnType && isGroup(next, '{')) return returned(next);
    return [];
  }

  // ── Properties read from session rows ──

  /** The variables of this block filled by a session query, and the reads of `status` from them. */
  private bindings(group: Group): void {
    const items = group.items;
    const bound = new Map<string, number>();
    for (let i = 0; i < items.length; i += 1) {
      if (!isId(items[i], 'const') && !isId(items[i], 'let')) continue;
      const target = items[i + 1];
      const end = items.findIndex((n, j) => j > i + 1 && (isPunct(n, ';') || isId(n, 'const') || isId(n, 'let')));
      const rest = items.slice(i + 2, end < 0 ? undefined : end);
      if (isId(target)) {
        if (queriesSessions(rest) || rest.some((n, j) => isId(n) && bound.has((n as Token).value) && isId(rest[j - 1], 'of'))) {
          bound.set((target as Token).value, target!.pos);
        }
      } else if (isGroup(target, '[')) {
        // `const [a, b] = await Promise.all([…])`: each name takes the element at its own position.
        const all = rest.find((n) => isGroup(n, '('));
        const list = isGroup(all) ? all.items.find((n) => isGroup(n, '[')) : undefined;
        if (!isGroup(list)) continue;
        const elements = split(list.items);
        split(target.items).forEach((name, at) => {
          if (elements[at] && queriesSessions(elements[at]) && isId(name[0])) bound.set((name[0] as Token).value, name[0].pos);
        });
      }
    }
    for (const [name, from] of bound) this.readsOf(group, name, from);
  }

  /** `name.status`, `name?.status`, `name[0].status`, `const { status } = name`, and the same on what maps over it. */
  private readsOf(scope: Group, name: string, from: number): void {
    this.eachGroup(scope, (group) => {
      const items = group.items;
      items.forEach((node, i) => {
        if (!isId(node, name) || node.pos < from) return;
        // `for (const row of name) …`: the rows one at a time, in the loop's body.
        if (group.open === '(' && isId(items[i - 1], 'of') && isId(items[i - 2]) && group.parent) {
          const body = group.parent.items[group.parent.items.indexOf(group) + 1];
          if (isGroup(body, '{')) this.readsOf(body, (items[i - 2] as Token).value, body.pos);
        }
        // `const some = name.filter(…)`, `= name[0]` and `= flag ? name.filter(…) : name` hold the same rows.
        const sameRows = items[i + 1] === undefined || isPunct(items[i + 1], ';') || isPunct(items[i + 1], ':') || isGroup(items[i + 1], '[')
          || (isPunct(items[i + 1], '.') && /^(filter|find|slice|sort)$/.test((items[i + 2] as Token | undefined)?.value ?? ''));
        const declared = declaredBefore(items, i);
        if (sameRows && declared && declared.value !== name) this.readsOf(group, declared.value, node.pos + name.length);
        let next = i + 1;
        while (isGroup(items[next], '[') || isPunct(items[next], '!')) next += 1;
        if (!isPunct(items[next], '.') && !isPunct(items[next], '?.')) return;
        const member = items[next + 1];
        if (isId(member, this.field)) this.access(group, next + 1, 'read from a session query\'s row');
        const callback = items[next + 2];
        if (isId(member) && ['map', 'filter', 'find', 'some', 'every', 'flatMap', 'forEach'].includes((member as Token).value) && isGroup(callback, '(')) {
          const arrow = callback.items.findIndex((n) => isPunct(n, '=>'));
          const head = callback.items[arrow - 1];
          const parameter = isGroup(head) ? head.items[0] : head;
          if (arrow > 0 && isId(parameter)) this.readsOf(callback, (parameter as Token).value, parameter!.pos);
        }
      });
      this.destructured(group, (value) => value === name);
    });
  }

  private propertyReads(group: Group): void {
    const items = group.items;
    items.forEach((node, i) => {
      const member = isId(node, this.field) && (isPunct(items[i - 1], '.') || isPunct(items[i - 1], '?.'));
      const indexed = isGroup(node, '[') && node.items.length === 1 && node.items[0].type === 'str'
        && (node.items[0] as Token).value === this.field;
      if (!member && !indexed) return;
      let at = member ? i - 2 : i - 1;
      let list = false;
      while (isGroup(items[at], '[') || isGroup(items[at], '(') || isPunct(items[at], '!')) {
        list ||= isGroup(items[at], '[');
        at -= 1;
      }
      const receiver = items[at];
      if (!isId(receiver)) return;
      const name = (receiver as Token).value;
      // Another thing called a session (a device sign-in) compares with a word `run_status` does not have.
      const compared = /^[!=]==?$/.test((items[i + 1] as Token | undefined)?.value ?? '') ? items[i + 2] : undefined;
      if (compared?.type === 'str' && !STATUS_WORDS.has(compared.value)) return;
      if (SESSION_NAME.test(name) || (list && SESSION_LIST_NAME.test(name))) this.access(group, i, `read from \`${name}\``);
    });
    this.destructured(group, (value) => SESSION_NAME.test(value));
  }

  /** `const { status } = <session>`. */
  private destructured(group: Group, isSession: (name: string) => boolean): void {
    group.items.forEach((node, i) => {
      if (!isGroup(node, '{') || !isPunct(group.items[i + 1], '=')) return;
      const source = group.items[i + 2];
      if (!isId(source) || !isSession((source as Token).value) || isPunct(group.items[i + 3], '.')) return;
      for (const prop of properties(node).props) {
        if (prop.key === this.field) this.hit('read', prop.pos, `destructured from \`${(source as Token).value}\``);
      }
    });
  }

  /** The access at `items[at]`: a write when something is assigned to it. */
  private access(group: Group, at: number, how: string): void {
    const write = isPunct(group.items[at + 1], '=');
    this.hit(write ? 'write' : 'read', group.items[at].pos, how);
  }

  // ── Raw SQL ──

  private literals(group: Group): void {
    for (const item of group.items) {
      if (isGroup(item)) this.literals(item);
      else if (item.type === 'str' || item.type === 'tpl') this.literal(item);
    }
  }

  private literal(token: Token): void {
    // The interpolations of a template are code of their own: read them, then blank them but for their length.
    let text = token.value;
    if (token.type === 'tpl') {
      for (let i = text.indexOf('${'); i >= 0; i = text.indexOf('${', i + 1)) {
        let depth = 1;
        let end = i + 2;
        while (end < text.length && depth > 0) {
          if (text[end] === '{') depth += 1;
          if (text[end] === '}') depth -= 1;
          end += 1;
        }
        const inner = tree(tokenize(this.code, token.pos + 1 + i + 2, token.pos + 1 + end - 1));
        this.eachGroup(inner, (g) => {
          this.queryCalls(g);
          this.propertyReads(g);
        });
        this.literals(inner);
        // An interpolation becomes `⟨name⟩`, padded to its length, so positions hold and its own text is not SQL.
        const name = /[A-Za-z_$][\w$]*(?=\W*$)|[Ss]ession[\w$]*/.exec(text.slice(i + 2, end - 1))?.[0] ?? '';
        const mark = `⟨${name.slice(0, end - i - 2)}`.padEnd(end - i - 1, ' ') + '⟩';
        text = text.slice(0, i) + mark + text.slice(end);
      }
    }
    this.sql(text, token.pos + 1);
  }

  private sql(text: string, base: number): void {
    const field = this.field;
    // SQL comments are not statements.
    const sql = text.replace(/--[^\n]*/g, (c) => ' '.repeat(c.length));
    const tables = [...sql.matchAll(/\b(FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?(?:"?public"?\.)?("?)([A-Za-z_⟨][\w⟩]*)\2(?:\s+(?:AS\s+)?([a-z_][\w]*))?/g)]
      // `IS DISTINCT FROM x` and `EXTRACT(… FROM x)` name no table.
      .filter((m) => !/(DISTINCT|EPOCH|SECOND|DAY)\s*$/i.test(sql.slice(0, m.index)));
    const ofSession = tables.filter((m) => m[3] === 'session');
    const aliases = new Set(ofSession.map((m) => m[4] ?? 'session'));
    const alone = ofSession.length > 0 && tables.every((m) => m[3] === 'session');
    const writes = this.sqlWrites(sql, ofSession);

    const seen = (at: number, how: string): void => {
      const write = writes.has(at);
      this.hit(write ? 'write' : 'read', base + at, how);
      if (write && field === 'status' && !/\bturn_state\b/.test(sql)) this.hit('alone', base + at, 'status written without turn_state beside it');
    };

    // The column list of an INSERT.
    for (const m of sql.matchAll(/\bINSERT\s+INTO\s+"?session"?\s*\(([^)]*)\)/g)) {
      const column = new RegExp(`(?<![\\w])"?${field}"?(?![\\w"])`).exec(m[1]);
      if (!column) continue;
      const at = base + m.index + m[0].indexOf(m[1]) + column.index;
      this.hit('write', at, 'raw SQL INSERT');
      if (field === 'status' && !/\bturn_state\b/.test(m[1])) this.hit('alone', at, 'status written without turn_state beside it');
    }
    for (const at of writes) seen(at, 'raw SQL SET');

    // `<alias>.status`, where the alias is this statement's session, an interpolated session name, or a fragment's
    // `session` / `s` beside a status word only a session has.
    for (const m of sql.matchAll(new RegExp(`(⟨[^⟩]*⟩|"session"|\\b[A-Za-z_]\\w*)\\.("${field}"|${field}\\b)`, 'g'))) {
      const alias = m[1].replace(/"/g, '');
      const at = m.index + m[0].length - m[2].length;
      const after = sql.slice(m.index + m[0].length);
      if (/^\s*(=|<>|IN\s*\()?\s*'?\w*'?\s*::\s*"?(task_status|"?runner_status)/i.test(after)) continue;
      const interpolatedSession = alias.startsWith('⟨') && /session/i.test(alias);
      const cast = /^\s*(::\s*text\b)?[^\n]{0,80}?::\s*"?run_status\b/.test(after) && !/\bAND\b|\bOR\b/.test(after.split('run_status')[0]);
      const fragment = ofSession.length === 0 && (alias === 's' || alias === 'session' || alias.startsWith('⟨'))
        && SESSION_ONLY_WORD.test(after);
      if (aliases.has(alias) || interpolatedSession || cast || fragment) seen(at, 'raw SQL');
    }
    // A bare `status` of a statement whose only table is session.
    if (alone) {
      for (const m of sql.matchAll(new RegExp(`(?<![\\w."'⟨:>-])("${field}"|${field}\\b)(?!['\\w⟩])`, 'g'))) {
        if (/\bAS\s+$/i.test(sql.slice(0, m.index))) continue;
        seen(m.index, 'raw SQL');
      }
    }
    // A cast to the column's type with no session column beside it.
    if (field === 'status') {
      for (const m of sql.matchAll(/::\s*"?run_status\b/g)) {
        const line = sql.slice(sql.lastIndexOf('\n', m.index) + 1, m.index);
        if (!/\bstatus\b/.test(line)) this.hit('read', base + m.index, 'cast to run_status');
      }
    }
  }

  /** Where in the text a session statement's SET list assigns the column. */
  private sqlWrites(sql: string, ofSession: RegExpMatchArray[]): Set<number> {
    const writes = new Set<number>();
    for (const table of ofSession.filter((m) => m[1] === 'UPDATE')) {
      const set = /\bSET\b/g;
      set.lastIndex = table.index! + table[0].length - (table[4]?.length ?? 0);
      const start = set.exec(sql);
      if (!start) continue;
      const rest = sql.slice(start.index + 3);
      const end = /\b(FROM|WHERE|RETURNING)\b/.exec(rest.replace(/\([^()]*\)/g, (g) => ' '.repeat(g.length)));
      const list = rest.slice(0, end?.index);
      for (const m of list.matchAll(new RegExp(`(^|,)\\s*("?[a-z_]*"?\\.)?("${this.field}"|${this.field}\\b)\\s*=`, 'g'))) {
        writes.add(start.index + 3 + m.index + m[0].lastIndexOf(m[3]));
      }
    }
    return writes;
  }
}

/** The name the statement holding `items[at]` declares, when `items[at]` is in its initializer. */
function declaredBefore(items: Node[], at: number): Token | null {
  for (let i = at - 1; i >= 0 && !isPunct(items[i], ';'); i -= 1) {
    if ((isId(items[i], 'const') || isId(items[i], 'let')) && isId(items[i + 1]) && isPunct(items[i + 2], '=')) return items[i + 1] as Token;
  }
  return null;
}

/** The objects a block returns. */
function returned(body: Group): Group[] {
  return body.items.flatMap((node, i) => {
    if (isGroup(node)) return node.open === '{' ? returned(node) : [];
    if (!isId(node, 'return')) return [];
    const end = body.items.findIndex((n, j) => j > i && isPunct(n, ';'));
    return objectsIn(body.items.slice(i + 1, end < 0 ? undefined : end));
  });
}

/** Whether the expression is a session query that hands back rows. */
function queriesSessions(nodes: Node[]): boolean {
  return nodes.some((node, i) => {
    if (isGroup(node)) return node.open === '(' && !isId(nodes[i - 1]) && queriesSessions(node.items);
    return node.type === 'id' && node.value === 'session' && isPunct(nodes[i - 1], '.') && isPunct(nodes[i + 1], '.')
      && ROW_METHODS.has((nodes[i + 2] as Token | undefined)?.value ?? '') && isGroup(nodes[i + 3], '(');
  });
}

/** Every use of `session.status` in one product file, and in a file that decides slots every use of `session.phase`. */
export function scanSessionStatus(file: string, text: string, schema: Schema): Hit[] {
  const code = stripComments(text);
  const hits = new Scan(code, schema, 'status').run();
  if (decidesSlots(file)) {
    for (const hit of new Scan(code, schema, 'phase').run()) {
      if (hit.kind === 'read' || hit.kind === 'write') hits.push({ ...hit, kind: 'phase' });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}
