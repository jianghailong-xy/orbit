// What scripts/pg-backup.sh does to its off-host target, with real rsync over local paths: a whole round of the sidecar's
// loop, in which only Postgres is a stub. The script's `rsync --delete` is what can wipe the only copy of an archive, so this
// runs on every push (.github/workflows/ci.yml) and fails, rather than skips, on a machine with no rsync.
//
//   npm run test:pg-backup-offhost
//
// The mirror (a fresh cluster must not replace the old cluster's archive): an existing mirror of another cluster is refused
// and left byte for byte as it was, whether or not its segment names overlap this archive's, and so is one further on than
// this archive, or a base backup with no WAL to say whose it is; the log says why and what to do. The same cluster, a
// restored one on a higher timeline, a first install to an empty or missing directory, and a first sync cut short all go on.
// A segment holds the system identifier Postgres wrote into it, so none of this needs a marker on the target.
//
// The files copy (pruned after the bytes go, never by what the local directory lacks): only names the database says are due
// go, and an empty or missing local directory, a database it cannot read, or a target the mirror refused removes nothing.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Not a skip: `node --test` exits 0 on a file whose every case skipped.
test('rsync is installed, which every case here needs', () => {
  assert.equal(spawnSync('rsync', ['--version']).status, 0, 'rsync is not on PATH: install it, as ci.yml does');
});

const CLUSTER = 7301234567890123456n;
const OTHER_CLUSTER = 7209876543210987654n;
/** What gzip makes of a segment: its first page says which cluster wrote it, as Postgres's long page header does. */
function segment(system, filler = '') {
  const header = Buffer.alloc(32);
  header.writeBigUInt64LE(system, 24);
  return gzipSync(Buffer.concat([header, Buffer.from(filler)]));
}
const walName = (timeline, number) => `${timeline.toString(16).toUpperCase().padStart(8, '0')}00000000${number.toString(16).toUpperCase().padStart(8, '0')}`;
const BEGINNING = new Date('2026-01-01T00:00:00Z');

/** An archive as the sidecar's mount holds it: base/<stamp>/, wal/<segment>.gz, each with a time of its own, as rsync keeps. */
function archiveIn(dir, { system = CLUSTER, timeline = 1, from = 1, to = 3, bases = ['20260101T000000Z'], at = BEGINNING } = {}) {
  for (const stamp of bases) {
    mkdirSync(path.join(dir, 'base', stamp), { recursive: true });
    const file = path.join(dir, 'base', stamp, 'base.tar.gz');
    writeFileSync(file, `base ${stamp}`);
    utimesSync(file, at, at);
  }
  mkdirSync(path.join(dir, 'wal'), { recursive: true });
  for (let number = from; number <= to; number += 1) {
    const file = path.join(dir, 'wal', `${walName(timeline, number)}.gz`);
    writeFileSync(file, segment(system, `${system} ${timeline} ${number}`));
    const time = new Date(at.getTime() + number * 60_000);
    utimesSync(file, time, time);
  }
}

/** Every file under `dir`, with what it holds and its time: what "left as it was" is held to. */
function fingerprint(dir) {
  if (!existsSync(dir)) return null;
  const walk = (at) => readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(at, entry.name);
    if (entry.isDirectory()) return walk(file);
    return [`${path.relative(dir, file)} ${createHash('sha256').update(readFileSync(file)).digest('hex')} ${statSync(file).mtimeMs}`];
  });
  return walk(dir).sort();
}

/**
 * One round of the loop on scratch directories. Everything is real but Postgres: psql answers for the cluster `system` and
 * says which file names are due, or fails when `database` is 'down'; pg_basebackup makes a backup when one is due; sleep
 * fails, which ends the script under `set -e`, with 7 meaning the round finished. `prepare` is given the directories.
 */
function round({ prepare, system = CLUSTER, due = [], database = 'up', interval = 86_400, rsyncFailsOn = null }) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'pg-backup-offhost-'));
  try {
    const dirs = {
      archive: path.join(scratch, 'archive'),
      files: path.join(scratch, 'files'),
      target: path.join(scratch, 'backup-host', 'orbit-pg-archive'),
      filesTarget: path.join(scratch, 'backup-host', 'orbit-pg-archive-files'),
    };
    mkdirSync(path.join(dirs.archive, 'base'), { recursive: true });
    mkdirSync(path.join(dirs.archive, 'wal'), { recursive: true });
    mkdirSync(path.dirname(dirs.target), { recursive: true });
    mkdirSync(dirs.files);
    prepare?.(dirs);
    const stubs = path.join(scratch, 'stubs');
    mkdirSync(stubs);
    const queries = path.join(scratch, 'psql-queries');
    const realRsync = execFileSync('sh', ['-c', 'command -v rsync'], { encoding: 'utf8' }).trim();
    for (const [name, body] of Object.entries({
      psql: `printf '%s\\n' "$*" >> '${queries}'
case "$*" in
  *system_identifier*) [ '${database}' = up ] && echo ${system} || { echo 'could not connect to server' >&2; exit 2; } ;;
  *file_blob*) [ '${database}' = up ] || { echo 'could not connect to server' >&2; exit 2; }; printf '%s\\n' ${due.map((name) => `'${name}'`).join(' ') || "''"} ;;
  *) echo 0 ;;
esac`,
      // A base backup is taken at the start of the round only when none is recent, which `prepare` decides.
      pg_basebackup: 'for arg; do case "$arg" in --pgdata=*) mkdir -p "${arg#--pgdata=}"; echo backup > "${arg#--pgdata=}/base.tar.gz" ;; esac; done',
      pg_archivecleanup: ':',
      ssh: ':',
      sleep: 'exit 7',
      ...(rsyncFailsOn ? {
        rsync: `case "$*" in *${rsyncFailsOn}*) echo 'ssh: connect to host backup-host port 22: Connection refused' >&2; exit 255 ;; esac; exec '${realRsync}' "$@"`,
      } : {}),
    })) writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const before = { mirror: fingerprint(dirs.target), copy: fingerprint(dirs.filesTarget) };
    const run = spawnSync('sh', ['scripts/pg-backup.sh'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: `${stubs}:${process.env.PATH}`,
        ORBIT_ARCHIVE_DIR: dirs.archive,
        ORBIT_FILES_DIR: dirs.files,
        ORBIT_BACKUP_SYNC_TARGET: dirs.target,
        ORBIT_BACKUP_MIN_FREE_MB: '0',
        ORBIT_BASE_BACKUP_INTERVAL: String(interval),
      },
      timeout: 30_000,
    });
    const log = run.stdout + run.stderr;
    assert.equal(run.status, 7, `the round finished: ${log}`);
    return {
      log,
      before,
      after: { mirror: fingerprint(dirs.target), copy: fingerprint(dirs.filesTarget) },
      archive: fingerprint(dirs.archive),
      queries: existsSync(queries) ? readFileSync(queries, 'utf8') : '',
      dirs,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const mirrored = (result) => assert.deepEqual(result.after.mirror, result.archive, `the mirror is now this archive: ${result.log}`);
function refused(result, why) {
  assert.deepEqual(result.after.mirror, result.before.mirror, `the mirror stays byte for byte: ${result.log}`);
  assert.match(result.log, why);
  assert.match(result.log, /ERROR: refusing off-host sync to /);
  assert.match(result.log, /Restore on a replacement host/, 'it says what to do');
  assert.match(result.log, /move it aside on the backup host/);
}

// ── The mirror ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('a fresh cluster does not replace the mirror of another cluster', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive, { system: CLUSTER, from: 1, to: 3, bases: ['20260301T000000Z'] });
      archiveIn(target, { system: OTHER_CLUSTER, from: 80, to: 140, bases: ['20260201T000000Z', '20260202T000000Z'] });
    },
  });
  refused(result, new RegExp(`its archive belongs to cluster ${OTHER_CLUSTER} .* and this one is ${CLUSTER}`));
});

test('nor once its segment numbers have caught up with the old ones', () => {
  // The same names, written by another cluster: this is where comparing names alone would let --delete through.
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive, { system: CLUSTER, from: 100, to: 200, at: new Date('2026-03-01T00:00:00Z') });
      archiveIn(target, { system: OTHER_CLUSTER, from: 80, to: 140, bases: ['20260201T000000Z'] });
    },
  });
  refused(result, /its archive belongs to cluster/);
});

test('nor when the old archive was copied back under a new cluster, whose segments would pass as the target\'s own', () => {
  // Copied back, then `docker compose up -d` with an empty data directory: the archive holds the old WAL, the server is new.
  const result = round({
    system: CLUSTER,
    prepare: ({ archive, target }) => {
      archiveIn(target, { system: OTHER_CLUSTER, from: 80, to: 90 });
      archiveIn(archive, { system: OTHER_CLUSTER, from: 80, to: 90 });
    },
  });
  refused(result, new RegExp(`belongs to cluster ${OTHER_CLUSTER}, and this one is ${CLUSTER}`));
});

test('nor when the mirror holds WAL further on than this archive, even of this cluster', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive, { from: 1, to: 3 });
      archiveIn(target, { from: 1, to: 9 });
    },
  });
  refused(result, /it holds WAL newer than .*newest segment 000000010000000000000009\.gz there, 000000010000000000000003\.gz here/);
});

test('nor a mirror with a base backup of someone else\'s and no WAL to say whose', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive, { bases: ['20260301T000000Z'] });
      mkdirSync(path.join(target, 'base', '20260201T000000Z'), { recursive: true });
      writeFileSync(path.join(target, 'base', '20260201T000000Z', 'base.tar.gz'), 'the only copy');
    },
  });
  refused(result, /it holds base backup 20260201T000000Z, which is not in .*and no WAL to tell whose it is/);
});

test('the same cluster mirrors as ever, trimmed retention included', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(target, { from: 1, to: 5, bases: ['20260101T000000Z', '20260102T000000Z'] });
      // The same files, then: these two were trimmed here and go there too, and three are new.
      archiveIn(archive, { from: 3, to: 8, bases: ['20260102T000000Z', '20260103T000000Z'] });
    },
  });
  mirrored(result);
  assert.doesNotMatch(result.log, /ERROR/);
});

test('so does one whose mirror shares no segment with it, after a long outage: the identifier says it is the same cluster', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(target, { from: 1, to: 5 });
      archiveIn(archive, { from: 50, to: 60, bases: ['20260301T000000Z'] });
    },
  });
  mirrored(result);
  assert.doesNotMatch(result.log, /ERROR/);
});

test('a cluster restored from the mirror goes on, on its higher timeline, with the old WAL copied back or not', () => {
  for (const copiedBack of [true, false]) {
    const result = round({
      prepare: ({ archive, target }) => {
        archiveIn(target, { timeline: 1, from: 10, to: 90 });
        if (copiedBack) archiveIn(archive, { timeline: 1, from: 10, to: 90 });
        // Recovery stopped at segment 40 of timeline 1: a lower number on a higher timeline, which is further on.
        archiveIn(archive, { timeline: 2, from: 40, to: 45, bases: ['20260401T000000Z'] });
      },
    });
    mirrored(result);
    assert.doesNotMatch(result.log, /ERROR/);
  }
});

test('a first install syncs, to a missing directory or an empty one', () => {
  for (const make of [false, true]) {
    const result = round({
      prepare: ({ archive, target }) => {
        archiveIn(archive);
        if (make) mkdirSync(target);
      },
    });
    mirrored(result);
    assert.doesNotMatch(result.log, /ERROR/);
  }
});

test('a first sync cut short, which left our base backup there and no WAL yet, goes on', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive);
      mkdirSync(path.join(target, 'base', '20260101T000000Z'), { recursive: true });
      writeFileSync(path.join(target, 'base', '20260101T000000Z', 'base.tar.gz'), 'cut short');
    },
  });
  mirrored(result);
});

test('a target it cannot read, or a cluster it cannot name, leaves the mirror and the backups as they were', () => {
  const unreachable = round({
    rsyncFailsOn: '--list-only',
    prepare: ({ archive, target }) => {
      archiveIn(archive, { bases: ['20260301T000000Z'] });
      archiveIn(target, { from: 1, to: 3 });
    },
  });
  assert.deepEqual(unreachable.after.mirror, unreachable.before.mirror);
  assert.match(unreachable.log, /ERROR: off-host sync to .* failed: could not read the target: ssh: connect to host backup-host/);

  const down = round({
    database: 'down',
    prepare: ({ archive, target }) => {
      archiveIn(archive, { bases: ['20260301T000000Z'] });
      archiveIn(target, { from: 1, to: 3 });
    },
  });
  assert.deepEqual(down.after.mirror, down.before.mirror);
  assert.match(down.log, /ERROR: off-host sync to .* skipped: could not read this cluster's system identifier: could not connect/);
});

test('a refused mirror costs the local backups nothing', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive);
      utimesSync(path.join(archive, 'base', '20260101T000000Z'), BEGINNING, BEGINNING);
      archiveIn(target, { system: OTHER_CLUSTER, from: 80, to: 90 });
    },
  });
  refused(result, /its archive belongs to cluster/);
  assert.match(result.log, /completed base backup /, 'the base backup that was due was taken');
  assert.doesNotMatch(result.log, /ERROR: skipping base backup/);
});

test('a mirror it refuses still gets the files, which are named by their content and go nowhere', () => {
  const file = 'ab'.repeat(32);
  const result = round({
    prepare: ({ archive, target, files }) => {
      archiveIn(archive, { bases: ['20260301T000000Z'] });
      archiveIn(target, { system: OTHER_CLUSTER, from: 80, to: 90 });
      mkdirSync(path.join(files, 'ab'), { recursive: true });
      writeFileSync(path.join(files, 'ab', file), 'bytes');
    },
  });
  refused(result, /its archive belongs to cluster/);
  assert.deepEqual(result.after.copy.map((line) => line.split(' ')[0]), [`ab/${file}`]);
});

// ── The files copy ──────────────────────────────────────────────────────────────────────────────────────────────────

const NAME = (char) => char.repeat(64);
const onCopy = (result) => (result.after.copy ?? []).map((line) => line.split(' ')[0]);
const inCopy = (name) => `${name.slice(0, 2)}/${name}`;

/** A mirror that takes this archive, and a files copy holding these names; `local` is what the files directory still holds. */
function prepareCopy(names, local) {
  return ({ archive, target, files, filesTarget }) => {
    archiveIn(archive);
    archiveIn(target);
    for (const name of names) {
      mkdirSync(path.join(filesTarget, name.slice(0, 2)), { recursive: true });
      writeFileSync(path.join(filesTarget, name.slice(0, 2), name), `bytes of ${name}`);
    }
    if (local === null) {
      rmSync(files, { recursive: true });
      return;
    }
    for (const name of local) {
      mkdirSync(path.join(files, name.slice(0, 2)), { recursive: true });
      writeFileSync(path.join(files, name.slice(0, 2), name), `bytes of ${name}`);
    }
  };
}

test('only the names the database says are due leave the copy, whatever else shares their directory', () => {
  const [gone, neighbour, stays] = [`aa${'1'.repeat(62)}`, `aa${'2'.repeat(62)}`, NAME('b')];
  const result = round({ due: [gone], prepare: prepareCopy([gone, neighbour, stays], [stays]) });
  // The neighbour is missing from the local directory too: not being here is not what prunes.
  assert.deepEqual(onCopy(result).sort(), [inCopy(neighbour), inCopy(stays)].sort(), result.log);
  assert.match(result.log, /pruned 1 file\(s\) from /);
  assert.match(result.queries, /-d orbit -Atc select sha256 from file_blob where off_host_prune_at <= now\(\) at time zone 'utc'/, 'it is the database that says');
});

test('nothing is due, nothing goes, though the local directory lacks every name on the copy', () => {
  const [a, b, kept] = [NAME('a'), NAME('b'), NAME('c')];
  const result = round({ due: [], prepare: prepareCopy([a, b], [kept]) });
  assert.deepEqual(onCopy(result).filter((name) => name !== inCopy(kept)).sort(), [inCopy(a), inCopy(b)]);
  assert.doesNotMatch(result.log, /pruned/);
});

test('an empty local directory prunes nothing, whatever is due', () => {
  for (const uploading of [false, true]) {
    const names = [NAME('a'), NAME('b')];
    const result = round({
      due: names,
      prepare: (dirs) => {
        prepareCopy(names, [])(dirs);
        if (uploading) mkdirSync(path.join(dirs.files, 'tmp'));
      },
    });
    assert.deepEqual(result.after.copy, result.before.copy, result.log);
    assert.match(result.log, /ERROR: refusing to prune .*is empty or not mounted/);
  }
});

test('a local directory that is not mounted prunes nothing, whatever is due', () => {
  const names = [NAME('a'), NAME('b')];
  const result = round({ due: names, prepare: prepareCopy(names, null) });
  assert.deepEqual(result.after.copy, result.before.copy, result.log);
  assert.match(result.log, /ERROR: refusing to prune .*is empty or not mounted/);
});

test('a database it cannot read prunes nothing', () => {
  const names = [NAME('a')];
  const result = round({
    database: 'down',
    prepare: (dirs) => {
      prepareCopy(names, [NAME('b')])(dirs);
      rmSync(dirs.target, { recursive: true });
    },
  });
  assert.equal(onCopy(result).includes(inCopy(names[0])), true, result.log);
  assert.match(result.log, /WARN: not pruning .*could not read which files have gone: could not connect/);
});

test('a target the mirror refused is not pruned on this cluster\'s word', () => {
  const name = NAME('a');
  const result = round({
    due: [name],
    prepare: (dirs) => {
      prepareCopy([name], [NAME('b')])(dirs);
      rmSync(dirs.target, { recursive: true });
      archiveIn(dirs.target, { system: OTHER_CLUSTER, from: 80, to: 90 });
    },
  });
  assert.equal(onCopy(result).includes(inCopy(name)), true, result.log);
  assert.doesNotMatch(result.log, /pruned/);
});

test('bytes uploaded again since stay, and what the database names that the copy does not have is no error', () => {
  const [back, never] = [NAME('a'), NAME('b')];
  const result = round({ due: [back, never], prepare: prepareCopy([back], [back]) });
  assert.equal(onCopy(result).includes(inCopy(back)), true, result.log);
  assert.doesNotMatch(result.log, /ERROR|pruned/);
});

test('with no copy there yet there is nothing to prune', () => {
  const result = round({
    due: [NAME('a')],
    prepare: ({ archive, files }) => {
      archiveIn(archive);
      mkdirSync(path.join(files, 'bb'), { recursive: true });
    },
  });
  assert.doesNotMatch(result.log, /ERROR/);
  assert.doesNotMatch(result.log, /pruned/);
});

test('a name that is not a sha256 is not a name: a database cannot aim this anywhere else', () => {
  const name = NAME('a');
  const result = round({
    due: ['*', '../../etc/passwd', 'aa/', name.toUpperCase()],
    prepare: prepareCopy([name, NAME('b')], [NAME('c')]),
  });
  assert.equal(onCopy(result).includes(inCopy(name)), true, result.log);
  assert.equal(onCopy(result).includes(inCopy(NAME('b'))), true, result.log);
  assert.doesNotMatch(result.log, /pruned/);
});
