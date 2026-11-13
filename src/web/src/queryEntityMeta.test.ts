import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * Every query in the web tree states which entities it is derived from, in `meta.entities`, or is
 * listed here as depending on none. The control plane's stream is only a nudge to re-read what a
 * view shows; until this declaration exists, whether an event finds a view was decided by whoever
 * remembered to add its key to a hand-kept whitelist in `useControlPlane.tsx` — and a view nobody
 * remembered (the project page's task tree, today) is silently never refreshed. This census makes
 * that omission red at the moment it is written, not after someone notices a stale page.
 *
 * WHAT IS A DEFINITION SITE
 *   A query options object handed to `useQuery`, `queryOptions`, `useQueries`, `useInfiniteQuery`
 *   or `infiniteQueryOptions`. The argument is followed through the shapes the tree uses to build
 *   one: an object literal, a reference to a local or imported factory, a factory call, a
 *   conditional, an array, and `xs.map(fn)` inside `useQueries`. A `useQuery(fooQuery(id))` site
 *   therefore resolves to `fooQuery`'s own options object and inherits its `meta`; the call site
 *   is not a second site and is not asked to repeat the declaration. A spread
 *   (`{ ...fooQuery(id), enabled }`) inherits too, by the same rule, and is satisfied only because
 *   `fooQuery`'s object is itself a site this census checks.
 *
 * WHY THE WHOLE OBJECT SET AND NOT A TEXT SEARCH
 *   `queryKey:` also appears in plain helper functions (`sharedRootQuery`, `read` in WelcomeCard)
 *   that are not wrapped in `queryOptions`. Those are where a query definition is easiest to
 *   forget, so the census resolves through them instead of only looking for the five call names.
 *   Comments and string literals cannot fake a site, because this reads the AST.
 *
 * ENTITY NAMES
 *   The names are the entities of the control-plane events `groupsFor` already routes on:
 *   `task.*` → task (incl. task.list.changed), `session.*` / `approval.*` / `background.task` /
 *   sessions.list_changed → session, `agent.changed` / `workspace.*` → workspace, `tag.*` → tag,
 *   `folder.*` → folder, `provider.*` → provider, `project.*` → project, `watch.*` → watch,
 *   `wiki.*` → wiki. A site names every entity whose change would make what it feeds wrong; one
 *   site may name several. The declaration says what the view derives from, not how often it is
 *   read: the consumer is free to keep its own cost exclusions (an expensive worktree diff is
 *   still session-derived even though the console refreshes it on turn end rather than on every
 *   session event).
 *
 * ADDING A QUERY
 *   Write `meta: { entities: ['<entity>'] }` in its options object. If it truly derives from no
 *   control-plane entity — a one-off configuration read, a runner-side probe — add it to EXEMPT
 *   with one sentence saying why. An entry in EXEMPT must still be a real site; a stale key here
 *   is a failure, not a leftover.
 */

const WEB_SRC = fileURLToPath(new URL('./', import.meta.url));

/** The control-plane entities, as `groupsFor` (lib/useControlPlane.tsx) groups its events. */
const ENTITIES = new Set(['task', 'session', 'project', 'workspace', 'tag', 'folder', 'provider', 'watch', 'wiki']);

/**
 * Sites that derive from no control-plane entity, with the reason. Frozen: every key must name a
 * site the census finds, and every listed site must be otherwise undeclared.
 */
const EXEMPT: Record<string, string> = {
  'src/components/AbandonedCheckouts.tsx#1': "runner-side abandoned-checkout state, announced by no control-plane event and polled by the runner page",
  'src/components/AbandonedCheckouts.tsx#2': "runner-side checkout diff, announced by no control-plane event",
  'src/components/CodexResetCredit.tsx#1': "runner-local codex reset operation list, announced by no control-plane event",
  'src/components/CodexResetCredit.tsx#2': "runner-local codex reset operation detail, announced by no control-plane event",
  'src/components/KeyImpact.tsx#1': "reads a provider key's upstream usage; no control-plane event announces it",
  'src/components/ProjectShareControls.tsx#1': "share-link tokens are written from this tab; no control-plane event announces them",
  'src/components/RunnerRegisterGuide.tsx#1': "runner state is polled; no control-plane event announces a runner change",
  'src/components/RunnerSignIn.tsx#2': "a runner's login state is polled; no control-plane event announces it",
  'src/components/ShareModal.tsx#1': "share-link tokens are written from this tab; no control-plane event announces them",
  'src/components/TaskDetailPanel.tsx#1': "share-link tokens are written from this tab; no control-plane event announces them",
  'src/components/TasksSidePanel.tsx#4': "runner state is polled; no control-plane event announces a runner change",
  'src/components/WikiShareButton.tsx#1': "share-link tokens are written from this tab; no control-plane event announces them",
  'src/components/WorkspaceConsole.tsx#2': "runner state is polled; no control-plane event announces a runner change",
  'src/components/settings/MachineSettingsPage.tsx#1': "runner state is polled; no control-plane event announces a runner change",
  'src/lib/deepseekBalance.ts#1': "reads a provider key's upstream balance; no control-plane event announces it",
  'src/lib/googleLink.ts#1': "sign-in configuration read once; no control-plane event announces it",
  'src/lib/managedRunner.ts#1': "server capabilities read once; no control-plane event announces them",
  'src/lib/managedRunner.ts#2': "the managed-runner status is polled; no control-plane event announces it",
  'src/lib/queries.ts#1': "runner state is polled; no control-plane event announces a runner change",
  'src/lib/queries.ts#2': "the published runner version, read from the release channel; no control-plane event announces it",
  'src/lib/queries.ts#3': "the one-time setup status; no control-plane event announces it",
  'src/lib/queries.ts#8': "the signed-in owner's own profile; no control-plane event announces it",
  'src/lib/queries.ts#9': "attachment storage usage; no control-plane event announces it",
  'src/lib/queries.ts#10': "the owner's avatar, versioned by the profile read; no control-plane event announces it",
  'src/lib/queries.ts#28': "account secrets are written from this tab; no control-plane event announces them",
  'src/lib/queries.ts#47': "share-link tokens are written from this tab; no control-plane event announces them",
  'src/lib/queries.ts#48': "access tokens are written from this tab; no control-plane event announces them",
  'src/lib/queries.ts#81': "link preview metadata read from the linked pages; no control-plane event announces it",
  'src/lib/useDirProbe.ts#1': "a runner filesystem probe; no control-plane event announces directory state",
  'src/pages/AdminEmailPage.tsx#1': "admin email settings are written from this tab; no control-plane event announces them",
  'src/pages/AdminIntegrationsPage.tsx#1': "admin integration settings are written from this tab; no control-plane event announces them",
  'src/pages/AdminSignInPage.tsx#1': "admin sign-in settings are written from this tab; no control-plane event announces them",
  'src/pages/AdminUsersPage.tsx#1': "a user's avatar, versioned by the user row; no control-plane event announces it",
  'src/pages/AdminUsersPage.tsx#2': "the admin user list; no control-plane event announces account creation",
  'src/pages/AdminUsersPage.tsx#4': "access tokens are written from this tab; no control-plane event announces them",
  'src/pages/FeishuConnectGroupPage.tsx#1': "Feishu chat routing is integration configuration; no control-plane event announces it",
  'src/pages/FeishuIntegrationPage.tsx#1': "Feishu integration settings are written from this tab; no control-plane event announces them",
};

/** Calls whose first argument is a query options object (useQueries names its queries property). */
const QUERY_CALLS = new Set(['useQuery', 'queryOptions', 'useQueries', 'useInfiniteQuery', 'infiniteQueryOptions']);

/** A file is read only when it could hold a query or an options factory. */
const MAYBE_A_QUERY = /useQuery|queryOptions|useQueries|useInfiniteQuery|infiniteQueryOptions|queryKey/;

type Node = { type: string; start: number; end: number; [key: string]: any };

interface Site {
  /** `path#n`: the nth query options object in this file, in source order. Stable under edits. */
  id: string;
  file: string;
  /** Source offset, used to tell two objects apart; not part of the identity a person reads. */
  start: number;
  line: number;
  callee: string;
  /** The query key's first literal, or the source of its first expression, for a readable failure. */
  key: string;
  entities: string[] | null;
  /** Whether a `meta` is present but malformed (not `{ entities: string[] }`). */
  badMeta: string | null;
  /** Whether at least one spread of the object resolves to a query options object (inherits it). */
  inherits: boolean;
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

function walk(node: unknown, visit: (node: Node) => void): void {
  if (!isNode(node)) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else walk(value, visit);
  }
}

const isFunction = (node: Node | undefined): boolean =>
  node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression' || node?.type === 'FunctionDeclaration';

/** Strips the wrappers a TS/ESTree parser puts around an expression that is only typed or asserted. */
function unwrap(node: unknown): Node | undefined {
  let current = isNode(node) ? node : undefined;
  while (
    current &&
    ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression', 'ChainExpression'].includes(
      current.type,
    )
  ) {
    current = isNode(current.expression) ? current.expression : undefined;
  }
  return current;
}

function propertyName(property: Node): string {
  const key = property.key;
  if (key?.type === 'Identifier') return key.name;
  if (key?.type === 'Literal') return String(key.value);
  return '';
}

/** The object's own `name` property, when it is a plain (non-spread) property. */
function property(object: Node, name: string): Node | undefined {
  return (object.properties ?? []).find((item: Node) => item.type === 'Property' && propertyName(item) === name);
}

/** `meta.entities` as declared, or what is wrong with it when a `meta` is present but malformed. */
function declaredEntities(object: Node): { entities: string[] | null; badMeta: string | null } {
  const meta = property(object, 'meta');
  if (!meta) return { entities: null, badMeta: null };
  const value = unwrap(meta.value);
  if (value?.type !== 'ObjectExpression') return { entities: null, badMeta: 'meta is not an object literal' };
  const entities = property(value, 'entities');
  const list = unwrap(entities?.value);
  if (!list || list.type !== 'ArrayExpression') return { entities: null, badMeta: 'meta.entities is not an array literal' };
  const elements: (Node | null)[] = list.elements ?? [];
  const names = elements.map((element) => (element?.type === 'Literal' && typeof element.value === 'string' ? element.value : null));
  if (names.some((name) => name === null)) return { entities: null, badMeta: 'meta.entities holds a non-string entry' };
  return { entities: names as string[], badMeta: null };
}

const lineOf = (text: string, node: Node): number => text.slice(0, node.start).split('\n').length;

/** The query key's first element, for a failure message a person can act on without an offset. */
function keyName(object: Node, text: string): string {
  const key = property(object, 'queryKey');
  const value = unwrap(key?.value);
  if (!value) return '';
  if (value.type === 'ArrayExpression') {
    const first = value.elements?.[0];
    if (first?.type === 'Literal') return String(first.value);
    if (first?.type === 'TemplateLiteral') return '`' + (first.quasis?.[0]?.value?.raw ?? '') + '`';
    if (first) return text.slice(first.start, Math.min(first.end, first.start + 40));
    return '[]';
  }
  return text.slice(value.start, Math.min(value.end, value.start + 40));
}

/** A value assigned to a name, with the file it was written in (it need not be the file named). */
interface Definition {
  node: Node;
  source: SourceFile;
}

interface SourceFile {
  file: string;
  /** Repo-relative, which is how a failure names the file. */
  rel: string;
  text: string;
  ast: Node | null;
  /** Every value assigned to a name in this file (an options factory is one of these). */
  defs: Map<string, Definition[]>;
  /** Local names imported here, mapped to the exported name they name. */
  imports: Map<string, string>;
}

function sourceFiles(): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  visit(WEB_SRC);
  return found.sort();
}

function readSources(): SourceFile[] {
  return sourceFiles().map((file) => {
    const text = readFileSync(file, 'utf8');
    const source: SourceFile = {
      file,
      rel: path.relative(path.dirname(WEB_SRC), file),
      text,
      ast: null,
      defs: new Map(),
      imports: new Map(),
    };
    if (!MAYBE_A_QUERY.test(text)) return source;
    source.ast = parseAst(text, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }, file) as unknown as Node;
    walk(source.ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
        const name = node.id.name;
        source.defs.set(name, [...(source.defs.get(name) ?? []), { node: node.init, source }]);
      } else if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') {
        const name = node.id.name;
        source.defs.set(name, [...(source.defs.get(name) ?? []), { node, source }]);
      } else if (node.type === 'ImportDeclaration') {
        for (const specifier of node.specifiers ?? []) {
          if (specifier.local?.type === 'Identifier') {
            const imported = specifier.imported?.type === 'Identifier' ? specifier.imported.name : specifier.local.name;
            source.imports.set(specifier.local.name, imported);
          }
        }
      }
    });
    return source;
  });
}

/**
 * A name's definitions: local first, then the export it is imported from. Following imports is
 * what lets `useQuery(sharedRootQuery(token))` resolve to the options object in SharedSessionPage
 * rather than escape as an unknown call.
 */
function lookup(name: string, from: SourceFile, sources: Map<string, SourceFile>): Definition[] {
  const local = from.defs.get(name);
  if (local?.length) return local;
  const exported = from.imports.get(name);
  if (!exported) return [];
  const found: Definition[] = [];
  for (const source of sources.values()) for (const definition of source.defs.get(exported) ?? []) found.push(definition);
  return found;
}

/**
 * The expressions a function body returns, without descending into functions nested inside it: a
 * factory written as `function foo() { …; return queryOptions({ … }); }` is one definition, and a
 * helper function declared in its body is not.
 */
function returnedExpressions(block: Node): unknown[] {
  const found: unknown[] = [];
  const visit = (node: unknown): void => {
    if (!isNode(node) || isFunction(node)) return;
    if (node.type === 'ReturnStatement') {
      if (node.argument) found.push(node.argument);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(block);
  return found;
}

interface Resolved {
  objects: { object: Node; source: SourceFile }[];
  unknown?: string;
}

/**
 * The query options objects an expression produces. A call to a factory resolves into that
 * factory's own object, so every definition is visited exactly once however many call sites use
 * it, and a caller inherits the factory's declaration.
 */
function resolve(expression: unknown, from: SourceFile, sources: Map<string, SourceFile>, depth = 0, seen = new Set<string>()): Resolved {
  const node = unwrap(expression);
  if (!node) return { objects: [], unknown: 'empty expression' };
  if (depth > 8) return { objects: [], unknown: 'expression nested too deeply' };
  if (node.type === 'ObjectExpression') return { objects: [{ object: node, source: from }] };
  if (node.type === 'BlockStatement') {
    const objects: Resolved['objects'] = [];
    for (const returned of returnedExpressions(node)) {
      const result = resolve(returned, from, sources, depth + 1, seen);
      if (result.unknown) return result;
      objects.push(...result.objects);
    }
    return objects.length ? { objects } : { objects: [], unknown: 'a function body that returns no query options' };
  }
  if (node.type === 'ArrayExpression') {
    const objects: Resolved['objects'] = [];
    for (const element of node.elements ?? []) {
      const result = resolve(element, from, sources, depth + 1, seen);
      if (result.unknown) return result;
      objects.push(...result.objects);
    }
    return { objects };
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const parts = node.type === 'ConditionalExpression' ? [node.consequent, node.alternate] : [node.left, node.right];
    const objects: Resolved['objects'] = [];
    for (const part of parts) {
      const result = resolve(part, from, sources, depth + 1, seen);
      if (result.unknown) return result;
      objects.push(...result.objects);
    }
    return { objects };
  }
  if (node.type === 'Identifier') {
    if (seen.has(node.name)) return { objects: [], unknown: `cycle through ${node.name}` };
    const definitions = lookup(node.name, from, sources);
    if (!definitions.length) return { objects: [], unknown: `unresolved identifier ${node.name}` };
    const objects: Resolved['objects'] = [];
    for (const definition of definitions) {
      const result = resolve(isFunction(definition.node) ? definition.node.body : definition.node, definition.source, sources, depth + 1, new Set([...seen, node.name]));
      if (result.unknown) return result;
      objects.push(...result.objects);
    }
    return { objects };
  }
  if (node.type === 'CallExpression') {
    const callee = node.callee;
    if (callee?.type === 'Identifier') {
      // `useQuery(queryOptions({ … }))` is an inline definition, not a factory reference.
      if (callee.name === 'queryOptions' || callee.name === 'infiniteQueryOptions') {
        return resolve(node.arguments?.[0], from, sources, depth + 1, seen);
      }
      const definitions = lookup(callee.name, from, sources);
      if (definitions.length) {
        const objects: Resolved['objects'] = [];
        for (const definition of definitions) {
          const result = resolve(isFunction(definition.node) ? definition.node.body : definition.node, definition.source, sources, depth + 1, new Set([...seen, callee.name]));
          if (result.unknown) return result;
          objects.push(...result.objects);
        }
        return { objects };
      }
      return { objects: [], unknown: `unresolved factory ${callee.name}` };
    }
    if (callee?.type === 'MemberExpression' && (callee.property?.name ?? callee.property?.value) === 'map' && node.arguments?.length) {
      const callback = unwrap(node.arguments[0]);
      if (callback && isFunction(callback)) return resolve(callback.body, from, sources, depth + 1, seen);
      if (callback && callback.type === 'Identifier') return resolve(callback, from, sources, depth + 1, seen);
      return { objects: [], unknown: 'map callback is not a function' };
    }
    return { objects: [], unknown: 'call with no options object in this tree' };
  }
  return { objects: [], unknown: `expression of type ${node.type}` };
}

function collectSites(): Site[] {
  const sources = new Map(readSources().map((source) => [source.file, source]));
  const sites: Site[] = [];
  for (const source of sources.values()) {
    if (!source.ast) continue;
    walk(source.ast, (node) => {
      if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier' || !QUERY_CALLS.has(node.callee.name)) return;
      const callee = node.callee.name;
      let collected: Resolved['objects'];
      if (callee === 'useQueries') {
        const options = unwrap(node.arguments?.[0]);
        if (options?.type !== 'ObjectExpression') {
          throw new Error(`${source.rel}:${lineOf(source.text, node)}: useQueries takes an object`);
        }
        const result = resolve(property(options, 'queries')?.value, source, sources);
        if (result.unknown) throw new Error(`${source.rel}:${lineOf(source.text, node)}: ${result.unknown}`);
        collected = result.objects;
      } else {
        const result = resolve(node.arguments?.[0], source, sources);
        if (result.unknown) throw new Error(`${source.rel}:${lineOf(source.text, node)}: ${result.unknown}`);
        collected = result.objects;
      }
      // Every object reached is a site: the options objects a call hands over, and (through the
      // worklist below) every object it inherits from by spreading a factory. Inheritance is only
      // a reason to leave a site undeclared if the object inherited from is itself checked here.
      const queue = [...collected];
      const visited = new Set<string>();
      while (queue.length) {
        const { object, source: owner } = queue.shift()!;
        const offset = `${owner.file}:${object.start}`;
        if (visited.has(offset)) continue;
        visited.add(offset);
        const { entities, badMeta } = declaredEntities(object);
        // A spread of a query options factory carries the factory's own declaration into this
        // object; the factory's object is a site of its own, so the inheritance is checked there.
        let inherits = false;
        for (const item of object.properties ?? []) {
          if (item.type !== 'SpreadElement') continue;
          const spread = resolve(item.argument, owner, sources);
          if (spread.objects.length) inherits = true;
          queue.push(...spread.objects);
        }
        sites.push({
          id: '',
          file: owner.rel,
          start: object.start,
          line: lineOf(owner.text, object),
          callee,
          key: keyName(object, owner.text),
          entities,
          badMeta,
          inherits,
        });
      }
    });
  }
  // The same options object can be reached through several factories and call sites; it is one
  // site. Ordinals count distinct objects in source order, so adding a `meta` line (or any other
  // property) never renumbers a later site.
  const seen = new Set<string>();
  const unique = sites.filter((site) => {
    const key = `${site.file}:${site.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1));
  let file = '';
  let ordinal = 0;
  for (const site of unique) {
    if (site.file !== file) {
      file = site.file;
      ordinal = 0;
    }
    ordinal += 1;
    site.id = `${site.file}#${ordinal}`;
  }
  return unique;
}

let cached: Site[] | null = null;
const sites = (): Site[] => (cached ??= collectSites());

describe('query entity meta', () => {
  it('declares meta.entities on every query, or lists it as depending on none', { timeout: 300_000 }, () => {
    const found = sites();
    // What a person needs to find a site that declared nothing — the assertion that fails first,
    // so a missing declaration reads as "this file, this line, this key" rather than an id.
    expect(found.filter((site) => !site.entities && !site.inherits && !(site.id in EXEMPT)).map((site) => `${site.id} (${site.file}:${site.line}) ${site.callee} ${site.key}`)).toEqual([]);
    // Declared, or inheriting a factory's declaration, or listed below as deriving from nothing.
    const covered = found.filter((site) => site.entities || site.inherits).map((site) => site.id);
    const exempt = Object.keys(EXEMPT);
    // Partition, not a count: every site is covered, and every exemption names a site that still
    // exists. Both lists are sorted, so an addition, a removal or a rename all show up.
    expect(found.map((site) => site.id).sort()).toEqual([...covered, ...exempt].sort());
    expect(Object.entries(EXEMPT).filter(([, reason]) => !reason.trim()).map(([id]) => id)).toEqual([]);
  });

  it('names only control-plane entities, and never an empty or repeated list', () => {
    const problems = sites().flatMap((site) => {
      if (site.badMeta) return [`${site.id}: ${site.badMeta}`];
      const names = site.entities;
      if (!names) return [];
      if (!names.length) return [`${site.id}: meta.entities is empty`];
      if (new Set(names).size !== names.length) return [`${site.id}: meta.entities repeats a name`];
      const unknown = names.filter((name) => !ENTITIES.has(name));
      return unknown.map((name) => `${site.id}: ${name} is not a control-plane entity`);
    });
    expect(problems).toEqual([]);
  });
});
