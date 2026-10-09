#!/usr/bin/env python3
"""order-ties2.py TREE ORDER_A ORDER_B: which same-weight rule pairs could change winner when two builds link the
same stylesheets in a different order.

ORDER_A/ORDER_B: JSON lists of CSS modules in link order (from the chunk maps), A the project tip's, B the
delivery's. For every pair of stylesheets that both builds link, but in opposite order, a pair of rules (one
from each) is a CANDIDATE only if all of these hold, since only then can the reordering change a computed value:
  1. the same specificity (only then does the cascade fall through to order); an !important declaration is
     only compared with an !important one;
  2. an overlapping property (shorthands and logical sides expanded, ties-from-p43a.py's `overlaps`);
  3. the two subjects can be one element: their compounds share a class, OR some JSX element in
     TREE/src/web/src carries a class of one subject and a class of the other (every string literal in its
     className, a `${...}` part read as a wildcard), OR a subject names no class at all (then the pair is
     listed for reading) — unless the two subjects carry different pseudo-elements or two different explicit
     element types, which no single element can be.
Selector lists are split at top-level commas and subjects taken at top-level combinators (inside :is(), :not(),
:has() and attribute values nothing is split). Media/supports conditions are kept with each rule and do not
exclude a pair. Rule extraction and specificity from ties-from-p43a.py (P4.3a's same-specificity check)."""
import importlib.util
import json
import re
import sys
from pathlib import Path

here = Path(__file__).parent
spec = importlib.util.spec_from_file_location('ties', here / 'ties-from-p43a.py')
ties = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ties)
WT = Path('/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3')


def split_top(text, seps):
    """Split at the characters in seps that are outside (), [] and quotes."""
    out, depth, quote, cur = [], 0, None, ''
    for ch in text:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
            continue
        if ch in '"\'':
            quote = ch
            cur += ch
            continue
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if depth == 0 and ch in seps:
            out.append(cur)
            cur = ''
            continue
        cur += ch
    out.append(cur)
    return [x.strip() for x in out if x.strip()]


def subject_of(sel):
    """The last compound of a complex selector, split at top-level combinators only."""
    spaced = ''
    depth = 0
    for ch in sel:
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        spaced += f' {ch} ' if depth == 0 and ch in '>+~' else ch
    parts = [x for x in split_top(spaced, ' \t\n') if x not in ('>', '+', '~')]
    return parts[-1] if parts else sel


def classes(text):
    return set(re.findall(r'\.(-?[_a-zA-Z][\w-]*)', text))


def element_of(compound):
    """(type, pseudo-element) of a compound: 'img', 'i', '*' or None (any type); '::after' etc. or None."""
    t = re.match(r'([a-zA-Z][\w-]*|\*)', compound)
    pe = re.search(r'::?(before|after|placeholder|marker|selection|backdrop|file-selector-button|-webkit-[\w-]+)\b', compound)
    return (t.group(1).lower() if t else None), (pe.group(1) if pe else None)


def same_element_possible(a, b):
    """False when the two subject compounds cannot name one element: different pseudo-elements, or two
    different explicit element types."""
    (ta, pa), (tb, pb) = element_of(a), element_of(b)
    if pa != pb:
        return False
    if ta not in (None, '*') and tb not in (None, '*') and ta != tb:
        return False
    return True


def decls(body):
    out = {}
    for d in split_top(body, ';'):
        if ':' not in d:
            continue
        k, v = d.split(':', 1)
        out[k.strip()] = '!important' in v
    return out


def load(tree, module):
    path = WT / module if module.startswith('node_modules/') else tree / 'src/web/src' / module
    out = []
    for media, sel_list, body in ties.rules(ties.strip_comments(path.read_text())):
        for sel in split_top(sel_list, ','):
            out.append({'media': media, 'sel': sel, 'spec': ties.specificity(sel), 'subj': classes(subject_of(sel)), 'compound': subject_of(sel),
                        'decl': decls(body)})
    return out


def js_words(expr):
    """Class-like words in the string and template literals of a JS expression. A word that runs into a
    template's ${...} is a wildcard ('orbit-alert-*'); literals inside ${...} are read too."""
    words, i, n = set(), 0, len(expr)
    def template(i):
        # expr[i] is the opening backtick; returns the index after the closing one.
        static, i = '', i + 1
        while i < n and expr[i] != '`':
            if expr[i] == '\\':
                static += expr[i:i + 2]; i += 2; continue
            if expr.startswith('${', i):
                depth, j = 1, i + 2
                while j < n and depth:
                    if expr[j] == '`':
                        j = template(j); continue
                    if expr[j] in '\'"':
                        q = expr[j]; j += 1
                        while j < n and expr[j] != q: j += 2 if expr[j] == '\\' else 1
                        j += 1; continue
                    depth += {'{': 1, '}': -1}.get(expr[j], 0); j += 1
                inner = expr[i + 2:j - 1]
                words.update(js_words(inner))
                static += '\x00'; i = j; continue
            static += expr[i]; i += 1
        for t in static.split():
            t = re.sub('\x00+', '*', t)
            if t.startswith('*') or len(t.split('*')[0]) < 3: continue
            words.add(t)
        return i + 1
    while i < n:
        ch = expr[i]
        if ch == '`':
            i = template(i); continue
        if ch in '\'"':
            q, j = ch, i + 1
            while j < n and expr[j] != q: j += 2 if expr[j] == '\\' else 1
            words.update(t for t in expr[i + 1:j].split() if t)
            i = j + 1; continue
        i += 1
    return words


def jsx_class_groups(tree):
    """The classes each JSX element can carry at once: the class-like words of its className (or any
    *ClassName prop) expression, every literal in it counted as possibly present."""
    groups = []
    for f in sorted((tree / 'src/web/src').rglob('*.tsx')):
        if '.test.' in f.name:
            continue
        text = f.read_text()
        for m in re.finditer(r'\b\w*[cC]lassName=\{', text):
            depth, i = 1, m.end()
            while i < len(text) and depth:
                depth += {'{': 1, '}': -1}.get(text[i], 0)
                i += 1
            toks = js_words(text[m.end():i - 1])
            if toks:
                groups.append(toks)
        for m in re.finditer(r'\b\w*[cC]lassName="([^"]*)"', text):
            toks = set(m.group(1).split())
            if toks:
                groups.append(toks)
    return groups


# Wildcards too wide to read as "any class with this prefix": the interpolated value is an enumeration.
EXPANSIONS = {
    'orbit-*': ['orbit-dialog', 'orbit-drawer'],  # ui/Overlay.tsx: `orbit-${kind}`, kind: 'dialog' | 'drawer'
}


def expand(groups):
    return [{e for t in g for e in EXPANSIONS.get(t, [t])} for g in groups]


def matches(tok, cls):
    return re.fullmatch(re.escape(tok).replace(r'\*', r'[\w-]*'), cls) is not None


def cooccur(groups, xs, ys):
    return any(any(matches(t, x) for t in g for x in xs) and any(matches(t, y) for t in g for y in ys) for g in groups)


def main():
    tree = Path(sys.argv[1])
    norm = lambda p: re.sub(r'^src/', '', p)
    a = [norm(p) for p in json.loads(Path(sys.argv[2]).read_text())]
    b = [norm(p) for p in json.loads(Path(sys.argv[3]).read_text())]
    common = [p for p in a if p in b]
    flipped = [(x, y) for i, x in enumerate(common) for y in common[i + 1:]
               if (a.index(x) < a.index(y)) != (b.index(x) < b.index(y))]
    print(f'{len(flipped)} pairs of stylesheets linked in opposite order (the project tip\'s order, then the delivery\'s):')
    for x, y in flipped:
        print(f'  {x} before {y}  ->  {y} before {x}')
    groups = expand(jsx_class_groups(tree))
    cache, candidates, compared, same_spec = {}, [], 0, 0
    for x, y in flipped:
        rx = cache.setdefault(x, load(tree, x))
        ry = cache.setdefault(y, load(tree, y))
        for r in rx:
            for s in ry:
                compared += 1
                if r['spec'] != s['spec']:
                    continue
                same_spec += 1
                shared = sorted({p for p, imp in r['decl'].items() for q, imq in s['decl'].items()
                                 if imp == imq and ties.overlaps(p, q)})
                if not shared:
                    continue
                if not same_element_possible(r['compound'], s['compound']):
                    continue
                if r['subj'] & s['subj']:
                    why = 'shared class ' + ','.join(sorted(r['subj'] & s['subj']))
                elif r['subj'] and s['subj']:
                    if not cooccur(groups, r['subj'], s['subj']):
                        continue
                    why = 'classes co-occur in JSX'
                else:
                    why = 'a subject without a class'
                candidates.append(f'{x} | {y}: [{r["media"]}] {r["sel"]}  vs  [{s["media"]}] {s["sel"]}  {r["spec"]}  {shared}  ({why})')
    print(f'{len(cache)} stylesheets, {compared} rule pairs across the reordered pairs, {same_spec} of the same specificity, '
          f'{len(candidates)} candidates (JSX class groups read: {len(groups)})')
    for c in candidates:
        print('  ' + c)


if __name__ == '__main__':
    main()
