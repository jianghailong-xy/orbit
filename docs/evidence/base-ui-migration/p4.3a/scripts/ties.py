#!/usr/bin/env python3
"""List index.css rules that land on an element this batch now draws with an Orbit component or class.

usage: python3 -I ties.py WORKTREE FILE...

The replaced components' styles were injected ahead of the app's stylesheet (antd cssinjs, prepend
'queue'), so a page rule of the same weight beat them; Orbit component styles load after index.css,
so the same page rule now loses the tie. For each JSX element in FILES that is an Orbit component
(or carries an `orbit-` class) and also carries page classes, print every index.css rule whose
subject compound names one of those page classes, with its specificity and declarations, next to
the Orbit rules for the element's own Orbit classes that set the same properties.
"""
import re
import sys
from pathlib import Path

ORBIT_TAGS = {'Button', 'LinkButton', 'Input', 'Textarea', 'Badge', 'Alert', 'Card', 'Empty', 'Skeleton', 'Segmented',
              'Spinner', 'Checkbox', 'Switch', 'Select', 'MultiSelect', 'Combobox', 'NumberInput', 'RadioGroup', 'Radio',
              'Menu', 'Popconfirm', 'Dialog', 'Tooltip', 'PasswordInput'}
# The root classes an Orbit component draws, as far as the cascade is concerned.
ROOT = {'Button': ['orbit-button'], 'LinkButton': ['orbit-button'], 'Input': ['orbit-input', 'orbit-text-control'],
        'Textarea': ['orbit-textarea', 'orbit-text-control'], 'Badge': ['orbit-badge'], 'Alert': ['orbit-alert'],
        'Card': ['orbit-card'], 'Empty': ['orbit-empty'], 'Skeleton': ['orbit-skeleton'], 'Segmented': ['orbit-segmented'],
        'Spinner': ['orbit-spinner'], 'Checkbox': ['orbit-choice'], 'Switch': ['orbit-switch'], 'Select': ['orbit-select'],
        'MultiSelect': ['orbit-select'], 'Combobox': ['orbit-select'], 'NumberInput': ['orbit-number-input'],
        'RadioGroup': ['orbit-radio-group'], 'Radio': ['orbit-choice'], 'Dialog': ['orbit-overlay'], 'Menu': [], 'Popconfirm': [],
        'Tooltip': []}


def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def rules(css, media=''):
    """(media, selector, declarations) for every style rule, descending into @media/@supports."""
    out, i, n = [], 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j < 0:
            break
        head = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            depth += {'{': 1, '}': -1}.get(css[k], 0)
            k += 1
        body = css[j + 1:k - 1]
        if head.startswith('@media') or head.startswith('@supports') or head.startswith('@layer'):
            out += rules(body, (media + ' ' + head).strip())
        elif not head.startswith('@'):
            out.append((media, head, body))
        i = k
    return out


def specificity(selector):
    s = re.sub(r':where\((?:[^()]|\([^()]*\))*\)', '', selector)
    inner = []
    for m in re.finditer(r':(?:not|is|has)\(((?:[^()]|\([^()]*\))*)\)', s):
        inner.append(max((specificity(part) for part in m.group(1).split(',')), default=(0, 0, 0)))
    s = re.sub(r':(?:not|is|has)\((?:[^()]|\([^()]*\))*\)', '', s)
    a = len(re.findall(r'#[\w-]+', s))
    b = len(re.findall(r'\.[\w-]+', s)) + len(re.findall(r'\[[^\]]*\]', s)) + len(re.findall(r'(?<!:):(?!:)[\w-]+', s))
    c = len(re.findall(r'(?:^|[\s>+~(])([a-zA-Z][\w-]*)', s)) + len(re.findall(r'::[\w-]+', s))
    for x in inner:
        a, b, c = a + x[0], b + x[1], c + x[2]
    return (a, b, c)


def subject(selector):
    parts = re.split(r'\s*[>+~]\s*|\s+(?![^()]*\))', selector.strip())
    return parts[-1] if parts else selector


def props(body):
    return {d.split(':', 1)[0].strip(): d.split(':', 1)[1].strip() for d in body.split(';') if ':' in d and d.strip()}


LOGICAL = {'inline': ('left', 'right'), 'block': ('top', 'bottom'), 'inline-start': ('left',), 'inline-end': ('right',),
           'block-start': ('top',), 'block-end': ('bottom',)}


def longhands(prop):
    """The physical longhands a declaration sets, roughly (shorthands and logical sides expanded)."""
    out = {prop}
    for base in ('margin', 'padding', 'border', 'inset', 'outline', 'font', 'background', 'flex', 'grid', 'gap', 'overflow'):
        if prop == base:
            out |= {f'{base}-{side}' for side in ('top', 'right', 'bottom', 'left')} | {base + '-*'}
        for logical, sides in LOGICAL.items():
            if prop == f'{base}-{logical}':
                out |= {f'{base}-{side}' for side in sides}
    return out


def overlaps(a, b):
    la, lb = longhands(a), longhands(b)
    if la & lb:
        return True
    return any(x.endswith('-*') and y.startswith(x[:-1]) for x in la for y in lb) or \
        any(y.endswith('-*') and x.startswith(y[:-1]) for x in la for y in lb)


def jsx_elements(text):
    """(tag, static classes) of every JSX element with a className."""
    for m in re.finditer(r'<([A-Za-z][\w.]*)\b((?:[^<>]|=>|\{[^{}]*\}|\{(?:[^{}]|\{[^{}]*\})*\})*?)/?>', text, flags=re.S):
        tag, attrs = m.group(1), m.group(2)
        cm = re.search(r'className=(?:"([^"]*)"|\{`([^`]*)`\}|\{\'([^\']*)\'\})', attrs)
        if not cm:
            continue
        literal = next(g for g in cm.groups() if g is not None)
        classes = [c for c in re.split(r'\s+', re.sub(r'\$\{[^}]*\}', ' ', literal)) if c]
        yield tag, classes, text.count('\n', 0, m.start()) + 1


def main():
    root = Path(sys.argv[1])
    css_rules = rules(strip_comments((root / 'src/web/src/index.css').read_text()))
    orbit_rules = []
    for path in sorted((root / 'src/web/src/components/ui').glob('*.css')):
        orbit_rules += [(path.name, m, s, b) for m, s, b in rules(strip_comments(path.read_text()))]
    for file in sys.argv[2:]:
        text = (root / file).read_text()
        for tag, classes, line in jsx_elements(text):
            orbit = [c for c in classes if c.startswith('orbit-')]
            if tag not in ORBIT_TAGS and not orbit:
                continue
            own = ROOT.get(tag, []) + orbit
            page = [c for c in classes if not c.startswith('orbit-')]
            for cls in page:
                hits = []
                for media, sel_list, body in css_rules:
                    for sel in sel_list.split(','):
                        subj = subject(sel)
                        if re.search(r'\.' + re.escape(cls) + r'(?![\w-])', subj):
                            hits.append((media, sel.strip(), specificity(sel), props(body)))
                for media, sel, spec, decl in hits:
                    overlap = []
                    for name, om, osel_list, obody in orbit_rules:
                        for osel in osel_list.split(','):
                            osubj = subject(osel)
                            # The element's own Orbit classes, and the variant/size/state classes its
                            # component adds (`orbit-button` covers `orbit-button-text`, `-small`...).
                            if any(re.search(r'\.' + re.escape(o) + r'(?:-[\w-]+)?(?![\w-])', osubj) for o in own):
                                common = {q for q in props(obody) for d in decl if overlaps(q, d)}
                                if common:
                                    overlap.append(f'{name}: {osel.strip()} {specificity(osel)} {sorted(common)}')
                    flag = 'TIE?' if any(f' {spec} ' in o for o in overlap) else ''
                    print(f'{file}:{line} <{tag} {" ".join(classes)}>  page {media} {sel} {spec} {sorted(decl)} {flag}')
                    for o in overlap[:6]:
                        print(f'      vs {o}')


if __name__ == '__main__':
    main()
