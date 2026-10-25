#!/usr/bin/env python3
"""resolve-p43a.py FILE...: resolve the conflicts between P4.3b and P4.3a (orbit/p4-3a-46ea8e) by content, so the
same rules serve the trial merge of P4.3a's head and, once P4.3a has landed, the rebase of P4.3b onto the project
tip (where each P4.3b commit meets P4.3a's version and the two sides of a conflict are the other way round).

Each conflict block (<<<<<<< ... ======= ... >>>>>>>, with or without a ||||||| base section) is resolved only by a
rule that recognises it; a block no rule recognises is left as it is and the script exits 1 naming it.
  - ui/Alert.tsx, the icon: the side that draws InfoCircleFilled for type="info" (P4.3b) — P4.3a's side is the
    same line without the info branch;
  - ui/Overlay.css, the footer and the Close: P4.3a's wrapping footer rule with its comment, then P4.3b's comment
    for the Close's z-index (the Close rule itself merges on its own);
  - ui/README.md, the Alert row: the side that lists type="info" (P4.3b's row is P4.3a's row plus info);
  - ui-migration/playwright.config.mjs, testIgnore: the entries both lists have, in order, then each side's own,
    sorted (p43a*, p43b*);
  - inventory-delta/README.md: both sides' table rows, each once, in record order (2026-10-08b, 2026-10-09,
    2026-10-09b), each record's row before its builder's."""
import re
import sys

BLOCK = re.compile(r'^<<<<<<< [^\n]*\n(.*?)(?:^\|\|\|\|\|\|\| [^\n]*\n.*?)?^=======\n(.*?)^>>>>>>> [^\n]*\n', re.S | re.M)


def alert_icon(a, b):
    for side in (a, b):
        if "type === 'info' ? <InfoCircleFilled />" in side:
            other = b if side is a else a
            if 'orbit-alert-icon' in other and 'InfoCircleFilled' not in other:
                return side
    return None


def overlay_footer(a, b):
    for wrap, close in ((a, b), (b, a)):
        if 'flex-wrap: wrap' in wrap and '.orbit-overlay-footer' in wrap and 'Above the dialog' in close:
            comment = close[close.index('/* Above the dialog'):]
            return wrap + comment
    return None


def readme_alert(a, b):
    for side, other in ((a, b), (b, a)):
        if side.startswith('| `Alert` |') and other.startswith('| `Alert` |') and 'error/warning/info' in side \
                and 'error/warning/info' not in other:
            return side
    return None


def test_ignore(a, b):
    lists = []
    for side in (a, b):
        m = re.fullmatch(r"(\s*testIgnore: \[)(.*)(\],\n)", side, re.S)
        if not m:
            return None
        lists.append((m.group(1), [x.strip() for x in m.group(2).split(',') if x.strip()], m.group(3)))
    # The entries both lists have, in their order, then each side's own, sorted: the same list whichever side
    # comes first (the merge has P4.3b first, the rebase P4.3a).
    shared = [item for item in lists[0][1] if item in lists[1][1]]
    merged = shared + sorted({item for _, items, _ in lists for item in items} - set(shared))
    head, _, tail = lists[0]
    return head + ', '.join(merged) + tail


def record_key(row):
    """A records-table row's place: the record it is about (`2026-10-09.json` and its `build-record-09.py` both
    belong to 2026-10-09), the record's own row before its builder's. None for a row of another shape."""
    m = re.match(r'\| \[(?:(\d{4}-\d{2}-\d{2}[a-z]?)\.json|build-record-(\d{2}[a-z]?)\.py)\]', row)
    if not m:
        return None
    return (m.group(1), 0) if m.group(1) else (f'2026-10-{m.group(2)}', 1)


def table_rows(a, b):
    rows = [line for side in (a, b) for line in side.splitlines(keepends=True)]
    if not rows or not all(line.startswith('| [') for line in rows):
        return None
    merged = []
    for line in rows:
        if line not in merged:
            merged.append(line)
    # In record order whichever side came first (the merge has P4.3b's 2026-10-09 first, the rebase P4.3a's 09b).
    if all(record_key(line) for line in merged):
        merged.sort(key=record_key)
    return ''.join(merged)


RULES = {
    'src/web/src/components/ui/Alert.tsx': [alert_icon],
    'src/web/src/components/ui/Overlay.css': [overlay_footer],
    'src/web/src/components/ui/README.md': [readme_alert],
    'src/web/ui-migration/playwright.config.mjs': [test_ignore],
    'docs/evidence/base-ui-migration/inventory-delta/README.md': [table_rows],
}


def resolve(path):
    rules = next((r for suffix, r in RULES.items() if path.endswith(suffix)), [])
    text = open(path).read()
    left = []

    def one(m):
        for rule in rules:
            out = rule(m.group(1), m.group(2))
            if out is not None:
                return out
        left.append(m.group(0)[:200])
        return m.group(0)

    resolved = BLOCK.sub(one, text)
    open(path, 'w').write(resolved)
    return left


def main():
    bad = 0
    for path in sys.argv[1:]:
        left = resolve(path)
        if left:
            bad = 1
            print(f'UNRESOLVED {path}:', *left, sep='\n  ')
        else:
            print(f'resolved {path}')
    sys.exit(bad)


main()
