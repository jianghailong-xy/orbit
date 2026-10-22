#!/usr/bin/env python3
"""What durability costs a Git commit on one filesystem: wall-clock times of small and large commits with
Git's defaults and with core.fsync=all (core.fsyncMethod fsync, and batch for comparison), each with and
without a syncfs of the filesystem afterwards, plus the syncfs alone (nothing dirty, and after writing
dirty data). Every case runs in a fresh repository under DIR, which must be empty or absent.

  python3 -I git-commit-timing.py DIR OUT.json [--rounds N]

Writes one JSON record (milliseconds: median, p90, min, max per case) and prints a table.
"""

import ctypes
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import time

LIBC = ctypes.CDLL(None, use_errno=True)
MODES = {
    'default': '',
    'fsync=all': "'core.fsync'='all' 'core.fsyncmethod'='fsync'",
    'fsync=all,batch': "'core.fsync'='all' 'core.fsyncmethod'='batch'",
}


def syncfs(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        if LIBC.syncfs(fd) != 0:
            raise OSError(ctypes.get_errno(), 'syncfs')
    finally:
        os.close(fd)


def filesystem_of(path):
    """The mount that holds path, from /proc/self/mountinfo (no findmnt in the runner image): source, type, options."""
    best = None
    for line in open('/proc/self/mountinfo').read().splitlines():
        fields = line.split()
        point, rest = fields[4], fields[fields.index('-') + 1:]
        if (str(path) + '/').startswith(point.rstrip('/') + '/') and (best is None or len(point) > len(best[0])):
            best = (point, f'{rest[1]} {rest[0]} {fields[5]},{rest[2]}')
    return best and f'{best[1]} on {best[0]}'


def git_env(base, params):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update({'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', 'HOME': str(base),
                'GIT_AUTHOR_NAME': 'Timing', 'GIT_AUTHOR_EMAIL': 'timing@example.invalid',
                'GIT_COMMITTER_NAME': 'Timing', 'GIT_COMMITTER_EMAIL': 'timing@example.invalid'})
    if params:
        env['GIT_CONFIG_PARAMETERS'] = params
    return env


def git(repo, env, *argv):
    subprocess.run(['git', '-C', str(repo), *argv], env=env, check=True, capture_output=True)


def stats(samples):
    s = sorted(samples)
    return {'n': len(s), 'medianMs': round(statistics.median(s), 2), 'p90Ms': round(s[min(len(s) - 1, int(len(s) * 0.9))], 2),
            'minMs': round(s[0], 2), 'maxMs': round(s[-1], 2)}


def commit_case(base, mode, files, rounds, then_syncfs):
    """A fresh repository with one commit; then per round: write `files` new small files, add, commit."""
    repo = base / f'repo-{len(os.listdir(base))}'
    env = git_env(base, MODES[mode])
    git(base, env, 'init', '-q', str(repo))
    (repo / 'seed.txt').write_text('seed\n')
    git(repo, env, 'add', 'seed.txt')
    git(repo, env, 'commit', '-q', '-m', 'seed')
    syncfs(str(repo))
    samples = []
    for r in range(rounds):
        names = []
        for i in range(files):
            name = f'r{r}-{i}.txt'
            (repo / name).write_text(f'round {r} file {i} {time.time_ns()}\n')
            names.append(name)
        start = time.perf_counter()
        git(repo, env, 'add', '-A')
        git(repo, env, 'commit', '-q', '-m', f'round {r}')
        if then_syncfs:
            syncfs(str(repo))
        samples.append((time.perf_counter() - start) * 1000)
        syncfs(str(repo))  # the next round starts from a clean page cache, either way
        time.sleep(0.05)
    shutil.rmtree(repo)
    return stats(samples)


def syncfs_case(base, dirty_bytes, rounds):
    samples = []
    for r in range(rounds):
        syncfs(str(base))
        if dirty_bytes:
            with open(base / f'dirty-{r}.bin', 'wb') as f:
                f.write(os.urandom(dirty_bytes))
        start = time.perf_counter()
        syncfs(str(base))
        samples.append((time.perf_counter() - start) * 1000)
        if dirty_bytes:
            os.unlink(base / f'dirty-{r}.bin')
    syncfs(str(base))
    return stats(samples)


def main():
    base = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2])
    rounds = int(sys.argv[sys.argv.index('--rounds') + 1]) if '--rounds' in sys.argv else 20
    if base.exists() and any(base.iterdir()):
        raise SystemExit(f'{base} is not empty')
    base.mkdir(parents=True, exist_ok=True)
    record = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'dir': str(base),
              'git': subprocess.run(['git', '--version'], capture_output=True, text=True).stdout.strip(),
              'kernel': os.uname().release, 'cpus': os.cpu_count(),
              'filesystem': filesystem_of(base),
              'rounds': rounds, 'cases': {}}
    cases = record['cases']
    for mode in MODES:
        cases[f'commit 1 file, {mode}'] = commit_case(base, mode, 1, rounds, False)
        cases[f'commit 1 file, {mode}, then syncfs'] = commit_case(base, mode, 1, rounds, True)
    for mode in MODES:
        cases[f'commit 200 files, {mode}'] = commit_case(base, mode, 200, max(3, rounds // 4), False)
        cases[f'commit 200 files, {mode}, then syncfs'] = commit_case(base, mode, 200, max(3, rounds // 4), True)
    cases['syncfs, nothing dirty'] = syncfs_case(base, 0, rounds)
    cases['syncfs after 1 MiB written'] = syncfs_case(base, 1 << 20, max(3, rounds // 2))
    cases['syncfs after 64 MiB written'] = syncfs_case(base, 64 << 20, max(3, rounds // 4))
    record['endedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    shutil.rmtree(base)
    out.write_text(json.dumps(record, indent=1) + '\n')
    print(record['git'], record['kernel'], record['filesystem'])
    for name, s in cases.items():
        print(f"  {name:45} median {s['medianMs']:9.2f} ms  p90 {s['p90Ms']:9.2f}  min {s['minMs']:9.2f}  max {s['maxMs']:9.2f}  n {s['n']}")


if __name__ == '__main__':
    main()
