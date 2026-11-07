import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PushService } from '../push/push.service';
import { SessionsService } from '../sessions/sessions.service';
import { FEISHU_ALLOWED_ACTIONS, FEISHU_INFRASTRUCTURE } from './feishu-actions';

// The census of what a Feishu event may call (docs/feishu-bot-design.md §7.2, decision 1), pinned both ways, as
// pat-route-coverage.spec.ts pins the token routes:
//
//   (1) every allowlist entry names a method that exists on its service, once;
//   (2) every call the feishu module's sources make on an injected service — `this.<field>.<method>(` where the
//       constructor injects `<field>: <Class>` — is either on the module's own infrastructure or on the allowlist;
//   (3) the writes on it are exactly the ones §7.2 allows so far, each added by its task with §7.2's condition for it.

const FEISHU_DIR = path.resolve(__dirname, '../../src/feishu');

/** The classes the allowlist may name, by the name it uses. A later task adds the service it allows a method of. */
const SERVICES: Record<string, { prototype: object }> = { PushService, SessionsService };

/** Production sources of the feishu module: not specs, not the specs' fake. */
function sources(): Array<{ file: string; text: string }> {
  return readdirSync(FEISHU_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((file) => ({ file, text: readFileSync(path.join(FEISHU_DIR, file), 'utf8') }));
}

/** The parameter list of every constructor in a source: what Nest injects. */
function constructorParameters(text: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf('constructor('); at !== -1; at = text.indexOf('constructor(', at + 1)) {
    let depth = 0;
    for (let i = at + 'constructor'.length; i < text.length; i++) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && --depth === 0) {
        out.push(text.slice(at, i));
        break;
      }
    }
  }
  return out;
}

/** `Class.method` of every call on an injected service, by the field the constructor names it. */
function serviceCalls(text: string): string[] {
  const fields = new Map<string, string>();
  for (const params of constructorParameters(text)) {
    for (const m of params.matchAll(/(?:private|protected|public)\s+(?:readonly\s+)?(\w+)\??:\s*([A-Z]\w+)/g)) fields.set(m[1], m[2]);
  }
  const calls: string[] = [];
  for (const m of text.matchAll(/this\.(\w+)\.([\w$]+)\s*(?:<[^>]*>)?\s*[(`]/g)) {
    const owner = fields.get(m[1]);
    if (owner) calls.push(`${owner}.${m[2]}`);
  }
  return calls;
}

test('(1) every allowlisted method exists on its service, and is listed once', () => {
  const seen = new Set<string>();
  for (const action of FEISHU_ALLOWED_ACTIONS) {
    const key = `${action.service}.${action.method}`;
    assert.ok(!seen.has(key), `${key} is listed twice`);
    seen.add(key);
    const service = SERVICES[action.service];
    assert.ok(service, `${action.service} is not a service this census knows; add it to SERVICES`);
    assert.equal(typeof (service.prototype as Record<string, unknown>)[action.method], 'function', `${key} does not exist`);
    assert.ok(action.condition.trim() !== '', `${key} says when §7.2 allows it`);
  }
});

test('(2) the feishu module calls nothing on a service outside its infrastructure that the allowlist does not name', () => {
  const allowed = new Set(FEISHU_ALLOWED_ACTIONS.map((a) => `${a.service}.${a.method}`));
  const infrastructure = new Set<string>(FEISHU_INFRASTRUCTURE);
  const unlisted: string[] = [];
  let calls = 0;
  for (const { file, text } of sources()) {
    for (const call of serviceCalls(text)) {
      calls += 1;
      const [owner] = call.split('.');
      if (!infrastructure.has(owner) && !allowed.has(call)) unlisted.push(`${file}: ${call}`);
    }
  }
  assert.ok(calls > 0, 'the census found no service call at all: its reading of the sources is broken');
  assert.deepEqual(unlisted, [], 'a Feishu action calls a service method §7.2 does not allow; add it to FEISHU_ALLOWED_ACTIONS with its condition, or call it another way');
});

test('(2) the census reads a call it should refuse', () => {
  const sample = `class X { constructor(private readonly sessions: SessionsService, private readonly prisma: PrismaService) {}
    a() { return this.sessions.createTurn(1); } b() { return this.prisma.$queryRaw\`SELECT 1\`; } }`;
  assert.deepEqual(serviceCalls(sample), ['SessionsService.createTurn', 'PrismaService.$queryRaw']);
});

test('(3) the writes on the allowlist are the ones §7.2 allows so far', () => {
  assert.deepEqual(
    FEISHU_ALLOWED_ACTIONS.filter((a) => a.access !== 'READ').map((a) => `${a.service}.${a.method}`).sort(),
    // F2-3: reply to a session, open a session from the owner's direct messages.
    ['SessionsService.create', 'SessionsService.createTurn'],
  );
});
