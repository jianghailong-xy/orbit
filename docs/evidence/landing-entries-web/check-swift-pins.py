#!/usr/bin/env python3
"""No web literal that OrbitKit's copy-parity tests pin has moved.

The five tests that read `src/web` (ProjectPageSectionsCopyParityTests, ProjectMergeCopyParityTests,
SessionProjectCopyParityTests, OpenItemDeliveryCopyParityTests, TaskDetailCopyParityTests) pin
literals with `web.contains(...)` / `assertSays(web, ...)`. This task changed no Swift file, so the
question is whether anything they pin moved: the set of literals that cannot be found is compared
with the same set read from another tree.

    check-swift-pins.py --against <git-ref>     # a ref in this repository (default: HEAD)

A literal this crude reader cannot find is not automatically a drift — a multi-line TSX snippet or
one with escaped quotes is beyond it — which is exactly why the two SETS are compared rather than
each literal judged: a pinned literal this task moved appears on one side and not the other.
"""
import argparse, pathlib, re, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
TESTS = 'src/macos/OrbitKit/Tests/OrbitKitTests'
FILES = [
    'ProjectPageSectionsCopyParityTests.swift', 'ProjectMergeCopyParityTests.swift',
    'SessionProjectCopyParityTests.swift', 'OpenItemDeliveryCopyParityTests.swift',
    'TaskDetailCopyParityTests.swift',
]
CALL = re.compile(r'(?:assertSays|require|contains)\(\s*web[a-zA-Z]*\s*,\s*("(?:[^"\\]|\\.)*")')


def scan(root: pathlib.Path) -> tuple[int, set[str]]:
    cache: dict[str, str] = {}

    def source(rel: str) -> str:
        if rel not in cache:
            cache[rel] = (root / rel).read_text(encoding='utf-8')
        return cache[rel]

    checked, missing = 0, set()
    for name in FILES:
        text = (root / TESTS / name).read_text(encoding='utf-8')
        files = re.findall(r'"((?:src/web)/[^"]+)"', text)
        for literal in CALL.findall(text):
            if '\\(' in literal:
                continue
            value = literal[1:-1].replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')
            checked += 1
            if not any(value in source(rel) for rel in files if (root / rel).exists()):
                missing.add(f'{name}: {value!r}')
    return checked, missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--against', default='HEAD', help='git ref to compare with (default HEAD)')
    args = parser.parse_args()

    checked, mine = scan(ROOT)
    print(f'checked {checked} pinned literals across {len(FILES)} tests in the working tree')

    with tempfile.TemporaryDirectory() as tmp:
        base = pathlib.Path(tmp) / 'base'
        subprocess.run(['git', 'worktree', 'add', '--detach', str(base), args.against],
                       cwd=ROOT, check=True, capture_output=True)
        try:
            _, theirs = scan(base)
        finally:
            subprocess.run(['git', 'worktree', 'remove', '--force', str(base)],
                           cwd=ROOT, check=False, capture_output=True)

    print(f'{len(mine)} not found here, {len(theirs)} at {args.against} (the crude reader\'s blind spots)')
    moved = sorted(mine.symmetric_difference(theirs))
    if moved:
        print('PINNED LITERALS MOVED:')
        print('\n'.join(moved))
        return 1
    print('no pinned literal moved')
    return 0


if __name__ == '__main__':
    sys.exit(main())
