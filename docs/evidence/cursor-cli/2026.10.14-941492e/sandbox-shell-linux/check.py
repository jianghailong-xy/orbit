#!/usr/bin/env python3
"""Check correlations in the recorded Linux shell probe; no CLI or credentials needed."""
import base64
import json
from pathlib import Path

root = Path(__file__).resolve().parent
shells = [json.loads(p.read_text()) for p in sorted(root.glob('[0-9][0-9]-*.json'))]
assert len(shells) == 10
assert shells[0]['argv'][1:4] == ['-O', 'extglob', '-ilc']
assert 'CURSOR_REQUEST_ID' not in shells[0]['env']
commands = ['ls', 'touch auto-allowed.txt', "python3 -c 'print(424242)'",
            'sleep 4; printf background', 'printf foreground',
            'sleep 3; printf concurrent-A', 'sleep 3; printf concurrent-B',
            'sleep 3; printf identical', 'sleep 3; printf identical']
for record, command in zip(shells[1:], commands):
    assert record['argv'][1:4] == ['-O', 'extglob', '-c']
    assert record['argv'][-1] == '--'
    assert record['cwd'] == shells[0]['cwd']
    assert record['fd5_text'] == command + '\0'
    assert base64.b64decode(record['fd5_base64']).decode() == record['fd5_text']
    assert record['fd5_target'].startswith('socket:')
    assert record['env']['CURSOR_API_KEY'] == '<REDACTED>'
for left, right in [(1, 3), (6, 7), (8, 9)]:
    assert shells[left]['argv'] == shells[right]['argv']
    assert shells[left]['env'] == shells[right]['env']
assert shells[8]['pid'] != shells[9]['pid']
assert shells[8]['fd5_target'] != shells[9]['fd5_target']
assert shells[9]['at_ns'] - shells[8]['at_ns'] < 3_000_000_000
messages = [json.loads(line) for line in (root/'process/stdout.jsonl').read_text().splitlines()]
requests = [m for m in messages if m.get('method') == 'session/request_permission']
assert len(requests) == 8
assert not any(m['params']['toolCall']['title'] == '`ls`' for m in requests)
answers = {m['id']: m for m in map(json.loads, (root/'process/stdin.jsonl').read_text().splitlines())
           if 'result' in m}
for request in requests:
    assert answers[request['id']]['result']['outcome']['optionId'] == 'allow-once'
summary = json.loads((root/'summary.json').read_text())
assert [c['input']['command'] for c in summary['cards']] == [commands[2]]
assert any(e['payload'].get('subtype') == 'permission_auto_allowed' and
           e['payload'].get('name') == 'Bash' for e in summary['events'])
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
print('10 shell entries; 9 command payloads; 8 allow-once replies; one card-path approval; identical argv/env verified.')
print('Human UI click and implemented broker/sandbox behavior are not established by this recording.')
