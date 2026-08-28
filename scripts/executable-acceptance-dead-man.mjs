#!/usr/bin/env node
/**
 * External dead-man for the executable runtime watchdog.
 *
 * This executable deliberately depends only on PostgreSQL and Node built-ins. It reads the
 * append-only heartbeat ledger directly, never an application projection or worker service, and
 * appends a state transition only when the independently checked deadline changes state.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

function option(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const databaseUrl = option('database-url') ?? process.env.DATABASE_URL;
const sourceSha = option('source-sha') ?? process.env.EXECUTABLE_DEAD_MAN_SOURCE_SHA;
const component = option('component') ?? 'outcome-watchdog';
const instanceId = option('instance-id') ?? null;
const checkedAt = new Date(option('now') ?? Date.now());

assert.ok(databaseUrl, '--database-url or DATABASE_URL is required');
assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/, '--source-sha must be a full lowercase git SHA');
assert.ok(Number.isFinite(checkedAt.getTime()), '--now must be an ISO timestamp');

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const latest = await client.query(`
    WITH heartbeat AS (
      SELECT DISTINCT ON (h.component, h.instance_id)
             h.component, h.instance_id, h.heartbeat_digest, h.observed_at, h.deadline_at
        FROM executable_runtime_heartbeat h
       WHERE h.component = $1
         AND ($2::text IS NULL OR h.instance_id = $2)
       ORDER BY h.component, h.instance_id, h.sequence DESC
    )
    SELECT h.*,
           event.kind AS last_event_kind,
           event.heartbeat_digest AS last_event_heartbeat_digest,
           event.checked_at AS last_event_checked_at
      FROM heartbeat h
      LEFT JOIN LATERAL (
        SELECT e.kind, e.heartbeat_digest, e.checked_at
          FROM executable_dead_man_event e
         WHERE e.component = h.component AND e.instance_id = h.instance_id
         ORDER BY e.checked_at DESC, e.created_at DESC LIMIT 1
      ) event ON true
     ORDER BY h.instance_id
  `, [component, instanceId]);

  const summary = { checked: latest.rowCount, stale: 0, recovered: 0, events: [] };
  for (const row of latest.rows) {
    const stale = checkedAt.getTime() > new Date(row.deadline_at).getTime();
    const alreadyStale = row.last_event_kind === 'WATCHDOG_STALE'
      && row.last_event_heartbeat_digest === row.heartbeat_digest;
    const needsRecovery = !stale && row.last_event_kind === 'WATCHDOG_STALE';
    const kind = stale && !alreadyStale
      ? 'WATCHDOG_STALE'
      : needsRecovery
        ? 'WATCHDOG_RECOVERED'
        : null;
    if (stale) summary.stale += 1;
    if (!kind) continue;

    const inserted = await client.query(`
      WITH material AS (
        SELECT jsonb_build_object(
          'component', $2::text,
          'instanceId', $3::text,
          'kind', $4::text,
          'heartbeatDigest', $5::text,
          'checkedAt', $6::timestamptz,
          'deadlineAt', $7::timestamptz,
          'sourceSha', $8::text
        ) AS binding
      )
      INSERT INTO executable_dead_man_event
        (id, component, instance_id, kind, heartbeat_digest, checked_at, deadline_at,
         source_sha, event_digest)
      SELECT $1::uuid, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8,
             encode(digest(material.binding::text, 'sha256'), 'hex')
        FROM material
      ON CONFLICT (event_digest) DO NOTHING
      RETURNING id, event_digest
    `, [
      randomUUID(), row.component, row.instance_id, kind, row.heartbeat_digest,
      checkedAt.toISOString(), row.deadline_at, sourceSha,
    ]);
    if (inserted.rowCount === 1) {
      summary.events.push({
        instanceId: row.instance_id,
        kind,
        eventDigest: inserted.rows[0].event_digest,
      });
      if (kind === 'WATCHDOG_RECOVERED') summary.recovered += 1;
    }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  await client.end();
}
