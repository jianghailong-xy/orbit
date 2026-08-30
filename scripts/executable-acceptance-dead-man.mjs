#!/usr/bin/env node
/**
 * External dead-man for the executable runtime workers.
 *
 * Deployment appends an expected component generation before starting the process. This program
 * then reads that expectation and PostgreSQL-ingested heartbeats directly, so "never started" is
 * observable and neither the worker nor the projection it checks can pronounce itself healthy.
 * The legacy heartbeat-only path remains for rows deployed before the expectation ledger existed.
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
const generation = option('generation') ?? null;
const checkedAt = new Date(option('now') ?? Date.now());
const registerExpectation = process.argv.includes('--register-expectation');

assert.ok(databaseUrl, '--database-url or DATABASE_URL is required');
assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/, '--source-sha must be a full lowercase git SHA');
assert.ok(Number.isFinite(checkedAt.getTime()), '--now must be an ISO timestamp');

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  if (registerExpectation) {
    const expectedSourceSha = option('expected-source-sha');
    const moduleGraphDigest = option('module-graph-digest');
    const startupGraceSeconds = Number(option('startup-grace-seconds') ?? 60);
    const idempotencyKey = option('idempotency-key')
      ?? `runtime-expectation:${component}:${instanceId}:${generation}`;
    assert.ok(instanceId, '--instance-id is required to register an expectation');
    assert.match(generation ?? '', /^[0-9a-f-]{36}$/i, '--generation must be a UUID');
    assert.match(
      expectedSourceSha ?? '', /^[0-9a-f]{40}$/,
      '--expected-source-sha must be a full lowercase git SHA',
    );
    assert.match(
      moduleGraphDigest ?? '', /^[0-9a-f]{64}$/,
      '--module-graph-digest must be a SHA-256 digest',
    );
    assert.ok(
      Number.isInteger(startupGraceSeconds) && startupGraceSeconds >= 1
        && startupGraceSeconds <= 3600,
      '--startup-grace-seconds must be an integer from 1 to 3600',
    );
    const registered = await client.query(`
      SELECT executable_runtime_expect_generation(
        $1::text, $2::text, $3::uuid, $4::text, $5::text,
        $6::integer, $7::text, $8::jsonb
      ) AS result
    `, [
      component,
      instanceId,
      generation,
      expectedSourceSha,
      moduleGraphDigest,
      startupGraceSeconds,
      idempotencyKey,
      JSON.stringify({ source: 'DEPLOYMENT_CONTROLLER', deadManSourceSha: sourceSha }),
    ]);
    process.stdout.write(`${JSON.stringify(registered.rows[0].result)}\n`);
  } else {
    const expected = await client.query(`
      SELECT expected.component, expected.instance_id, expected.generation,
             expected.expectation_digest, expected.startup_deadline_at,
             expected.heartbeat_digest, expected.observed_at, expected.deadline_at,
             expected.heartbeat_ingested_at, expected.last_event_kind,
             event.checked_at AS last_event_checked_at
        FROM executable_runtime_expected_liveness expected
        LEFT JOIN LATERAL (
          SELECT candidate.checked_at
            FROM executable_dead_man_event candidate
           WHERE candidate.expectation_generation = expected.generation
           ORDER BY candidate.checked_at DESC, candidate.created_at DESC, candidate.id DESC
           LIMIT 1
        ) event ON true
       WHERE component = $1
         AND ($2::text IS NULL OR instance_id = $2)
         AND ($3::uuid IS NULL OR generation = $3)
       ORDER BY instance_id, generation
    `, [component, instanceId, generation]);

    if (expected.rowCount > 0) {
      const summary = {
        checked: expected.rowCount,
        starting: 0,
        missing: 0,
        stale: 0,
        recovered: 0,
        events: [],
      };
      for (const row of expected.rows) {
        let kind = null;
        let heartbeatDigest = row.heartbeat_digest;
        const hasHeartbeat = heartbeatDigest !== null;
        const heartbeatExpired = hasHeartbeat
          && checkedAt.getTime() > new Date(row.deadline_at).getTime();
        const priorFailureStillCurrent = hasHeartbeat
          && ['WATCHDOG_STALE', 'WATCHDOG_MISSING'].includes(row.last_event_kind)
          && new Date(row.last_event_checked_at).getTime()
            >= new Date(row.heartbeat_ingested_at).getTime();
        const starting = !hasHeartbeat
          && checkedAt.getTime() <= new Date(row.startup_deadline_at).getTime();
        if (starting) {
          summary.starting += 1;
          continue;
        }
        if (!hasHeartbeat) {
          summary.missing += 1;
          kind = row.last_event_kind === 'WATCHDOG_MISSING' ? null : 'WATCHDOG_MISSING';
          heartbeatDigest = null;
        } else if (heartbeatExpired || priorFailureStillCurrent) {
          summary.stale += 1;
          kind = priorFailureStillCurrent ? null : 'WATCHDOG_STALE';
        } else if (['WATCHDOG_STALE', 'WATCHDOG_MISSING'].includes(row.last_event_kind)) {
          kind = 'WATCHDOG_RECOVERED';
        }
        if (!kind) continue;
        const observationKey = kind === 'WATCHDOG_MISSING'
          ? `runtime-expectation:${row.generation}:missing`
          : `runtime-expectation:${row.generation}:${kind.toLowerCase()}:${heartbeatDigest}`;
        const inserted = await client.query(`
          SELECT executable_runtime_record_expectation_observation(
            $1::text, $2::text, $3::uuid, $4::text,
            $5::text, $6::text, $7::text
          ) AS result
        `, [
          row.component,
          row.instance_id,
          row.generation,
          kind,
          heartbeatDigest,
          sourceSha,
          observationKey,
        ]);
        const result = inserted.rows[0].result;
        summary.events.push({
          instanceId: row.instance_id,
          generation: row.generation,
          kind,
          eventId: result.eventId,
          replayed: result.replayed,
        });
        if (kind === 'WATCHDOG_RECOVERED') summary.recovered += 1;
      }
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      // Rolling compatibility for heartbeat rows emitted before expectations were introduced.
      const latest = await client.query(`
        WITH heartbeat AS (
          SELECT DISTINCT ON (h.component, h.instance_id)
                 h.component, h.instance_id, h.heartbeat_digest, h.observed_at, h.deadline_at
            FROM executable_runtime_heartbeat h
           WHERE h.component = $1
             AND h.expectation_generation IS NULL
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
               AND e.expectation_generation IS NULL
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
              'component', $2::text, 'instanceId', $3::text, 'kind', $4::text,
              'heartbeatDigest', $5::text, 'checkedAt', $6::timestamptz,
              'deadlineAt', $7::timestamptz, 'sourceSha', $8::text
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
    }
  }
} finally {
  await client.end();
}
