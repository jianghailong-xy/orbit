#!/usr/bin/env python3
"""Which of Git's writes are durable when the command returns: each Git operation a runner or an engine
does, run under strace, with Git's defaults and with the runner's settings (core.fsync=all,
core.fsyncMethod=fsync, given the way the runner gives them: GIT_CONFIG_PARAMETERS).

For every file an operation leaves behind (a renamed lock or temporary file, a hard link, a file written
in place) it records whether its content was fsynced before it was put in place, and whether any fsync
or syncfs followed the operation that put it there. On a journaled ext4 volume an fsync commits the
running journal transaction, which carries every earlier rename and creation, so "named durably" means:
something in the same command fsynced after it. A file that is neither is in the page cache only and
can come back empty or missing after a power cut.

  python3 -I git-fsync-coverage.py SCRATCH_DIR OUT.json

SCRATCH_DIR must be empty or absent. Needs strace and git. Writes one JSON record.
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

MODES = {
    'default': {},
    'committed,index': {'GIT_CONFIG_PARAMETERS': "'core.fsync'='committed,index' 'core.fsyncmethod'='fsync'"},
    'all': {'GIT_CONFIG_PARAMETERS': "'core.fsync'='all' 'core.fsyncmethod'='fsync'"},
}
TRACED = 'openat,open,creat,rename,renameat,renameat2,link,linkat,unlink,unlinkat,mkdir,mkdirat,chdir,' \
         'write,pwrite64,writev,ftruncate,fsync,fdatasync,sync_file_range,syncfs,sync'
LINE = re.compile(r'^(\d+) +(.*)$')
CALL = re.compile(r'^([a-z0-9_]+)\((.*)\) += (-?\d+|\?)(?:<([^>]*)>)?')
FD = re.compile(r'^(?:AT_FDCWD|\d+)<([^>]*)>$')


def split_args(text):
    """Top-level comma split of a strace argument list (quoted strings and brackets kept whole)."""
    out, depth, quote, cur, i = [], 0, False, '', 0
    while i < len(text):
        c = text[i]
        if quote:
            cur += c
            if c == '\\':
                cur += text[i + 1]
                i += 1
            elif c == '"':
                quote = False
        elif c == '"':
            quote, cur = True, cur + c
        elif c in '[{(':
            depth, cur = depth + 1, cur + c
        elif c in ']})':
            depth, cur = depth - 1, cur + c
        elif c == ',' and depth == 0:
            out.append(cur.strip())
            cur = ''
        else:
            cur += c
        i += 1
    if cur.strip():
        out.append(cur.strip())
    return out


def unquote(arg):
    if arg.startswith('"'):
        return arg[1:arg.rindex('"')].encode().decode('unicode_escape')
    return arg


def fd_path(arg):
    m = FD.match(arg)
    return m.group(1) if m else None


def parse(trace_text):
    """strace -f -y output to [(pid, syscall, args, result, result_path)], unfinished calls joined."""
    pending, events = {}, []
    for raw in trace_text.splitlines():
        m = LINE.match(raw)
        if not m:
            continue
        pid, rest = m.groups()
        if rest.endswith('<unfinished ...>'):
            pending[pid] = rest[:-len('<unfinished ...>')].rstrip()
            continue
        resumed = re.match(r'^<\.\.\. ([a-z0-9_]+) resumed>(.*)$', rest)
        if resumed:
            rest = pending.pop(pid, resumed.group(1) + '(') + resumed.group(2)
        c = CALL.match(rest)
        if not c:
            continue
        name, args, result, result_path = c.groups()
        if result == '?' or result.startswith('-'):
            continue
        events.append((pid, name, split_args(args), result, result_path))
    return events


def analyse(events, root):
    """Per final path: how it got there, whether its content was fsynced first, and whether an fsync followed."""
    cwd = {}
    state = {}  # path -> {'how', 'at', 'contentSynced', 'source'}
    written = {}  # path -> index of last write
    synced_at = {}  # path -> list of fsync indexes
    commits = []  # indexes of fsync/fdatasync/syncfs calls (each commits the ext4 journal)
    fsynced_paths = []

    def absolute(pid, path, dirfd=None):
        if path.startswith('/'):
            return os.path.normpath(path)
        base = fd_path(dirfd) if dirfd else None
        return os.path.normpath(os.path.join(base or cwd.get(pid, root), path))

    for i, (pid, name, args, result, result_path) in enumerate(events):
        for a in args:
            if a.startswith('AT_FDCWD<'):
                cwd[pid] = fd_path(a)
        if name == 'chdir':
            cwd[pid] = absolute(pid, unquote(args[0]))
        elif name in ('openat', 'open', 'creat'):
            flags = args[2] if name == 'openat' else (args[1] if name == 'open' else 'O_CREAT')
            if 'O_CREAT' in flags and result_path:
                p = os.path.normpath(result_path)
                if p not in state or 'O_TRUNC' in flags or 'O_EXCL' in flags:
                    state[p] = {'how': 'created', 'at': i, 'contentSyncedAt': None, 'source': None}
            if 'O_TRUNC' in flags and result_path:
                written[os.path.normpath(result_path)] = i
        elif name in ('write', 'pwrite64', 'writev', 'ftruncate'):
            p = fd_path(args[0])
            if p:
                written[os.path.normpath(p)] = i
                if os.path.normpath(p) not in state:
                    state[os.path.normpath(p)] = {'how': 'written in place', 'at': i, 'contentSyncedAt': None, 'source': None}
        elif name in ('fsync', 'fdatasync'):
            p = fd_path(args[0])
            commits.append(i)
            if p:
                p = os.path.normpath(p)
                synced_at.setdefault(p, []).append(i)
                fsynced_paths.append(p)
        elif name == 'syncfs':
            commits.append(i)
            fsynced_paths.append('syncfs:' + (fd_path(args[0]) or '?'))
        elif name == 'sync':
            commits.append(i)
            fsynced_paths.append('sync')
        elif name in ('rename', 'renameat', 'renameat2', 'link', 'linkat'):
            if name in ('rename', 'link'):
                src, dst = absolute(pid, unquote(args[0])), absolute(pid, unquote(args[1]))
            else:
                src, dst = absolute(pid, unquote(args[1]), args[0]), absolute(pid, unquote(args[3]), args[2])
            src_written = written.get(src, -1)
            src_synced = [s for s in synced_at.get(src, []) if s > src_written]
            state[dst] = {'how': 'renamed' if name.startswith('rename') else 'hard-linked', 'at': i,
                          'contentSyncedAt': src_synced[-1] if src_synced else None, 'source': src}
            written[dst] = max(written.get(dst, -1), -1) if name.startswith('link') else src_written
            if name.startswith('rename'):
                state.pop(src, None)
                synced_at[dst] = synced_at.pop(src, [])
        elif name in ('unlink', 'unlinkat'):
            p = absolute(pid, unquote(args[1] if name == 'unlinkat' else args[0]), args[0] if name == 'unlinkat' else None)
            state.pop(p, None)

    files = []
    for path, s in sorted(state.items()):
        if not path.startswith(root + '/') or not os.path.exists(path) or os.path.isdir(path):
            continue
        last_write = written.get(path, -1)
        content_synced = s['contentSyncedAt'] is not None and s['how'] in ('renamed', 'hard-linked') and last_write <= s['at']
        if not content_synced:
            content_synced = any(x > last_write for x in synced_at.get(path, []))
        synced_after = any(c > max(s['at'], last_write) for c in commits) or any(c > s['at'] for c in synced_at.get(path, []))
        files.append({'path': os.path.relpath(path, root), 'kind': kind(os.path.relpath(path, root)), 'how': s['how'],
                      'contentSynced': content_synced, 'namedDurably': synced_after})
    return files, fsynced_paths


def kind(rel):
    parts = rel.split('/')
    if '.git' in parts:
        sub = '/'.join(parts[parts.index('.git') + 1:])
    else:
        return 'worktree .git file' if parts[-1] == '.git' else 'checked-out file'
    for pattern, label in (
            (r'^objects/[0-9a-f]{2}/[0-9a-f]{38}$', 'loose object'),
            (r'^objects/pack/.*\.pack$', 'pack'),
            (r'^objects/pack/.*\.(idx|rev|bitmap|mtimes|keep|promisor)$', 'pack metadata'),
            (r'^objects/info/commit-graph.*', 'commit-graph'),
            (r'^objects/info/.*', 'object info'),
            (r'^refs/', 'ref'),
            (r'^packed-refs$', 'packed-refs'),
            (r'^HEAD$', 'HEAD'),
            (r'^worktrees/[^/]+/HEAD$', 'worktree HEAD'),
            (r'^(worktrees/[^/]+/)?index$', 'index'),
            (r'^logs/', 'reflog'),
            (r'^worktrees/[^/]+/logs/', 'reflog'),
            (r'^config(\.worktree)?$', 'config'),
            (r'^worktrees/[^/]+/(gitdir|commondir|locked)$', 'worktree metadata'),
            (r'^(worktrees/[^/]+/)?(ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|MERGE_MSG|MERGE_MODE|AUTO_MERGE|COMMIT_EDITMSG|REBASE_HEAD|CHERRY_PICK_HEAD)$', 'operation state'),
            (r'^(hooks/|description$|info/)', 'init skeleton'),
    ):
        if re.match(pattern, sub):
            return label
    return 'other: ' + sub


SCENARIO = [
    # (label, cwd relative to the scratch dir, argv)
    ('init', '.', ['git', 'init', '-q', '-b', 'main', 'repo']),
    ('config', 'repo', ['git', 'config', 'user.name', 'Probe']),
    ('write file', 'repo', ['sh', '-c', 'printf "one\\n" > note.txt']),
    ('add', 'repo', ['git', 'add', 'note.txt']),
    ('first commit (new branch ref)', 'repo', ['git', 'commit', '-q', '-m', 'first']),
    ('second commit (existing ref)', 'repo', ['sh', '-c', 'printf "two\\n" >> note.txt && git commit -q -am second']),
    ('branch', 'repo', ['git', 'branch', 'feature']),
    ('worktree add -b', 'repo', ['git', 'worktree', 'add', '-q', '-b', 'session', '../wt', 'HEAD']),
    ('commit in worktree', 'wt', ['sh', '-c', 'printf "wt\\n" > wt.txt && git add wt.txt && git commit -q -m "in worktree"']),
    ('update-ref', 'repo', ['git', 'update-ref', 'refs/orbit/base', 'HEAD~1']),
    ('merge --no-ff', 'repo', ['git', 'merge', '-q', '--no-ff', '-m', 'merge session', 'session']),
    ('reset --hard', 'repo', ['git', 'reset', '-q', '--hard', 'HEAD~1']),
    ('checkout -b', 'repo', ['git', 'checkout', '-q', '-b', 'other']),
    ('symbolic-ref', 'repo', ['git', 'symbolic-ref', 'HEAD', 'refs/heads/main']),
    ('tag -a', 'repo', ['git', 'tag', '-a', '-m', 'tag', 'v1']),
    ('stash', 'repo', ['sh', '-c', 'printf "dirty\\n" >> note.txt && git stash -q']),
    ('rebase', 'wt', ['git', 'rebase', '-q', 'main']),
    ('pack-refs', 'repo', ['git', 'pack-refs', '--all']),
    ('gc (repack, commit-graph)', 'repo', ['git', 'gc', '-q']),
    ('clone --no-local', '.', ['git', 'clone', '-q', '--no-local', 'repo', 'clone']),
    ('fetch', 'clone', ['sh', '-c', 'git -C ../repo commit -q --allow-empty -m upstream && git fetch -q origin']),
    ('worktree remove', 'repo', ['git', 'worktree', 'remove', '--force', '../wt']),
]


def run(scratch, mode, env_extra):
    base = scratch / mode.replace(',', '-')
    base.mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update({'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_AUTHOR_NAME': 'Probe',
                'GIT_AUTHOR_EMAIL': 'probe@example.invalid', 'GIT_COMMITTER_NAME': 'Probe',
                'GIT_COMMITTER_EMAIL': 'probe@example.invalid', 'HOME': str(base), **env_extra})
    ops = []
    for label, where, argv in SCENARIO:
        trace = base / 'trace.txt'
        proc = subprocess.run(['strace', '-f', '-qq', '-y', '-e', f'trace={TRACED}', '-o', str(trace), *argv],
                              cwd=base / where, env=env, capture_output=True, text=True)
        if proc.returncode != 0:
            raise SystemExit(f'{mode} {label}: exit {proc.returncode}: {proc.stderr.strip()}')
        files, fsynced = analyse(parse(trace.read_text()), str(base))
        trace.unlink()
        ops.append({'op': label, 'argv': argv, 'fsyncCalls': len([p for p in fsynced if not p.startswith('sync')]),
                    'syncfsCalls': len([p for p in fsynced if p.startswith('sync')]), 'files': files})
    return ops


def summary(ops):
    """Per kind of file: in how many operation results it was content-synced and durably named, of how many."""
    table = {}
    for op in ops:
        for f in op['files']:
            if f['kind'] == 'checked-out file' and op['op'] == 'write file':
                continue
            row = table.setdefault(f['kind'], {'files': 0, 'contentSynced': 0, 'namedDurably': 0, 'both': 0, 'ops': set()})
            row['files'] += 1
            row['contentSynced'] += f['contentSynced']
            row['namedDurably'] += f['namedDurably']
            row['both'] += f['contentSynced'] and f['namedDurably']
            row['ops'].add(op['op'])
    return {k: {**v, 'ops': sorted(v['ops'])} for k, v in sorted(table.items())}


def main():
    scratch, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
    if scratch.exists() and any(scratch.iterdir()):
        raise SystemExit(f'{scratch} is not empty')
    scratch.mkdir(parents=True, exist_ok=True)
    record = {'git': subprocess.run(['git', '--version'], capture_output=True, text=True).stdout.strip(),
              'strace': subprocess.run(['strace', '-V'], capture_output=True, text=True).stdout.splitlines()[0],
              'kernel': os.uname().release,
              'filesystem': subprocess.run(['findmnt', '-no', 'FSTYPE,OPTIONS', '--target', str(scratch)],
                                           capture_output=True, text=True).stdout.strip(),
              'modes': {}}
    for mode, env_extra in MODES.items():
        ops = run(scratch, mode, env_extra)
        record['modes'][mode] = {'env': env_extra, 'summary': summary(ops), 'ops': ops}
    shutil.rmtree(scratch)
    out.write_text(json.dumps(record, indent=1) + '\n')
    for mode, data in record['modes'].items():
        print(f'== {mode}')
        for k, v in data['summary'].items():
            print(f"  {k:22} files {v['files']:3}  content synced {v['contentSynced']:3}  named durably {v['namedDurably']:3}  both {v['both']:3}")


if __name__ == '__main__':
    main()
