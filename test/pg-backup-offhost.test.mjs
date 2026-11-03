// What scripts/pg-backup.sh does to its off-host target, with real rsync over local paths: a whole round of the sidecar's
// loop, in which only Postgres is a stub. The script's `rsync --delete` is what can wipe the only copy of an archive, so this
// runs on every push (.github/workflows/ci.yml) and fails, rather than skips, on a machine with no rsync.
//
//   npm run test:pg-backup-offhost
//
// The mirror (a fresh cluster must not replace the old cluster's archive): an existing mirror of another cluster is refused
// and left byte for byte as it was, whether or not its segment names overlap this archive's, and however alike its listing
// reads, and so is one further on than this archive, or a base backup with no WAL, whatever it is called; the log says why and
// what to do. The same cluster, a restored one on a higher timeline and a first install to an empty or missing directory all
// go on, and so does a first sync cut short, because a target gets WAL first and a segment is then there to read. A segment
// holds the system identifier Postgres wrote into it, so none of this needs a marker on the target, and one is read from the
// target before every --delete.
//
// What --delete takes on the way (it must not take the target's last base backup before another has landed): a target holding
// one of this archive's base backups whole has the one pass it always had, since that one stays and --delete can make room. One
// holding base backups and none of those whole is sent everything first, and --delete runs only if that finished.
//
// The files copy (pruned after the bytes go, never by what the local directory lacks): only names the database says are due
// go, and an empty or missing local directory, a database it cannot read, or a target the mirror refused removes nothing.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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

/** One segment of `system` in `dir`, gzipped from `size` bytes that do not compress, so that the sizes in a listing are in that order. */
function sizedSegment(dir, { system = CLUSTER, timeline = 1, number, size, at = BEGINNING }) {
  mkdirSync(path.join(dir, 'wal'), { recursive: true });
  const file = path.join(dir, 'wal', `${walName(timeline, number)}.gz`);
  writeFileSync(file, segment(system, randomBytes(size)));
  utimesSync(file, at, at);
  return `${walName(timeline, number)}.gz`;
}

/** Makes two archives' segment of this name read the same in a listing, each still holding its own cluster's valid bytes. */
function makeListingsMatch(name, ...archives) {
  const files = archives.map((dir) => path.join(dir, 'wal', name));
  const size = Math.max(...files.map((file) => statSync(file).size));
  const at = new Date('2026-01-01T12:00:00Z');
  for (const file of files) {
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.alloc(size - statSync(file).size)]));
    utimesSync(file, at, at);
  }
  const lines = files.map((file) => execFileSync('rsync', ['--list-only', file], { encoding: 'utf8' }).trim());
  assert.equal(new Set(lines).size, 1, `the lines must match, or this proves nothing: ${lines.join(' | ')}`);
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
 * With `cut`, a round runs first in which the rsync call naming `cut.on` sends all but what `cut.holdsBack` matches and then
 * dies, as a dropped connection does, or as a full disk does with `cut.says`. What that left is `cutShort`, and the next poll
 * is the round this returns: with room again, or as cut as the first with `cut.everyPoll`. `cut.then`, given the directories, is
 * what a person does in between.
 */
function round({ prepare, system = CLUSTER, due = [], database = 'up', interval = 86_400, rsyncFailsOn = null, cut = null }) {
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
    const rsyncCalls = path.join(scratch, 'rsync-calls');
    const cutting = path.join(scratch, 'cutting');
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
      // The real one, with each call written down.
      rsync: `printf '%s\\n' "$*" >> '${rsyncCalls}'
${rsyncFailsOn ? `case "$*" in *'${rsyncFailsOn}'*) echo 'ssh: connect to host backup-host port 22: Connection refused' >&2; exit 255 ;; esac` : ''}
${cut ? `if [ -e '${cutting}' ]; then case "$*" in *'${cut.on}'*) '${realRsync}' '--exclude=${cut.holdsBack}' "$@"; echo '${cut.says ?? 'rsync: connection unexpectedly closed'}' >&2; exit 12 ;; esac; fi` : ''}
exec '${realRsync}' "$@"`,
    })) writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const poll = () => {
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
      return log;
    };
    let cutShort = null;
    if (cut) {
      writeFileSync(cutting, '');
      const log = poll();
      if (!cut.everyPoll) rmSync(cutting);
      cutShort = { log, mirror: fingerprint(dirs.target) };
      cut.then?.(dirs);
    }
    const before = { mirror: fingerprint(dirs.target), copy: fingerprint(dirs.filesTarget) };
    const log = poll();
    return {
      log,
      cutShort,
      before,
      after: { mirror: fingerprint(dirs.target), copy: fingerprint(dirs.filesTarget) },
      archive: fingerprint(dirs.archive),
      queries: existsSync(queries) ? readFileSync(queries, 'utf8') : '',
      rsyncCalls: existsSync(rsyncCalls) ? readFileSync(rsyncCalls, 'utf8').trim().split('\n') : [],
      dirs,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const mirrored = (result) => assert.deepEqual(result.after.mirror, result.archive, `the mirror is now this archive: ${result.log}`);
/** The file names in a fingerprint, without what they hold. */
const namesIn = (mirror) => mirror.map((line) => line.split(' ')[0]);
const segmentsAt = (...numbers) => numbers.map((number) => `wal/${walName(1, number)}.gz`);
/** The calls of a round that write to the mirror, in order: neither a read of the target nor the files copy. */
const writesToMirror = (result) => result.rsyncCalls.filter((call) => call.endsWith(`${path.basename(result.dirs.target)}/`) && !call.includes('--list-only'));
/** The segments this round fetched from the target to read, in order: the one call that has it as source and scratch as destination. */
const segmentsRead = (result) => result.rsyncCalls.flatMap((call) => call.match(/\/wal\/([0-9A-F]{24}\.gz) \S+\/segment$/)?.[1] ?? []);
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

test('nor when one of its segments reads the same in both listings: name, mode, size and time do not say whose it is', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive, { system: CLUSTER, from: 1, to: 5, bases: ['20260301T000000Z'] });
      archiveIn(target, { system: OTHER_CLUSTER, from: 1, to: 3, bases: ['20260201T000000Z'] });
      makeListingsMatch(`${walName(1, 3)}.gz`, archive, target);
    },
  });
  refused(result, new RegExp(`its archive belongs to cluster ${OTHER_CLUSTER} .* and this one is ${CLUSTER}`));
});

test('nor when every segment does', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive, { system: CLUSTER, from: 1, to: 4, bases: ['20260301T000000Z'] });
      archiveIn(target, { system: OTHER_CLUSTER, from: 1, to: 4, bases: ['20260201T000000Z'] });
      for (let number = 1; number <= 4; number += 1) makeListingsMatch(`${walName(1, number)}.gz`, archive, target);
    },
  });
  refused(result, new RegExp(`its archive belongs to cluster ${OTHER_CLUSTER} .* and this one is ${CLUSTER}`));
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

/** A target holding this in base/ and no WAL, with this archive beside it. */
function baseOnlyTarget(entry, { wal = [] } = {}) {
  return ({ archive, target }) => {
    archiveIn(archive, { bases: ['20260301T000000Z'] });
    mkdirSync(path.join(target, 'base', entry), { recursive: true });
    writeFileSync(path.join(target, 'base', entry, 'base.tar.gz'), 'the only copy');
    mkdirSync(path.join(target, 'wal'));
    for (const name of wal) writeFileSync(path.join(target, 'wal', name), 'not a segment');
  };
}

test('nor a mirror with a base backup of someone else\'s and no WAL to say whose', () => {
  const result = round({ prepare: baseOnlyTarget('20260201T000000Z') });
  refused(result, /it holds base backups and no WAL to tell whose they are \(20260201T000000Z\)/);
});

test('nor one under a name this archive also has, which says nothing of whose it is: an older script\'s first sync cut short is moved aside by hand', () => {
  const result = round({ prepare: baseOnlyTarget('20260301T000000Z') });
  refused(result, /it holds base backups and no WAL to tell whose they are \(20260301T000000Z\)/);
  assert.deepEqual(result.rsyncCalls.filter((call) => call.includes('--delete')), [], result.rsyncCalls.join('\n'));
});

test('nor when all that is beside it are files that are not finished segments', () => {
  const result = round({
    prepare: baseOnlyTarget('20260301T000000Z', {
      wal: [`.${walName(1, 2)}.gz.AbCdEf`, `${walName(1, 2)}.00000028.backup.gz`, '00000002.history.gz', `${walName(1, 2)}.gz.partial`],
    }),
  });
  refused(result, /it holds base backups and no WAL to tell whose they are/);
});

test('nor anything else in base/ with no WAL: what it is called does not come into it', () => {
  const result = round({ prepare: baseOnlyTarget('latest') });
  refused(result, /it holds base backups and no WAL to tell whose they are \(latest\)/);
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

test('it reads a segment from the target before every --delete, even with every line of the two listings alike', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive);
      archiveIn(target);
    },
  });
  mirrored(result);
  assert.doesNotMatch(result.log, /ERROR/);
  assert.equal(segmentsRead(result).length, 1, result.rsyncCalls.join('\n'));
  const read = result.rsyncCalls.findIndex((call) => /\/segment$/.test(call));
  const replaced = result.rsyncCalls.findIndex((call) => call.includes('--delete'));
  assert.ok(read !== -1 && read < replaced, `the read comes first: ${result.rsyncCalls.join('\n')}`);
});

test('and the one it reads is the smallest, which costs the least to fetch', () => {
  let smallest;
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive, { from: 1, to: 6 });
      // The name that sorts first or last, or the first the listing prints, would be a coincidence.
      for (const [number, size] of [[1, 4000], [2, 9000], [3, 200], [4, 3000], [5, 12000]]) {
        const name = sizedSegment(target, { number, size });
        if (size === 200) smallest = name;
      }
    },
  });
  mirrored(result);
  assert.deepEqual(segmentsRead(result), [smallest], result.rsyncCalls.join('\n'));
});

test('a torn copy holds no identifier, so the next segment is asked, and this cluster\'s mirror heals', () => {
  for (const torn of [Buffer.alloc(0), segment(CLUSTER, randomBytes(4000)).subarray(0, 10)]) {
    const result = round({
      prepare: ({ archive, target }) => {
        archiveIn(archive);
        archiveIn(target);
        writeFileSync(path.join(target, 'wal', `${walName(1, 2)}.gz`), torn);
      },
    });
    mirrored(result);
    assert.doesNotMatch(result.log, /ERROR/);
    assert.equal(segmentsRead(result)[0], `${walName(1, 2)}.gz`, 'the torn one sorts first');
    assert.equal(segmentsRead(result).length, 2, result.rsyncCalls.join('\n'));
  }
});

test('another cluster\'s mirror is refused all the same behind a torn copy, on the identifier of the segment after it', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive, { from: 1, to: 5 });
      archiveIn(target, { system: OTHER_CLUSTER, from: 1, to: 3 });
      writeFileSync(path.join(target, 'wal', `${walName(1, 1)}.gz`), '');
      makeListingsMatch(`${walName(1, 3)}.gz`, archive, target);
    },
  });
  refused(result, new RegExp(`its archive belongs to cluster ${OTHER_CLUSTER} .* and this one is ${CLUSTER}`));
});

test('three torn copies are as far as it looks, and the mirror is refused, not read to the end', () => {
  const result = round({
    prepare: ({ archive, target }) => {
      archiveIn(archive, { from: 1, to: 5 });
      archiveIn(target, { from: 1, to: 5 });
      for (const number of [1, 2, 3]) writeFileSync(path.join(target, 'wal', `${walName(1, number)}.gz`), '');
    },
  });
  refused(result, /its archive belongs to cluster unknown /);
  assert.equal(segmentsRead(result).length, 3, result.rsyncCalls.join('\n'));
});

test('a segment it cannot fetch stops the round before --delete, however alike the listings read', () => {
  const result = round({
    rsyncFailsOn: '/segment',
    prepare: ({ archive, target }) => {
      archiveIn(archive);
      archiveIn(target);
    },
  });
  assert.deepEqual(result.after.mirror, result.before.mirror, result.log);
  assert.match(result.log, /ERROR: off-host sync to .* failed: could not read [0-9A-F]{24}\.gz from the target: ssh: connect to host backup-host/);
  assert.deepEqual(result.rsyncCalls.filter((call) => call.includes('--delete')), [], result.rsyncCalls.join('\n'));
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

test('a first install syncs, to a missing directory or an empty one, or to one with what a cut left before its first segment landed', () => {
  const empty = (target) => mkdirSync(target);
  const bare = (target) => {
    mkdirSync(path.join(target, 'base'), { recursive: true });
    mkdirSync(path.join(target, 'wal'));
  };
  const firstSegmentCut = (target) => {
    bare(target);
    writeFileSync(path.join(target, 'wal', `.${walName(1, 1)}.gz.AbCdEf`), 'half a segment');
    writeFileSync(path.join(target, 'wal', '00000002.history.gz'), 'a history file sorts first');
  };
  for (const make of [null, empty, bare, firstSegmentCut]) {
    const result = round({
      prepare: ({ archive, target }) => {
        archiveIn(archive);
        make?.(target);
      },
    });
    mirrored(result);
    assert.doesNotMatch(result.log, /ERROR/);
  }
});

test('WAL goes first, on its own and deleting nothing, to a target that shares no segment with this archive', () => {
  for (const held of [false, true]) {
    const result = round({
      prepare: ({ archive, target }) => {
        archiveIn(archive, { from: 50, to: 52 });
        if (held) archiveIn(target, { from: 1, to: 2 });
      },
    });
    mirrored(result);
    const writes = writesToMirror(result);
    assert.equal(writes.length, 2, result.rsyncCalls.join('\n'));
    assert.doesNotMatch(writes[0], /--delete/);
    assert.ok(writes[0].includes('/archive/wal '), writes[0]);
    assert.match(writes[1], /--delete/);
  }
});

const [OLD_BASE, SHARED_BASE, NEW_BASE] = ['20260101T000000Z', '20260201T000000Z', '20260301T000000Z'];
const NO_ROOM = 'rsync: [receiver] write failed on "base.tar.gz": No space left on device (28)';
const OVER_QUOTA = 'rsync: [receiver] write failed on "base.tar.gz": Disk quota exceeded (122)';
/** The line that repeats every poll while a target cannot hold both, all of it on one line: nothing went, why, and what to do. */
const STOPPED = /ERROR: off-host sync to .* failed: .*(No space left on device|Disk quota exceeded).* Nothing was deleted: the target cannot hold its old base backups and this archive at once, and the old ones stay until the new ones have landed\. Free room on the backup host, or take the old ones off that disk by hand, and the next poll carries on\.$/m;
/** A base backup's file, in a fingerprint or for --exclude. */
const baseFile = (stamp) => `base/${stamp}/base.tar.gz`;

/** What ORBIT_BASE_BACKUP_KEEP=2 leaves: the target holds the last two base backups, one of which this archive still holds. */
const inStep = ({ archive, target }) => {
  archiveIn(target, { from: 1, to: 3, bases: [OLD_BASE, SHARED_BASE] });
  archiveIn(archive, { from: 3, to: 5, bases: [SHARED_BASE, NEW_BASE] });
  // rsync gives a directory the time of its last change: that it differs says nothing of the files in it.
  utimesSync(path.join(target, 'base', SHARED_BASE), BEGINNING, BEGINNING);
};

test('a target that shares a segment and a whole base backup has the one pass it always had, so that --delete still makes room on a full disk', () => {
  const result = round({ prepare: inStep });
  mirrored(result);
  const writes = writesToMirror(result);
  assert.equal(writes.length, 1, result.rsyncCalls.join('\n'));
  assert.match(writes[0], /--delete/);
  assert.doesNotMatch(result.log, /ERROR/);
});

test('and keeps that segment wherever the pass is cut, so the next poll has it to read', () => {
  const result = round({
    cut: { on: '--delete', holdsBack: `${walName(1, 0).slice(0, -1)}[45].gz` },
    prepare: inStep,
  });
  assert.deepEqual(namesIn(result.cutShort.mirror), [baseFile(SHARED_BASE), baseFile(NEW_BASE), ...segmentsAt(3)]);
  mirrored(result);
  assert.doesNotMatch(result.log, /ERROR/);
});

test('and keeps that base backup when the new one does not fit: --delete costs it only the older one, as it always has', () => {
  const result = round({
    cut: { on: '--delete', holdsBack: `${NEW_BASE}/base.tar.gz`, says: NO_ROOM, everyPoll: true },
    prepare: inStep,
  });
  assert.deepEqual(namesIn(result.after.mirror), [baseFile(SHARED_BASE), ...segmentsAt(3, 4, 5)]);
  assert.match(result.log, /ERROR: off-host sync to .* failed: .*No space left on device/);
  assert.doesNotMatch(result.log, /Nothing was deleted/, 'the older one went');
});

test('and with WAL that does not fit and nothing held back, it does not send anyone to take base backups away', () => {
  const result = round({
    cut: { on: '/archive/wal ', holdsBack: '*', says: NO_ROOM, everyPoll: true },
    prepare: ({ archive, target }) => {
      archiveIn(target, { from: 1, to: 3, bases: [SHARED_BASE] });
      archiveIn(archive, { from: 50, to: 53, bases: [SHARED_BASE] });
    },
  });
  assert.deepEqual(result.after.mirror, result.before.mirror, result.log);
  assert.match(result.log, /ERROR: off-host sync to .* failed: .*No space left on device/);
  assert.doesNotMatch(result.log, /Nothing was deleted/);
});

/** ORBIT_BASE_BACKUP_KEEP=1 just after a base backup: the target's only one has left this archive. It still shares a segment. */
const noBaseInCommon = ({ archive, target }) => {
  archiveIn(target, { from: 1, to: 3, bases: [OLD_BASE] });
  archiveIn(archive, { from: 3, to: 5, bases: [NEW_BASE] });
};
/** The same after an outage past retention: nothing in common at all, base backups or segments. */
const fallenBehind = ({ archive, target }) => {
  archiveIn(target, { from: 1, to: 3, bases: [OLD_BASE, SHARED_BASE] });
  archiveIn(archive, { from: 50, to: 53, bases: [NEW_BASE] });
};
/** The target's base backup as it was, what it holds and its time, in a fingerprint. */
const baseLine = (mirror, stamp) => mirror.find((line) => line.startsWith(`${baseFile(stamp)} `));

test('a target with no base backup in common keeps its old one when the new one does not fit, and says so and what to do, every poll', () => {
  for (const [prepare, oldBases, oldSegments, wal] of [[noBaseInCommon, [OLD_BASE], segmentsAt(1, 2, 3), segmentsAt(4, 5)], [fallenBehind, [OLD_BASE, SHARED_BASE], segmentsAt(1, 2, 3), segmentsAt(50, 51, 52, 53)]]) {
    const result = round({
      cut: { on: '.staging-*', holdsBack: `${NEW_BASE}/base.tar.gz`, says: NO_ROOM, everyPoll: true },
      prepare,
    });
    for (const [state, log] of [[result.cutShort.mirror, result.cutShort.log], [result.after.mirror, result.log]]) {
      // Its old base backups, its old segments and all that did fit, and the only thing missing is what had no room.
      assert.deepEqual(namesIn(state), [...oldBases.map(baseFile), ...oldSegments, ...wal], log);
      assert.match(log, STOPPED);
    }
    for (const stamp of oldBases) assert.ok(baseLine(result.after.mirror, stamp), `${stamp} is still whole: ${result.log}`);
    assert.deepEqual(result.rsyncCalls.filter((call) => call.includes('--delete')), [], result.rsyncCalls.join('\n'));
  }
});

test('what a failed round leaves of the new base backup does not count on the next poll, though the target now has that name', () => {
  // The first file sorts first and fits, and at a long interval the next poll has the same stamp. Counting it as shared would
  // take the old base backup then, one poll after keeping it.
  const result = round({
    cut: { on: '.staging-*', holdsBack: `${NEW_BASE}/base.tar.gz`, says: NO_ROOM, everyPoll: true },
    prepare: (dirs) => {
      noBaseInCommon(dirs);
      writeFileSync(path.join(dirs.archive, 'base', NEW_BASE, 'backup_manifest'), 'its manifest');
    },
  });
  assert.ok(namesIn(result.cutShort.mirror).includes(`base/${NEW_BASE}/backup_manifest`), 'the first file landed');
  assert.equal(baseLine(result.after.mirror, OLD_BASE), baseLine(result.before.mirror, OLD_BASE), result.log);
  assert.match(result.log, STOPPED);
  assert.deepEqual(result.rsyncCalls.filter((call) => call.includes('--delete')), [], result.rsyncCalls.join('\n'));
});

test('a full quota says the same', () => {
  const result = round({ cut: { on: '.staging-*', holdsBack: `${NEW_BASE}/base.tar.gz`, says: OVER_QUOTA }, prepare: noBaseInCommon });
  assert.ok(baseLine(result.cutShort.mirror, OLD_BASE), result.cutShort.log);
  assert.match(result.cutShort.log, STOPPED);
});

test('and when there is room again the next poll carries on and ends equal to the archive', () => {
  for (const prepare of [noBaseInCommon, fallenBehind]) {
    const result = round({ cut: { on: '.staging-*', holdsBack: `${NEW_BASE}/base.tar.gz`, says: NO_ROOM }, prepare });
    assert.ok(baseLine(result.cutShort.mirror, OLD_BASE), result.cutShort.log);
    mirrored(result);
    assert.doesNotMatch(result.log, /ERROR/);
  }
});

test('and so it does when a person takes the old one off that disk instead, as the line says', () => {
  const result = round({
    cut: {
      on: '.staging-*',
      holdsBack: `${NEW_BASE}/base.tar.gz`,
      says: NO_ROOM,
      then: ({ target }) => rmSync(path.join(target, 'base', OLD_BASE), { recursive: true }),
    },
    prepare: noBaseInCommon,
  });
  assert.match(result.cutShort.log, STOPPED);
  mirrored(result);
  assert.doesNotMatch(result.log, /ERROR/);
});

test('with room for both it goes through in one round: WAL, then everything with nothing deleted, then --delete', () => {
  for (const prepare of [noBaseInCommon, fallenBehind]) {
    const result = round({ prepare });
    mirrored(result);
    assert.doesNotMatch(result.log, /ERROR/);
    const writes = writesToMirror(result);
    assert.equal(writes.length, 3, result.rsyncCalls.join('\n'));
    assert.ok(writes[0].includes('/archive/wal '), writes[0]);
    assert.doesNotMatch(writes[0], /--delete/);
    assert.ok(writes[1].includes('/archive/ '), writes[1]);
    assert.doesNotMatch(writes[1], /--delete/);
    assert.match(writes[2], /--delete/);
  }
});

test('a pass that holds deletes back and fails stops the round before --delete', () => {
  const result = round({ rsyncFailsOn: '-a --timeout=600 --itemize-changes --exclude .staging-*', prepare: noBaseInCommon });
  assert.deepEqual(result.rsyncCalls.filter((call) => call.includes('--delete')), [], result.rsyncCalls.join('\n'));
  assert.ok(baseLine(result.after.mirror, OLD_BASE), result.log);
  assert.match(result.log, /ERROR: off-host sync to .* failed: .*ssh: connect to host backup-host/);
  assert.doesNotMatch(result.log, /Nothing was deleted/, 'room is not what stopped it');
});

test('a pass that rsync reports a failure in and carries on from, to exit 23, stops the round too: real rsync, no --delete, the old base backup kept', () => {
  // A full disk does this when a directory or a temporary file cannot be made, and --delete-after deletes all the same. Making
  // that here would take a real full disk, so this is the same exit from another cause: a directory where a file has to go.
  const result = round({
    prepare: (dirs) => {
      noBaseInCommon(dirs);
      mkdirSync(path.join(dirs.target, 'base', NEW_BASE, 'base.tar.gz'), { recursive: true });
      writeFileSync(path.join(dirs.target, 'base', NEW_BASE, 'base.tar.gz', 'in the way'), '');
    },
  });
  assert.match(result.log, /ERROR: off-host sync to .* failed: .*\(code 23\)/);
  assert.deepEqual(result.rsyncCalls.filter((call) => call.includes('--delete')), [], result.rsyncCalls.join('\n'));
  assert.equal(baseLine(result.after.mirror, OLD_BASE), baseLine(result.before.mirror, OLD_BASE), result.log);
  assert.ok(result.after.mirror.some((line) => line.startsWith(segmentsAt(5)[0])), 'what could land did');
});

test('once --delete has run it does not say that nothing was deleted', () => {
  // The WAL and everything else landed, a new segment had no room, and the old base backup has gone on the way.
  const result = round({ cut: { on: '--delete', holdsBack: 'no such file', says: NO_ROOM }, prepare: noBaseInCommon });
  assert.equal(baseLine(result.cutShort.mirror, OLD_BASE), undefined, result.cutShort.log);
  assert.match(result.cutShort.log, /ERROR: off-host sync to .* failed: .*No space left on device/);
  assert.doesNotMatch(result.cutShort.log, /Nothing was deleted/);
});

test('WAL keeps landing while a base backup does not fit, with a segment in common or not', () => {
  // rsync walks base/ first and stops at the write that fails, so that this pass sends nothing of wal/.
  const nothing = { on: '.staging-*', holdsBack: '*', says: NO_ROOM, everyPoll: true };
  const shared = round({ cut: nothing, prepare: noBaseInCommon });
  assert.deepEqual(namesIn(shared.after.mirror), [baseFile(OLD_BASE), ...segmentsAt(1, 2, 3, 4, 5)], shared.log);
  const none = round({ cut: nothing, prepare: fallenBehind });
  assert.deepEqual(namesIn(none.after.mirror), [baseFile(OLD_BASE), baseFile(SHARED_BASE), ...segmentsAt(1, 2, 3, 50, 51, 52, 53)], none.log);
});

test('a base backup this archive also holds does not count until all of it is there, as after a sync cut short', () => {
  /** The shared base backup there: lacking a file this archive's has, or with a file of another size or time. */
  const partly = {
    lacking: ({ archive }) => writeFileSync(path.join(archive, 'base', SHARED_BASE, 'pg_wal.tar.gz'), 'its WAL'),
    'another size': ({ target }) => writeFileSync(path.join(target, 'base', SHARED_BASE, 'base.tar.gz'), 'half'),
    'another time': ({ target }) => utimesSync(path.join(target, 'base', SHARED_BASE, 'base.tar.gz'), new Date('2026-02-02T00:00:00Z'), new Date('2026-02-02T00:00:00Z')),
  };
  for (const [how, spoil] of Object.entries(partly)) {
    const prepare = (dirs) => {
      inStep(dirs);
      spoil(dirs);
    };
    const stuck = round({ cut: { on: '.staging-*', holdsBack: `${NEW_BASE}/base.tar.gz`, says: NO_ROOM }, prepare });
    assert.ok(baseLine(stuck.cutShort.mirror, OLD_BASE), `${how}: the whole one stays: ${stuck.cutShort.log}`);
    mirrored(stuck);
    const untouched = round({ prepare });
    assert.equal(writesToMirror(untouched).length, 3, `${how}: ${untouched.rsyncCalls.join('\n')}`);
    mirrored(untouched);
  }
});

test('a base backup of its own that this archive does not hold beside a whole one it does: that one is what stays', () => {
  const result = round({
    cut: { on: '--delete', holdsBack: `${NEW_BASE}/base.tar.gz`, says: NO_ROOM },
    prepare: ({ archive, target }) => {
      archiveIn(target, { from: 3, to: 3, bases: [OLD_BASE, SHARED_BASE] });
      archiveIn(archive, { from: 3, to: 4, bases: [SHARED_BASE, NEW_BASE] });
    },
  });
  assert.deepEqual(namesIn(result.cutShort.mirror), [baseFile(SHARED_BASE), ...segmentsAt(3, 4)]);
  mirrored(result);
});

test('a base listing it cannot make leaves the round where it is: the target\'s stops it, this archive\'s only holds deletes back', () => {
  const there = round({ rsyncFailsOn: 'orbit-pg-archive/base/', prepare: inStep });
  assert.deepEqual(there.after.mirror, there.before.mirror, there.log);
  assert.match(there.log, /ERROR: off-host sync to .* failed: could not read the target: ssh: connect to host backup-host/);
  assert.deepEqual(there.rsyncCalls.filter((call) => call.includes('--delete')), [], there.rsyncCalls.join('\n'));

  const here = round({ rsyncFailsOn: '/archive/base/', prepare: inStep });
  assert.equal(writesToMirror(here).length, 3, here.rsyncCalls.join('\n'));
  mirrored(here);
});

test('a first sync cut short in its WAL has left no base backup there, and the next poll finishes it with nobody acting', () => {
  const result = round({
    cut: { on: '/archive/wal ', holdsBack: `${walName(1, 0).slice(0, -1)}[3-5].gz` },
    prepare: ({ archive }) => archiveIn(archive, { from: 1, to: 5 }),
  });
  assert.deepEqual(namesIn(result.cutShort.mirror), segmentsAt(1, 2));
  assert.match(result.cutShort.log, /ERROR: off-host sync to .* failed: .*connection unexpectedly closed/);
  mirrored(result);
  assert.doesNotMatch(result.log, /ERROR/);
  assert.equal(segmentsRead(result).length, 1, 'that next poll read whose it is, like any other');
});

test('a first sync cut short in its base backups has its WAL there already, and goes on the same way', () => {
  const result = round({
    cut: { on: '--delete', holdsBack: 'base.tar.gz' },
    prepare: ({ archive }) => archiveIn(archive),
  });
  assert.deepEqual(namesIn(result.cutShort.mirror), segmentsAt(1, 2, 3));
  mirrored(result);
  assert.doesNotMatch(result.log, /ERROR/);
  assert.match(result.log, /mirrored \d+ change\(s\) to /, 'what the first pass sent counts, though --delete had nothing left to do');
});

test('on a mirror that has fallen behind, a cut costs it nothing: its segments stay until this archive\'s are there', () => {
  // Every segment it holds has left this archive's retention. --delete alone would clear them before a new one landed.
  const prepare = ({ archive, target }) => {
    archiveIn(target, { from: 1, to: 5, bases: ['20260101T000000Z'] });
    archiveIn(archive, { from: 50, to: 53, bases: ['20260301T000000Z'] });
  };
  const older = segmentsAt(1, 2, 3, 4, 5);
  const inWal = round({ cut: { on: '/archive/wal ', holdsBack: `${walName(1, 0).slice(0, -2)}3[45].gz` }, prepare });
  assert.deepEqual(namesIn(inWal.cutShort.mirror), ['base/20260101T000000Z/base.tar.gz', ...older, ...segmentsAt(50, 51)]);
  mirrored(inWal);
  assert.doesNotMatch(inWal.log, /ERROR/);

  // And with no connection left for the --delete at all.
  const beforeDelete = round({ rsyncFailsOn: '--delete', prepare });
  assert.deepEqual(namesIn(beforeDelete.after.mirror), ['base/20260101T000000Z/base.tar.gz', 'base/20260301T000000Z/base.tar.gz', ...older, ...segmentsAt(50, 51, 52, 53)]);
  assert.match(beforeDelete.log, /ERROR: off-host sync to .* failed: .*ssh: connect to host backup-host/);
});

test('a WAL pass that fails stops the round before --delete', () => {
  const result = round({
    rsyncFailsOn: '/archive/wal ',
    prepare: ({ archive, target }) => {
      archiveIn(archive, { from: 50, to: 52 });
      archiveIn(target, { from: 1, to: 2 });
    },
  });
  assert.deepEqual(result.after.mirror, result.before.mirror, result.log);
  assert.match(result.log, /ERROR: off-host sync to .* failed: ssh: connect to host backup-host/);
  assert.deepEqual(result.rsyncCalls.filter((call) => call.includes('--delete')), [], result.rsyncCalls.join('\n'));
});

test('an archive with no finished segment is not mirrored, though its WAL directory holds other files', () => {
  // Backup history files stay after their segments are trimmed, and the archive script's temporary file comes and goes.
  const prepare = ({ archive, target }, held) => {
    archiveIn(archive, { to: 0 });
    for (const name of [`${walName(1, 1)}.00000028.backup.gz`, `.${walName(1, 2)}.gz.123.tmp`]) writeFileSync(path.join(archive, 'wal', name), 'not a segment');
    if (held) archiveIn(target);
  };
  const first = round({ prepare: (dirs) => prepare(dirs, false) });
  assert.equal(first.after.mirror, null, first.log);
  assert.match(first.log, /ERROR: refusing off-host sync to .*holds no base backup or no WAL/);
  const existing = round({ prepare: (dirs) => prepare(dirs, true) });
  assert.deepEqual(existing.after.mirror, existing.before.mirror, existing.log);
  assert.match(existing.log, /ERROR: refusing off-host sync to .*holds no base backup or no WAL/);
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

test('a round cut short is not pruned on, whichever pass it died in', () => {
  const name = NAME('a');
  for (const rsyncFailsOn of ['/archive/wal ', '--delete']) {
    const result = round({
      due: [name],
      rsyncFailsOn,
      prepare: (dirs) => {
        prepareCopy([name], [NAME('b')])(dirs);
        rmSync(dirs.target, { recursive: true });
      },
    });
    assert.equal(onCopy(result).includes(inCopy(name)), true, result.log);
    assert.doesNotMatch(result.log, /pruned/);
  }
});

test('bytes uploaded again since stay, and what the database names that the copy does not have is no error', () => {
  const [back, never] = [NAME('a'), NAME('b')];
  const result = round({ due: [back, never], prepare: prepareCopy([back], [back]) });
  assert.equal(onCopy(result).includes(inCopy(back)), true, result.log);
  assert.doesNotMatch(result.log, /ERROR|pruned/);
});

test('with no copy there yet there is nothing to prune', () => {
  // This round's copy did not make it either, which leaves the target's directory missing when the prune looks.
  const result = round({
    due: [NAME('a')],
    rsyncFailsOn: '--itemize-changes --exclude /tmp/',
    prepare: ({ archive, files }) => {
      archiveIn(archive);
      mkdirSync(path.join(files, 'bb'), { recursive: true });
    },
  });
  assert.equal(result.after.copy, null, result.log);
  assert.match(result.log, /ERROR: off-host sync to .*-files failed/, 'that is the one thing said');
  assert.doesNotMatch(result.log, /pruning .* failed|refusing to prune|pruned/);
});

test('a copy it cannot list is not pruned, and it says so', () => {
  const name = NAME('a');
  const result = round({
    due: [name],
    rsyncFailsOn: '-r --list-only',
    prepare: prepareCopy([name], [NAME('b')]),
  });
  assert.equal(onCopy(result).includes(inCopy(name)), true, result.log);
  assert.match(result.log, /ERROR: pruning .* failed: could not list it: ssh: connect to host backup-host/);
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
