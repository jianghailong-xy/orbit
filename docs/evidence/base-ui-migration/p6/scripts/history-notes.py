#!/usr/bin/env python3
"""The history notes P6 took out of src/web/src (P0.1: "历史说明移入证据目录"), as they were: every removed line of
the given commits' diffs, under src/web/src, that names the component library (antd / AntD / ant-*), in full, with
the line that replaced it when the hunk has one; one table per commit. Run from the repository root.

usage: history-notes.py COMMIT... > history-notes.md
"""
import re
import subprocess
import sys

NAMED = re.compile(r'\bantd\b|AntD|antd-empty|(?<![\w@-])ant-[\w-]+', re.I)
for commit in sys.argv[1:]:
    print(f"\n### {subprocess.run(['git', 'log', '-1', '--format=%h %s', commit], capture_output=True, text=True, check=True).stdout.strip()}\n")
    print('| 文件 | 原行 | 现行 |\n| --- | --- | --- |')
    diff = subprocess.run(['git', 'show', '--format=', '--unified=0', commit, '--', 'src/web/src'], capture_output=True, text=True, check=True).stdout
    path = None
    removed, added = [], []
    def flush():
        for i, line in enumerate(removed):
            if NAMED.search(line):
                now = added[i] if i < len(added) else ''
                cell = lambda text: text.strip().replace('|', '\\|').replace("`", "'")
                print(f'| `{path}` | {cell(line)} | {cell(now) or "（删除）"} |')
        removed.clear(); added.clear()
    for line in diff.splitlines():
        if line.startswith('+++ '):
            flush(); path = line[6:] if line.startswith('+++ b/') else path
        elif line.startswith('--- '):
            flush()
            if line != '--- /dev/null': path = line[6:]
        elif line.startswith('@@'):
            flush()
        elif line.startswith('-'):
            removed.append(line[1:])
        elif line.startswith('+'):
            added.append(line[1:])
    flush()
