#!/usr/bin/env python3
"""Verify the committed macOS invocation matrix without a CLI or credentials."""
import base64
import json
from pathlib import Path

root = Path(__file__).resolve().parent
shells = [json.loads(p.read_text()) for p in sorted(root.glob('[0-9][0-9]-*.json'))]
assert len(shells) == 10
assert shells[0]['argv'][1:4] == ['-O', 'extglob', '-ilc']
assert len(shells[0]['argv'][-1]) == 4793
assert len(shells[0]['env']) == 34
assert 'CURSOR_REQUEST_ID' not in shells[0]['env']
commands = ['ls', 'touch auto-allowed.txt', "python3 -c 'print(424242)'",
            'sleep 4; printf background', 'printf foreground',
            'sleep 3; printf concurrent-B', 'sleep 3; printf concurrent-A',
            'sleep 3; printf identical', 'sleep 3; printf identical']
for record, command in zip(shells[1:], commands):
    assert record['argv'][1:4] == ['-O', 'extglob', '-c']
    assert record['argv'][-1] == '--'
    assert record['argv'] == shells[1]['argv']
    assert record['cwd'] == shells[0]['cwd']
    assert len(record['env']) == 39
    assert record['fd5_text'] == command + '\0'
    assert base64.b64decode(record['fd5_base64']).decode() == record['fd5_text']
    assert record['env']['CURSOR_API_KEY'] == '<REDACTED>'
    assert record['env_source'].startswith('native wrapper main environ')
for left, right in [(1, 2), (1, 3), (4, 5), (6, 7), (8, 9)]:
    assert shells[left]['env'] == shells[right]['env']
for left, right in [(6, 7), (8, 9)]:
    assert shells[left]['pid'] != shells[right]['pid']
    assert 0 <= shells[right]['at_ns'] - shells[left]['at_ns'] < 3_000_000_000
messages = [json.loads(line) for line in (root/'process/stdout.jsonl').read_text().splitlines()]
requests = [m for m in messages if m.get('method') == 'session/request_permission']
assert len(requests) == 8
assert not any(m['params']['toolCall']['title'] == '`ls`' for m in requests)
answers = {m['id']: m for m in map(json.loads, (root/'process/stdin.jsonl').read_text().splitlines()) if 'result' in m}
for request in requests:
    assert answers[request['id']]['result']['outcome']['optionId'] == 'allow-once'
summary = json.loads((root/'summary.json').read_text())
assert [c['input']['command'] for c in summary['cards']] == [commands[2]]
assert len(summary['completions']) == 4
assert any(e['payload'].get('subtype') == 'permission_auto_allowed' for e in summary['events'])
assert any('writable root is unavailable' in e['payload'].get('notice', '') for e in summary['events'])
timeline = [json.loads(line) for line in (root/'process/timeline.jsonl').read_text().splitlines()]
starts, finishes = {}, {}
for row in timeline:
    update = row['line'].get('params', {}).get('update', {})
    call_id = update.get('toolCallId')
    if update.get('sessionUpdate') == 'tool_call':
        starts[call_id] = (row['t'], update.get('rawInput', {}).get('command'))
    if update.get('status') == 'completed' and 'rawOutput' in update:
        finishes[call_id] = (row['t'], update['rawOutput'])
for call_id, (start, command) in starts.items():
    if command and command.startswith('sleep '):
        finish, output = finishes[call_id]
        assert finish - start < int(command.split()[1].rstrip(';')) * 1000
        assert output['exitCode'] == 0 and output['stdout'] == ''
detection = json.loads((root/'detection.json').read_text())
assert detection['detectionAvailable'] and detection['detectionReason'] == ''
assert detection['trialError'] == '<nil>' and detection['trialOutput'] == ''
assert detection['peerStartIdentity'] == ''
nested = json.loads((root/'engine-sandbox-trial.json').read_text())
assert nested['argv'] == detection['argv']
assert nested['exitCode'] == 71 and 'sandbox_apply: Operation not permitted' in nested['stderr']
standing = json.loads((root/'standing-grant/summary.json').read_text())['facts']['productionDecision']
assert standing['status'] == 'ALLOWED' and standing['standingGrant']
assert not standing.get('decidedById')
assert (root/'person-card/summary.json').exists(), 'GAP: explicit person-card decision has not been recorded yet'
person = json.loads((root/'person-card/summary.json').read_text())
decision = person['facts']['productionDecision']
assert decision['status'] == 'ALLOWED' and decision['decidedById']
assert not decision.get('standingGrant')
assert all(c['pass'] for c in person['checks'])
records = json.loads((root/'person-card/shell.json').read_text())
assert len(records) == 2
approved = next(r for r in records if 'fd5_text' in r)
assert approved['fd5_text'] == commands[2] + '\0'
assert approved['argv'][1:] == shells[3]['argv'][1:]
assert set(approved['env']) == set(shells[3]['env'])
print('Verified: snapshot; 9 commands; unasked/Auto/card routes; background and both concurrent pairs; actual person and standing-grant decisions; host/nested Seatbelt trials.')
print('Grant design is portable; Linux process authentication is not. This recording does not verify a macOS sandbox implementation.')
