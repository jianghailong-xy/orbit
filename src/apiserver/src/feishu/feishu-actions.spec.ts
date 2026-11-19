import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PushService } from '../push/push.service';
import { SessionsService } from '../sessions/sessions.service';
import { FEISHU_ACTIONS, FEISHU_ALLOWED_ACTIONS, FEISHU_INFRASTRUCTURE } from './feishu-actions';
import { classify } from './feishu-router';

// The census of what a Feishu event may call (docs/feishu-bot-design.md §7.2, decision 1), pinned both ways, as
// pat-route-coverage.spec.ts pins the token routes:
//
//   (1) every allowlist entry names a method that exists on its service, once;
//   (2) every call the feishu module's sources make on an injected service — `this.<field>.<method>(` where the
//       constructor injects `<field>: <Class>` — is either on the module's own infrastructure or on the allowlist;
//   (3) the writes on it are exactly the ones §7.2 allows, each added by its task with §7.2's condition for it;
//   (4) FEISHU_ACTIONS, every action a Feishu event can take (F3-6), against the allowlist, the code and the router:
//       each action's calls are allowlisted and each allowlisted method is some action's; each handler exists and the
//       router reaches it; a source's allowlisted calls are exactly those of the actions it handles; every branch the
//       router classifies an event into has an action;
//   (5) FEISHU_ACTIONS against feishu-isolation.pg.spec.ts: a cross-account case for every action, none for another.

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

test('(3) the writes on the allowlist are the ones §7.2 allows', () => {
  assert.deepEqual(
    FEISHU_ALLOWED_ACTIONS.filter((a) => a.access !== 'READ').map((a) => `${a.service}.${a.method}`).sort(),
    // F2-3: reply to a session, open a session from the owner's direct messages. F2-1: answer a tool approval on its card.
    ['SessionsService.create', 'SessionsService.createTurn', 'SessionsService.decideApproval'],
  );
});

test('(3) decideApproval is called, and only from the card actions', () => {
  const callers = sources().filter(({ text }) => serviceCalls(text).includes('SessionsService.decideApproval')).map(({ file }) => file);
  assert.deepEqual(callers, ['feishu-card-actions.ts']);
});

test('(4) every action calls only allowlisted methods, and every allowlisted method is some action\'s', () => {
  const allowed = new Set(FEISHU_ALLOWED_ACTIONS.map((a) => `${a.service}.${a.method}`));
  const keys = new Set<string>();
  for (const action of FEISHU_ACTIONS) {
    assert.ok(!keys.has(action.key), `${action.key} is listed twice`);
    keys.add(action.key);
    assert.ok(action.scope.trim() !== '', `${action.key} says how it is held to the app's account`);
    for (const call of action.calls) assert.ok(allowed.has(call), `${action.key} calls ${call}, which is not allowlisted`);
  }
  const used = new Set(FEISHU_ACTIONS.flatMap((a) => a.calls));
  assert.deepEqual([...allowed].filter((c) => !used.has(c)), [], 'an allowlisted method no action calls');
});

test('(4) every handler exists, and the router reaches every event handler', () => {
  const byFile = new Map(sources().map(({ file, text }) => [file, text]));
  const router = byFile.get('feishu-router.ts')!;
  for (const action of FEISHU_ACTIONS) {
    const [file, method] = action.handler.split('#');
    const text = byFile.get(file!);
    assert.ok(text, `${action.key}: ${file} is not a source of the feishu module`);
    assert.match(text, new RegExp(`\\basync ${method}\\(`), `${action.key}: ${action.handler} does not exist`);
    if (action.route !== 'SETTINGS') assert.ok(router.includes(`.${method}(`), `${action.key}: the router never calls ${method}`);
  }
});

test('(4) the allowlisted calls each source makes are exactly those of the actions it handles', () => {
  const allowed = new Set(FEISHU_ALLOWED_ACTIONS.map((a) => `${a.service}.${a.method}`));
  for (const { file, text } of sources()) {
    const made = [...new Set(serviceCalls(text).filter((c) => allowed.has(c)))].sort();
    const listed = [...new Set(FEISHU_ACTIONS.filter((a) => a.handler.startsWith(`${file}#`)).flatMap((a) => a.calls))].sort();
    assert.deepEqual(made, listed, `${file}: the allowlisted calls it makes, against the actions FEISHU_ACTIONS gives it`);
  }
});

test('(4) every branch the router sends an event down has an action', () => {
  const samples: Array<[string, unknown]> = [
    ['im.message.receive_v1', { event: { message: { chat_type: 'p2p' } } }],
    ['im.message.receive_v1', { event: { message: { chat_type: 'group' } } }],
    ['card.action.trigger', { event: {} }],
    ['im.chat.member.bot.deleted_v1', { event: {} }],
  ];
  const routes = new Set(samples.map(([type, payload]) => classify(type, payload).route));
  const covered = new Set<string>(FEISHU_ACTIONS.map((a) => a.route));
  for (const route of routes) assert.ok(covered.has(route), `no action for ${route}`);
  assert.equal(classify('anything.else', {}).route, 'IGNORED', 'any other event is recorded and never acted on');
});

test('(5) feishu-isolation.pg.spec.ts holds every action, and only those, to the app\'s own account', () => {
  const spec = readFileSync(path.join(FEISHU_DIR, 'feishu-isolation.pg.spec.ts'), 'utf8');
  const cases = new Set([...spec.matchAll(/\[isolation:([a-z-]+)\]/g)].map((m) => m[1]!));
  assert.deepEqual([...cases].sort(), FEISHU_ACTIONS.map((a) => a.key).sort());
});
