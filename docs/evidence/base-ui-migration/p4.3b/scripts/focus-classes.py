#!/usr/bin/env python3
"""focus-classes.py REF_REPORT DEL_REPORT: every step whose focus differs between the two trees (trace-semantics.py
counts them as presentation), grouped by step and the role each tree's focus is on, with the environments."""
import base64, collections, json, sys


def traces(path):
    found = {}
    def walk(suite, prefix):
        for child in suite.get('suites', []):
            walk(child, prefix + [child['title']])
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                for result in test['results']:
                    for a in result.get('attachments', []):
                        if a['name'] == 'trace' and 'body' in a:
                            found[(test['projectName'], ' › '.join(prefix[1:] + [spec['title']]))] = json.loads(base64.b64decode(a['body']))
    for suite in json.load(open(path))['suites']:
        walk(suite, [suite['title']])
    return found


def where(focus):
    if focus == 'body' or focus is None:
        return 'body'
    return f"{focus.get('role')}: {str(focus.get('name'))[:48]}"


ref, dele = traces(sys.argv[1]), traces(sys.argv[2])
groups = collections.defaultdict(list)
for key in sorted(set(ref) & set(dele)):
    for rs, ds in zip(ref[key], dele[key]):
        if rs.get('focus') != ds.get('focus'):
            groups[(key[1][:70], rs.get('step'), where(rs.get('focus')), where(ds.get('focus')))].append(key[0])
total = sum(len(v) for v in groups.values())
print(f'{total} steps with different focus, {len(groups)} kinds')
for (test, step, r, d), envs in sorted(groups.items()):
    print(f'{len(envs)} | {test} | {step} | reference {r} | delivery {d} | {",".join(sorted(e.replace("-desktop","-d").replace("-phone","-p") for e in envs))}')
