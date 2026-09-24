import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * What keeps the list of doors that refuse the `watch:` turn-key prefix a list of those doors.
 *
 * A caller that names its own `clientTurnId` can take a key the Watch delivery worker is about to
 * queue a wake under, so every door that lets it name one calls `assertClientTurnIdNotReserved`
 * (sessions/watch-turn-key.ts) itself — the guard cannot sit in the service below the doors, which is
 * where the worker writes those keys from. contracts/watch.contract.json lists the doors in
 * `actions[RESUME_SESSION].idempotency.reservedPrefix` and docs/watch-contract.md §6 lists them again
 * in Chinese, and `POST /runner/projects/:id/coordinator/messages` called the guard from the commit
 * that opened it (25d8eb75e) without either list naming it. Here the doors are read out of the
 * controllers and held to both lists in both directions: a door that calls the guard and is not
 * listed fails, and so does a listed door that no handler guards.
 *
 * The scan is syntactic, as db-write-inventory.spec.ts's is and for the same reason. The rule it
 * reads a door by is written out at `doorOf`, and a call that rule cannot read fails the test instead
 * of dropping out of it: a door this scan skipped is exactly the door the lists would forget.
 */

// Resolved against the package root, not `__dirname`: this runs from `build/common`, and the subject
// is the TypeScript a reviewer reads, not the JavaScript it compiles to.
const SRC = path.resolve(__dirname, '../../src');
// From build/common back to the repository root.
const REPO = path.resolve(__dirname, '../../../..');

const GUARD = 'assertClientTurnIdNotReserved';
/** The guard's own file: the one place its name may be declared rather than imported or called. */
const GUARD_HOME = 'sessions/watch-turn-key.ts';

const CONTRACT = JSON.parse(readFileSync(path.join(REPO, 'contracts/watch.contract.json'), 'utf8'));

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, found);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * `source` twice over, both copies keeping every offset and line break: `code` with its comments
 * blanked, and `shape` with the inside of every string and template literal blanked as well. A route
 * path is read out of `code` and everything else out of `shape`, so neither a comment that quotes
 * `@Get(':id')` nor a message that names the guard is taken for code.
 */
function mask(rel: string, source: string): { code: string; shape: string } {
  const code = source.split('');
  const shape = source.split('');
  const blank = (copy: string[], from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (copy[k] !== '\n') copy[k] = ' ';
  };
  /** One past the quote that closes the literal opening at `start`, a template's `${…}` included. */
  const literalEnd = (start: number): number => {
    const quote = source[start];
    let i = start + 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') i += 2;
      else if (quote === '`' && source.startsWith('${', i)) i = expressionEnd(i + 2);
      else if (quote !== '`' && source[i] === '\n') {
        // What a quote inside a regex literal reads like. Refused rather than read on: the rest of the
        // file would be one long string, and a call in it no call at all.
        throw new Error(`${rel}:${lineAt(source, start)}: a string runs past the end of its line; this scan cannot read the file`);
      } else i += 1;
    }
    return i + 1;
  };
  /** One past the `}` that closes a template's `${`, whatever strings and braces sit inside it. */
  const expressionEnd = (start: number): number => {
    let depth = 0;
    let i = start;
    while (i < source.length) {
      const c = source[i];
      if (c === "'" || c === '"' || c === '`') {
        i = literalEnd(i);
        continue;
      }
      if (c === '}' && depth === 0) return i + 1;
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      i += 1;
    }
    return i;
  };
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i) || source.startsWith('/*', i)) {
      const block = source.startsWith('/*', i);
      const end = source.indexOf(block ? '*/' : '\n', i + 2);
      const stop = end === -1 ? source.length : block ? end + 2 : end;
      blank(code, i, stop);
      blank(shape, i, stop);
      i = stop;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const stop = literalEnd(i);
      blank(shape, i + 1, stop - 1);
      i = stop;
    } else {
      i += 1;
    }
  }
  return { code: code.join(''), shape: shape.join('') };
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/** The decorators Nest routes a request by. `@Headers(` is a parameter decorator and not one of them. */
const HTTP_METHOD = /^ {2}@(Get|Post|Put|Patch|Delete|Options|Head|All|Search)\s*\(/;
/** All of a route decorator this rule reads: on one line, its path a string literal or absent. */
const ROUTE = /^ {2}@\w+\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)\s*$/;
const CONTROLLER = /^@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)\s*$/;
const MEMBER = /^ {2}(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/;
const CLASS = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s/;

/**
 * The door the call of the guard on line `call` (0-based) belongs to: `METHOD /<controller>/<route>`.
 *
 * It is read by one rule, which leans on the layout every controller here is written in — class
 * members at two spaces, their bodies deeper — and throws, naming the call, wherever that does not
 * hold:
 *
 *   1. The call is a statement inside a method: indented deeper than the two spaces a member sits at.
 *   2. Every line above it is blank, indented deeper than two spaces, or a two-space line starting
 *      with `)` (the close of a wrapped parameter list, `) {` or `): Promise<…> {`) — the rest of the
 *      method body, the parameters with their `@Body()`/`@Param()`, and any comment, since comments
 *      are blanked before this runs — up to the member's own line: `  name(`, after any of `public`,
 *      `private`, `protected`, `static`, `async`.
 *   3. Directly above that line are its decorators: two-space `@` lines, one to a line, with only
 *      blank lines between them. Exactly one is a route — `@Get`, `@Post`, `@Put`, `@Patch`,
 *      `@Delete`, `@Options`, `@Head`, `@All` or `@Search` — with a string-literal path or none. With
 *      none the method is not a handler (a helper, the constructor), and the door is whichever
 *      handler calls it, which this rule cannot see.
 *   4. Further up, the first line at column 0 declares the class, and among the column-0 decorators
 *      directly above it is `@Controller()` or `@Controller('path')`.
 */
function doorOf(rel: string, code: string[], shape: string[], call: number): string {
  function unreadable(why: string): never {
    throw new Error(`${rel}:${call + 1} calls ${GUARD}, but ${why}: this scan reads a door only by the rule at doorOf`);
  }
  const indent = (line: number): number => shape[line].length - shape[line].trimStart().length;
  const blank = (line: number): boolean => shape[line].trim() === '';

  if (indent(call) <= 2) unreadable('not as a statement inside a method');

  let member = call - 1;
  while (member >= 0 && (blank(member) || indent(member) > 2 || /^ {2}\)/.test(shape[member]))) member -= 1;
  const declared = member >= 0 ? MEMBER.exec(shape[member]) : null;
  if (!declared) unreadable(`line ${member + 1}, where the method it sits in should be declared, is not \`  name(\``);

  const routes: Array<{ method: string; path: string }> = [];
  let top = member - 1;
  for (; top >= 0 && (blank(top) || shape[top].startsWith('  @')); top -= 1) {
    const method = HTTP_METHOD.exec(shape[top]);
    if (!method) continue;
    const route = ROUTE.exec(code[top]);
    if (!route) unreadable(`its route on line ${top + 1} is not \`@${method[1]}('path')\` on one line`);
    routes.push({ method: method[1].toUpperCase(), path: route[1] ?? route[2] ?? '' });
  }
  if (routes.length !== 1) {
    unreadable(
      routes.length === 0
        ? `\`${declared[1]}\` has no route decorator, so it is no handler and the door is whichever handler calls it — call the guard in the handler`
        : `\`${declared[1]}\` has ${routes.length} route decorators`,
    );
  }

  while (top >= 0 && (blank(top) || indent(top) > 0)) top -= 1;
  if (top < 0 || !CLASS.test(shape[top])) unreadable('the class it sits in is not declared at column 0');
  let controller: RegExpExecArray | null = null;
  for (let line = top - 1; line >= 0 && (blank(line) || shape[line].startsWith('@')); line -= 1) {
    if (!/^@Controller\b/.test(shape[line])) continue;
    controller = CONTROLLER.exec(code[line]);
    if (!controller) unreadable(`its class's @Controller on line ${line + 1} is not \`@Controller('path')\``);
  }
  if (!controller) unreadable('the class it sits in is not a @Controller');

  const joined = [controller[1] ?? controller[2] ?? '', routes[0].path].join('/').split('/').filter(Boolean);
  return `${routes[0].method} /${joined.join('/')}`;
}

interface Door {
  door: string;
  /** Where the guard is called: `file:line` under src/. */
  at: string;
}

/**
 * Every door that calls the guard. Every mention of the guard's name under src/ has to be its
 * declaration in its own file, an import of it under that same name, or a call in a controller that
 * `doorOf` reads; anything else — a call from a service, an alias, a callback, a re-export — would
 * guard a door this scan cannot name, and fails instead.
 */
function scan(): Door[] {
  const doors: Door[] = [];
  for (const file of sources(SRC).sort()) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(GUARD)) continue;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const masked = mask(rel, source);
    const code = masked.code.split('\n');
    const shape = masked.shape.split('\n');
    let mentioned = 0;
    shape.forEach((line, index) => {
      for (const mention of line.matchAll(new RegExp(`\\b${GUARD}\\b`, 'g'))) {
        const before = line.slice(0, mention.index!);
        const after = line.slice(mention.index! + GUARD.length);
        if (rel === GUARD_HOME && /\bfunction\s+$/.test(before)) continue;
        assert.doesNotMatch(after, /^\s+as\b/, `${rel}:${index + 1} imports ${GUARD} under another name, and the calls it makes under that one are calls this scan cannot see`);
        if (!/^\s*\(/.test(after)) {
          mentioned += 1;
          continue;
        }
        assert.ok(rel.endsWith('.controller.ts'), `${rel}:${index + 1} calls ${GUARD} outside a controller, so no route says which door it guards: call it in the handler`);
        doors.push({ door: doorOf(rel, code, shape, index), at: `${rel}:${index + 1}` });
      }
    });
    let imported = 0;
    for (const [, names] of masked.code.matchAll(/^import\s*\{([^}]*)\}\s*from\b/gm)) {
      imported += names.split(',').filter((name) => name.trim() === GUARD).length;
    }
    assert.equal(mentioned, imported, `${rel} names ${GUARD} ${mentioned - imported} time(s) without importing or calling it — a callback or a re-export guards a door this scan cannot name`);
  }
  assert.ok(doors.length > 0, `nothing under src/ calls ${GUARD}: if it was renamed or moved, this scan has to follow it`);
  return doors;
}

/** The doors a list names: every `METHOD /path` in it, less the `/api` every route is served under. */
function named(list: string): Set<string> {
  const doors = new Set<string>();
  for (const [, method, route] of list.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ALL|SEARCH) (\/[\w:/-]*)/g)) {
    doors.add(`${method} ${route.replace(/^\/api(?=\/)/, '')}`);
  }
  return doors;
}

/** Holds a list to the doors both ways: each one named, and nothing named that is not one. */
function assertNamesExactly(where: string, list: string, doors: Door[]): void {
  const listed = named(list);
  for (const { door, at } of doors) {
    assert.ok(
      listed.has(door),
      `${at} makes ${door} refuse the watch: prefix, but ${where} does not name it. Add it there as \`${door}\` (the /api prefix may be written or left off), with who travels through it`,
    );
  }
  const guarded = new Set(doors.map(({ door }) => door));
  for (const door of listed) {
    assert.ok(
      guarded.has(door),
      `${where} names ${door}, but no handler of that route calls ${GUARD}: take it out of the list, or put the guard back in the handler`,
    );
  }
}

test("contracts/watch.contract.json's reservedPrefix names every door that refuses the watch: prefix, and no other", () => {
  const resume = CONTRACT.actions.find((action: { kind: string }) => action.kind === 'RESUME_SESSION');
  const list = resume?.idempotency?.reservedPrefix;
  assert.equal(typeof list, 'string', 'the contract no longer has actions[RESUME_SESSION].idempotency.reservedPrefix');
  assertNamesExactly("contracts/watch.contract.json's reservedPrefix", list, scan());
});

test('docs/watch-contract.md §6 lists the same doors', () => {
  const doc = readFileSync(path.join(REPO, CONTRACT.doc), 'utf8');
  const start = doc.indexOf('- **`watch:` 是保留前缀');
  assert.ok(start >= 0, `${CONTRACT.doc} no longer has the bullet that begins "- **\`watch:\` 是保留前缀"`);
  const end = doc.indexOf('\n- ', start);
  assertNamesExactly(`the reserved-prefix bullet of ${CONTRACT.doc} §6`, doc.slice(start, end === -1 ? undefined : end), scan());
});
