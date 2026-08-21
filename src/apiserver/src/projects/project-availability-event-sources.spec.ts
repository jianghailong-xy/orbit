import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const migration = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0118_project_availability_event_sources/migration.sql'),
  'utf8',
);
const reaper = readFileSync(
  path.resolve(__dirname, '../../src/projects/project-availability-reaper.service.ts'),
  'utf8',
);

test('availability producers cover the closed Runner and Provider event set', () => {
  for (const trigger of [
    'project_runner_availability_event_source',
    'project_workspace_availability_event_source',
    'project_model_provider_availability_event_source',
  ]) {
    assert.match(migration, new RegExp(`CREATE TRIGGER "${trigger}"`));
  }
  for (const kind of [
    'runner.online',
    'runner.offline',
    'runner.capabilities_changed',
    'provider.unavailable',
    'provider.restored',
    'provider.quota_exhausted',
  ]) {
    assert.ok(migration.includes(`'${kind}'`), `${kind} has no producer`);
  }
  assert.match(migration, /p\."coordinator_enabled" = true/);
  assert.match(migration, /project_event_runner_projects/);
  assert.match(migration, /project_event_project_uses_provider/);
  assert.doesNotMatch(migration, /UPDATE\s+"(?:task|session)"\s+SET\s+"provider"/i);
});

test('timestamp-only heartbeats are noise and the reaper owns the offline edge', () => {
  assert.doesNotMatch(migration, /UPDATE OF[^;]*"last_heartbeat_at"/);
  assert.match(reaper, /status: \{ not: 'OFFLINE' \}/);
  assert.match(reaper, /lastHeartbeatAt: \{ lt: staleBefore \}/);
  assert.match(reaper, /data: \{ status: 'OFFLINE' \}/);
});
