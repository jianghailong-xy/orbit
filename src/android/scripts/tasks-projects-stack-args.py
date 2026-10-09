#!/usr/bin/env python3
"""Instrumentation arguments for RealStackDeviceTest from the isolated stack's own records.

Reads seed.json (ids the stack's seeding read back from its API) and accounts.json (its test accounts) and writes
key=value lines, every value base64, for scripts/tasks-projects-stack-device-test.sh (A11_STACK_ARGS).
Usage: tasks-projects-stack-args.py OUT [STACK_DIR]
"""
import base64
import json
import os
import sys

out = sys.argv[1]
stack = sys.argv[2] if len(sys.argv) > 2 else '/var/tmp/a11-stack'
seed = json.load(open(os.path.join(stack, 'seed.json')))
accounts = json.load(open(os.path.join(stack, 'accounts.json')))
final = seed['finalState']['projects']
main, automatic = seed['projects']['main'], seed['projects']['automatic']

compact = {
    'server': seed['api'].removesuffix('/api'),
    'sourceSha': seed['sourceSha'],
    'accounts': {who: {'id': a['id'], 'email': a['email']} for who, a in seed['accounts'].items()},
    'workspace': {'id': seed['workspace']['id'], 'name': seed['workspace']['name']},
    'lists': {key: {'id': row['id'], 'title': row['title']} for key, row in seed['taskLists'].items()},
    'tasks': {key: {'id': row['id'], 'title': row['title']} for key, row in seed['tasks'].items()},
    'projects': {
        'main': {'id': main['id'], 'title': main['title'], 'coordinatorSessionId': main.get('coordinatorSessionId'),
                 'items': {item['kind']: {'id': item['id'], 'promotionId': item.get('promotionId'), 'taskId': item.get('taskId')}
                           for item in final['main']['openItems']}},
        'notStarted': {'id': seed['projects']['notStarted']['id'], 'title': seed['projects']['notStarted']['title']},
        'automatic': {'id': automatic['id'], 'title': automatic['title'], 'blockerId': final['automatic']['blockersOpen'][0]['id']},
    },
}
# A11b: the two projects nobody has started (seed-start.mjs), when the stack was seeded with them.
for key in ('startAsked', 'startOwn'):
    if key in seed['projects']:
        compact['projects'][key] = {'id': seed['projects'][key]['id'], 'title': seed['projects'][key]['title']}
# A11c: what the owner answers (seed-close.mjs) and the landing that stopped reporting (seed-stuck.mjs), when seeded.
for key, fields in (('closeAsked', ('coordinatorSessionId',)), ('closeDecline', ('coordinatorSessionId',)), ('crossFrom', ()),
                    ('crossTo', ('moves',)), ('runQueue', ('taskId',)), ('landingStuck', ('taskId', 'jobId'))):
    if key in seed['projects']:
        row = seed['projects'][key]
        compact['projects'][key] = {'id': row['id'], 'title': row['title'], **{field: row[field] for field in fields}}
# A08c: the batch-create and merge-check cards seed-a08c.mjs filed through the runner's doors, when seeded.
if 'a08c' in seed:
    row = seed['a08c']
    compact['a08c'] = {'sessionId': row['sessionId'], 'projectId': row['projectId'], 'projectTitle': row['projectTitle'],
                       'batch': {'approvalId': row['batch']['approvalId'], 'taskCount': row['batch']['preview'].get('taskCount'),
                                 'titles': [t['title'] for t in row['batch']['tasks']]},
                       'merge': {'approvalId': row['merge']['approvalId'], 'proposed': row['merge']['input']['mergeCheckCommand']}}
b64 = lambda text: base64.b64encode(text.encode()).decode()
lines = {
    'a11Seed': json.dumps(compact, ensure_ascii=False, separators=(',', ':')),
    'ownerEmail': accounts['owner']['email'], 'ownerPassword': accounts['owner']['password'],
    'memberEmail': accounts['member']['email'], 'memberPassword': accounts['member']['password'],
}
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    for key, value in lines.items():
        f.write(f'{key}={b64(value)}\n')
print(f'wrote {out}: {", ".join(lines)}')
