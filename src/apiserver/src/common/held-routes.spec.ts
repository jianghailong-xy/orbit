import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { HELD_ROUTES, isHeldRoute } from './held-routes';

/**
 * The held routes are the controllers' own: every `@Sse` route the API has is in HELD_ROUTES, and every entry there is a
 * route some controller declares. A new stream that is not added would be timed by the request histogram and the
 * slow-request line for as long as somebody watches it; an entry whose route was renamed would keep nothing out.
 */

const SRC = path.resolve(__dirname, '../../src');

function controllers(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllers(file);
    return entry.name.endsWith('.controller.ts') ? [file] : [];
  });
}

/** `/api` + the class's `@Controller` prefix + the method's path, as Express names the matched route. */
function join(prefix: string, route: string): string {
  return `/api/${[prefix, route].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '');
}

/** Every route a decorator in `names` declares, with the prefix of the nearest `@Controller` above it. */
function declared(names: string): string[] {
  const found: string[] = [];
  const decorator = new RegExp(`@(Controller|${names})\\(\\s*(?:'([^']*)')?`, 'g');
  for (const file of controllers(SRC)) {
    let prefix = '';
    for (const match of readFileSync(file, 'utf8').matchAll(decorator)) {
      if (match[1] === 'Controller') prefix = match[2] ?? '';
      else found.push(join(prefix, match[2] ?? ''));
    }
  }
  return found;
}

test('every SSE route the controllers declare holds, and is kept out', () => {
  const streams = declared('Sse');
  assert.ok(streams.length >= 5, `the scan found ${streams.length} SSE routes; it is reading the controllers wrong`);
  for (const route of streams) {
    assert.ok(HELD_ROUTES.has(route), `${route} is an SSE route and is not in HELD_ROUTES (common/held-routes.ts)`);
  }
});

test('every held route is one a controller declares', () => {
  const routes = new Set(declared('Get|Post|Put|Patch|Delete|All|Sse'));
  for (const route of HELD_ROUTES) {
    assert.ok(routes.has(route), `${route} is in HELD_ROUTES and no controller declares it`);
  }
});

test('the model gateways are held under any path, and nothing else under their names is', () => {
  assert.ok(isHeldRoute('/api/gw/codex'));
  assert.ok(isHeldRoute('/api/gw/codex/{*path}'));
  assert.ok(isHeldRoute('/api/gw/anthropic/{*path}'));
  assert.equal(isHeldRoute('/api/sessions/:id'), false);
  assert.equal(isHeldRoute('/api/runner/sessions/:id/approvals/:approvalId/decision'), false);
  assert.equal(isHeldRoute('/api/gwx'), false);
});
