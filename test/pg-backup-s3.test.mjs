// What scripts/pg-backup.sh does to an S3 bucket it copies the archive to (ORBIT_BACKUP_S3_TARGET): a whole round of the
// sidecar's loop against a real S3 server, `rclone serve s3` over a scratch directory, with only Postgres a stub. The copy is
// `rclone sync`, which deletes, so it is held to what the rsync mirror is (test/pg-backup-offhost.test.mjs): a bucket holding
// another cluster's archive, one further on than this archive, or base backups with no WAL to say whose they are is refused
// and left as it was, and an empty archive is never copied. Fails, rather than skips, where rclone is not installed.
//
//   npm run test:pg-backup-s3
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLUSTER = 7301234567890123456n;
const OTHER_CLUSTER = 7209876543210987654n;
// rclone's S3 server turns away keys this short as unknown, so these are not.
const KEY = 'PGBACKUPTESTACCESSKEY';
const SECRET = 'PGBACKUPTESTSECRETKEY123456';

test('rclone is installed, which every case here needs', () => {
  assert.equal(spawnSync('rclone', ['version']).status, 0, 'rclone is not on PATH: install it, as ci.yml does');
});

let server;
let endpoint;
let buckets;
let bucketCount = 0;
before(async () => {
  buckets = mkdtempSync(path.join(tmpdir(), 'pg-backup-s3-buckets-'));
  // No directory cache: each case writes its bucket straight to disk, and a cached listing would show it missing, which the
  // script rightly reads as a first install.
  server = spawn('rclone', ['serve', 's3', '--config', '/dev/null', '--auth-key', `${KEY},${SECRET}`, '--addr', '127.0.0.1:0', '--dir-cache-time', '0s', buckets]);
  endpoint = await new Promise((resolve, reject) => {
    let said = '';
    server.stderr.on('data', (chunk) => {
      said += chunk;
      const found = said.match(/Starting s3 server on \[(http:\/\/[^\]/]+)\/?\]/);
      if (found) resolve(found[1]);
    });
    server.on('exit', (code) => reject(new Error(`rclone serve s3 exited ${code}: ${said}`)));
  });
});
after(() => {
  server?.kill();
  if (buckets) rmSync(buckets, { recursive: true, force: true });
});

const walName = (timeline, number) => `${timeline.toString(16).toUpperCase().padStart(8, '0')}00000000${number.toString(16).toUpperCase().padStart(8, '0')}`;
/** A gzipped segment whose first page names the cluster that wrote it, as Postgres's long page header does. */
function segment(system, filler) {
  const header = Buffer.alloc(32);
  header.writeBigUInt64LE(system, 24);
  return gzipSync(Buffer.concat([header, Buffer.from(filler)]));
}
function archiveIn(dir, { system = CLUSTER, timeline = 1, from = 1, to = 3, bases = ['20260101T000000Z'] } = {}) {
  for (const stamp of bases) {
    mkdirSync(path.join(dir, 'base', stamp), { recursive: true });
    writeFileSync(path.join(dir, 'base', stamp, 'base.tar.gz'), `base ${stamp}`);
  }
  mkdirSync(path.join(dir, 'wal'), { recursive: true });
  for (let number = from; number <= to; number += 1) {
    writeFileSync(path.join(dir, 'wal', `${walName(timeline, number)}.gz`), segment(system, `${system} ${timeline} ${number}`));
  }
}
/** Every file under `dir` with what it holds; S3 keeps no directories, so neither does this. */
function contents(dir) {
  if (!existsSync(dir)) return [];
  const walk = (at) => readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(at, entry.name);
    return entry.isDirectory() ? walk(file) : [`${path.relative(dir, file)} ${createHash('sha256').update(readFileSync(file)).digest('hex')}`];
  });
  return walk(dir).sort();
}

/**
 * One round of the loop. `prepare` is given the directories: the archive, the bucket's prefix as the server stores it, and an
 * rsync target for the files. psql answers for cluster `system`; sleep fails with 7, which ends the round.
 */
function round({ prepare, system = CLUSTER, env = {}, filesTarget = false } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'pg-backup-s3-'));
  bucketCount += 1;
  const bucket = `archive-${bucketCount}`;
  mkdirSync(path.join(buckets, bucket));
  try {
    const dirs = {
      archive: path.join(scratch, 'archive'),
      files: path.join(scratch, 'files'),
      bucket: path.join(buckets, bucket, 'prod'),
      filesTarget: path.join(scratch, 'backup-host', 'archive-files'),
    };
    mkdirSync(path.join(dirs.archive, 'base'), { recursive: true });
    mkdirSync(path.join(dirs.archive, 'wal'), { recursive: true });
    mkdirSync(path.dirname(dirs.filesTarget), { recursive: true });
    mkdirSync(dirs.files);
    prepare?.(dirs);
    const stubs = path.join(scratch, 'stubs');
    mkdirSync(stubs);
    for (const [name, body] of Object.entries({
      psql: `case "$*" in
  *system_identifier*) echo ${system} ;;
  *pg_stat_archiver*) echo 'f|-|0' ;;
  *file_blob*) echo '' ;;
  *) echo 0 ;;
esac`,
      pg_basebackup: 'for arg; do case "$arg" in --pgdata=*) mkdir -p "${arg#--pgdata=}"; echo backup > "${arg#--pgdata=}/base.tar.gz" ;; esac; done',
      pg_archivecleanup: ':',
      ssh: ':',
      sleep: 'exit 7',
    })) writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const run = spawnSync('sh', ['scripts/pg-backup.sh'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: `${stubs}:${process.env.PATH}`,
        TMPDIR: scratch,
        ORBIT_ARCHIVE_DIR: dirs.archive,
        ORBIT_DRIVE_DIR: dirs.files,
        ORBIT_BACKUP_MIN_FREE_MB: '0',
        ORBIT_BACKUP_S3_TARGET: `${bucket}/prod`,
        ORBIT_BACKUP_S3_ENDPOINT: endpoint,
        ORBIT_BACKUP_S3_ACCESS_KEY_ID: KEY,
        ORBIT_BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
        ...(filesTarget ? { ORBIT_BACKUP_SYNC_TARGET: path.join(scratch, 'backup-host', 'archive') } : {}),
        ...env,
      },
      timeout: 60_000,
    });
    const log = run.stdout + run.stderr;
    assert.equal(run.status, 7, `the round finished: ${log}`);
    const left = readdirSync(scratch).filter((name) => !['archive', 'files', 'backup-host', 'stubs'].includes(name));
    assert.deepEqual(left, [], `no temporary file outlives the round: ${log}`);
    return {
      log,
      bucket: contents(dirs.bucket),
      archive: contents(dirs.archive).filter((line) => !line.startsWith('metrics/') && !line.includes('.staging-')),
      metrics: readFileSync(path.join(dirs.archive, 'metrics', 'pgbackup.prom'), 'utf8'),
      files: contents(dirs.filesTarget),
      dirs,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const copied = (result) => assert.deepEqual(result.bucket, result.archive, `the bucket now holds this archive: ${result.log}`);
function refused(result, before, why) {
  assert.deepEqual(result.bucket, before, `the bucket stays as it was: ${result.log}`);
  assert.match(result.log, /ERROR: refusing off-host sync to s3:\/\/archive-\d+\/prod/);
  assert.match(result.log, why);
  assert.match(result.metrics, /orbit_backup_mirror_failures_total\{copy="archive"\} 1/);
}

test('a first install copies the archive to an empty bucket, and says what went', () => {
  const result = round({ prepare: ({ archive }) => archiveIn(archive) });
  copied(result);
  assert.match(result.log, /mirrored 4 change\(s\) to s3:\/\/archive-\d+\/prod/);
  assert.match(result.log, /mirroring to s3:\/\/archive-\d+\/prod/);
  assert.match(result.metrics, /orbit_backup_mirror_failures_total\{copy="archive"\} 0/);
});

test('the same cluster goes on, and the bucket follows retention: the old base backup and its WAL go', () => {
  let before;
  const result = round({
    prepare: ({ archive, bucket }) => {
      archiveIn(bucket, { from: 1, to: 3, bases: ['20260101T000000Z'] });
      archiveIn(archive, { from: 3, to: 5, bases: ['20260102T000000Z'] });
      before = contents(bucket);
    },
  });
  assert.notDeepEqual(before, result.archive);
  copied(result);
});

test('a cluster restored onto a higher timeline goes on over its own older WAL', () => {
  const result = round({
    prepare: ({ archive, bucket }) => {
      archiveIn(bucket, { from: 1, to: 3 });
      archiveIn(archive, { timeline: 2, from: 4, to: 5, bases: ['20260102T000000Z'] });
    },
  });
  copied(result);
});

test('a bucket holding another cluster\'s archive is refused and left as it was', () => {
  let before;
  const result = round({
    prepare: ({ archive, bucket }) => {
      archiveIn(bucket, { system: OTHER_CLUSTER, from: 1, to: 9 });
      archiveIn(archive, { from: 1, to: 3, bases: ['20260102T000000Z'] });
      before = contents(bucket);
    },
  });
  refused(result, before, new RegExp(`its archive belongs to cluster ${OTHER_CLUSTER}`));
});

test('nor one further on than this archive, even of this cluster', () => {
  let before;
  const result = round({
    prepare: ({ archive, bucket }) => {
      archiveIn(bucket, { from: 1, to: 9 });
      archiveIn(archive, { from: 1, to: 3 });
      before = contents(bucket);
    },
  });
  refused(result, before, /it holds WAL newer than/);
});

test('nor base backups with no WAL to say whose they are', () => {
  let before;
  const result = round({
    prepare: ({ archive, bucket }) => {
      mkdirSync(path.join(bucket, 'base', '20251201T000000Z'), { recursive: true });
      writeFileSync(path.join(bucket, 'base', '20251201T000000Z', 'base.tar.gz'), 'someone else');
      archiveIn(archive);
      before = contents(bucket);
    },
  });
  refused(result, before, /holds base backups and no WAL to tell whose they are \(20251201T000000Z\)/);
});

test('an archive with no WAL is never copied: the copy would empty the bucket', () => {
  let before;
  const result = round({
    prepare: ({ archive, bucket }) => {
      archiveIn(bucket);
      mkdirSync(path.join(archive, 'base', '20260102T000000Z'), { recursive: true });
      writeFileSync(path.join(archive, 'base', '20260102T000000Z', 'base.tar.gz'), 'base');
      before = contents(bucket);
    },
  });
  refused(result, before, /holds no base backup or no WAL/);
});

test('a base backup still being written and this host\'s metrics stay off the bucket', () => {
  const result = round({
    prepare: ({ archive }) => {
      archiveIn(archive);
      mkdirSync(path.join(archive, 'base', '.staging-20260102T000000Z'), { recursive: true });
      writeFileSync(path.join(archive, 'base', '.staging-20260102T000000Z', 'base.tar.gz'), 'half');
    },
  });
  copied(result);
  assert.ok(!result.bucket.some((line) => line.includes('.staging-') || line.startsWith('metrics/')), result.bucket.join('\n'));
});

test('a bucket it cannot reach costs the local backups nothing, is counted, and says why', () => {
  const result = round({ prepare: ({ archive }) => archiveIn(archive), env: { ORBIT_BACKUP_S3_SECRET_ACCESS_KEY: 'WRONGSECRETKEY12345678' } });
  assert.match(result.log, /ERROR: off-host sync to s3:\/\/archive-\d+\/prod failed: could not read the target: .*SignatureDoesNotMatch|ERROR: off-host sync to s3:\/\/archive-\d+\/prod failed: could not read the target: .*403/);
  assert.deepEqual(result.bucket, []);
  assert.match(result.metrics, /orbit_backup_mirror_failures_total\{copy="archive"\} 1/);
});

test('with a bucket for the archive, the rsync target takes only the files', () => {
  const name = 'ab'.padEnd(64, '0');
  const result = round({
    filesTarget: true,
    prepare: ({ archive, files }) => {
      archiveIn(archive);
      mkdirSync(path.join(files, 'ab'));
      writeFileSync(path.join(files, 'ab', name), 'bytes');
    },
  });
  copied(result);
  assert.deepEqual(result.files.map((line) => line.split(' ')[0]), [`ab/${name}`]);
  assert.ok(!existsSync(path.join(path.dirname(result.dirs.filesTarget), 'archive')), 'nothing of the archive goes over rsync');
  assert.match(result.log, /mirroring to s3:\/\/archive-\d+\/prod and \S+archive-files/);
});
