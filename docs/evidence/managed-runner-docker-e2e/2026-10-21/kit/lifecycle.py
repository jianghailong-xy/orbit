#!/usr/bin/env python3
"""Docker's own record of D4's runner containers and volumes, as a table: lifecycle.py RECORDS_DIR > lifecycle.md"""
import datetime as dt
import json
import sys
from pathlib import Path

records = Path(sys.argv[1])
rows = []
for name in ('docker-events.jsonl', 'docker-volume-events.jsonl'):
    for line in (records / name).read_text().splitlines():
        if not line.strip():
            continue
        e = json.loads(line)
        if e['Type'] == 'container' and e['Action'] in ('create', 'start', 'kill', 'die', 'stop', 'destroy'):
            a = e['Actor']['Attributes']
            rows.append((e['timeNano'], 'container', e['Action'], a.get('name'), a.get('orbit.managed-runner.generation', ''), a.get('exitCode', '')))
        elif e['Type'] == 'volume' and e['Action'] in ('create', 'destroy'):
            rows.append((e['timeNano'], 'volume', e['Action'], e['Actor']['ID'], '', ''))
print('## Runner containers and volumes, by Docker\'s events (instance `orbit-d4-e1a08e4f`)\n')
print('| time (UTC) | object | action | name | generation | exit |')
print('| --- | --- | --- | --- | --- | --- |')
for t, kind, action, name, generation, code in sorted(rows):
    at = dt.datetime.fromtimestamp(t / 1e9, dt.timezone.utc).strftime('%H:%M:%S.%f')[:-3]
    print(f'| {at} | {kind} | {action} | {name} | {generation} | {code} |')
