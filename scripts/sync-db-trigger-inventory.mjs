#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = path.join(repo, 'src/apiserver/prisma/migrations');
const inventoryPath = path.join(repo, 'src/apiserver/src/common/db-write-inventory.ts');

function migrationSql() {
  return readdirSync(migrations).sort().flatMap((dir) => {
    try {
      return [{ dir, sql: readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8') }];
    } catch {
      return [];
    }
  });
}

function liveTriggers(files) {
  const live = new Map();
  for (const { dir, sql } of files) {
    for (const dropped of sql.matchAll(
      /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([a-z_0-9]+)"?\s+ON/gi,
    )) live.delete(dropped[1]);
    const created =
      /CREATE\s+(CONSTRAINT\s+)?TRIGGER\s+"?([a-z_0-9]+)"?\s+((?:BEFORE|AFTER|INSTEAD\s+OF)[\s\S]*?)\s+ON\s+"?([a-z_]+)"?[\s\S]*?EXECUTE\s+(?:PROCEDURE|FUNCTION)\s+"?([a-z_0-9]+)"?/gi;
    for (const match of sql.matchAll(created)) {
      live.set(match[2], {
        table: match[4],
        event: match[3].split(/\s+/).join(' '),
        kind: match[1] ? 'CONSTRAINT' : 'ROW/STATEMENT',
        since: dir,
        fn: match[5],
      });
    }
  }
  return live;
}

function functionBodies(files) {
  const bodies = new Map();
  for (const { sql } of files) {
    for (const match of sql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?([a-z_0-9]+)"?[\s\S]*?\$\$([\s\S]*?)\$\$/gi,
    )) bodies.set(match[1], match[2]);
  }
  return bodies;
}

function crossRelationEffects(fn, table, bodies, seen = new Set()) {
  const effects = new Set();
  const body = bodies.get(fn);
  if (!body || seen.has(fn)) return effects;
  seen.add(fn);
  for (const match of body.matchAll(/FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/gi)) {
    const before = body.slice(Math.max(0, match.index - 320), match.index);
    const from = [...before.matchAll(/FROM\s+"?([a-z_]+)"?/g)].map((candidate) => candidate[1]);
    const target = from[from.length - 1];
    if (target && target !== table) effects.add(`${target} LOCK`);
  }
  for (const match of body.matchAll(
    /INSERT\s+INTO\s+"?([a-z_]+)|UPDATE\s+"?([a-z_]+)"?\s+SET|DELETE\s+FROM\s+"?([a-z_]+)/gi,
  )) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target && target !== table) effects.add(`${target} WRITE`);
  }
  for (const match of body.matchAll(/(?:PERFORM|SELECT)\s+"?([a-z_0-9]+)"?\s*\(/gi)) {
    for (const nested of crossRelationEffects(match[1], table, bodies, seen)) effects.add(nested);
  }
  return effects;
}

function derive() {
  const files = migrationSql();
  const bodies = functionBodies(files);
  return [...liveTriggers(files)].map(([trigger, meta]) => ({
    table: meta.table,
    trigger,
    event: meta.event,
    kind: meta.kind,
    since: meta.since,
    takes: [...crossRelationEffects(meta.fn, meta.table, bodies)].sort(),
  })).sort((left, right) => left.table === right.table
    ? left.trigger.localeCompare(right.trigger)
    : left.table.localeCompare(right.table));
}

function render(entries) {
  return entries.map((entry) => `  ${JSON.stringify(entry)},`).join('\n');
}

const source = readFileSync(inventoryPath, 'utf8');
const startMarker = 'export const TRIGGER_WRITE_SOURCES: readonly TriggerWriteSource[] = [';
const start = source.indexOf(startMarker);
assert.notEqual(start, -1, 'trigger inventory start marker is missing');
const bodyStart = start + startMarker.length;
const end = source.indexOf('\n];', bodyStart);
assert.notEqual(end, -1, 'trigger inventory end marker is missing');
const expected = `\n${render(derive())}`;

if (process.argv.includes('--write')) {
  writeFileSync(inventoryPath, `${source.slice(0, bodyStart)}${expected}${source.slice(end)}`);
  console.log(`updated ${path.relative(repo, inventoryPath)}`);
} else {
  assert.equal(source.slice(bodyStart, end), expected,
    'db trigger inventory is stale; run node scripts/sync-db-trigger-inventory.mjs --write');
  console.log('db trigger inventory is current');
}
