"""Slim copy of a raw Playwright run (the project's evidence-size rule of 2026-10-07).

slim_run(raw, dest) writes into dest:
- report.summary.json: the report's stats and errors, and for every test its title, file:line, project, status,
  and per result the status, duration, retry, error messages and attachment names, content types and the SHA-256 of
  each body; no bodies and no traces (those stay in the raw run);
- environment.json, copied;
- samples.csv when the run carries keyboard-window-2, held-frames-2 or (p2-select-keys) select-keys records: one line
  per sample (columns below).

`python3 slim.py <raw> <dest>` does the same from the command line."""
import base64
import csv
import hashlib
import json
import shutil
import sys
from pathlib import Path

COLUMNS = ['test', 'target', 'kind', 'sequence', 'control', 'mode', 'run', 'keys', 'result', 'window', 'handoff', 'keylog']


def compact(log):
    """`key>target[popups|f=focused|h=highlighted]@ms` per keydown; * marks an untrusted (page-dispatched) key."""
    parts = []
    for key in log:
        if key['key'] == 'Shift':
            continue
        name = 'Space' if key['key'] == ' ' else key['key']
        if key.get('shift'):
            name = f'Shift+{name}'
        parts.append(f"{name}{'' if key['trusted'] else '*'}>{key['target']}[{key.get('popups')}|f={key.get('focused')}|h={key.get('highlighted')}]@{key.get('t', '')}")
    return ' ; '.join(parts)


def window_hit(log):
    """The key after the opener reached the opener's target while the popup the opener asked for was shown."""
    trusted = [key for key in log if key['trusted'] and key['key'] != 'Shift']
    if len(trusted) < 2:
        return 0
    opener, following = trusted[0], trusted[1]
    if 'count' not in following:  # the earlier probes log only whether a list was shown
        return int(following['target'] == opener['target'] and bool(following.get('listbox')))
    return int(following['target'] == opener['target'] and following['count'] > opener.get('count', 0))


def slim_run(raw, dest):
    raw, dest = Path(raw), Path(dest)
    report = json.loads((raw / 'report.json').read_text())
    dest.mkdir(parents=True)
    shutil.copyfile(raw / 'environment.json', dest / 'environment.json')
    tests, samples = [], []

    def visit(suite):
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                results = []
                for result in test['results']:
                    attachments = []
                    for attachment in result.get('attachments', []):
                        if 'body' in attachment:
                            body = base64.b64decode(attachment['body'])
                        elif attachment.get('path') and Path(attachment['path']).exists():
                            body = Path(attachment['path']).read_bytes()
                        else:
                            body = None
                        entry = {'name': attachment['name'], 'contentType': attachment['contentType'],
                                 'path': attachment.get('path'), 'sha256': hashlib.sha256(body).hexdigest() if body is not None else None}
                        attachments.append(entry)
                        if attachment['name'] in ('keyboard-window-2', 'held-frames-2', 'select-keys') and body is not None:
                            record = json.loads(body)
                            log = record.get('keyLog', [])
                            if attachment['name'] == 'select-keys':
                                # The Select fix's probe (p2-select-keys): value shown, whether a list is still open.
                                record = {**record, 'kind': 'select-keys',
                                          'result': f"{record['after']} | list {'open' if record.get('listboxOpen') else 'closed'} | @{record.get('active')}"}
                            if attachment['name'] == 'held-frames-2':
                                # A held-frames case: its name is the sequence, its result the state after the frames ran.
                                before, after = record['before'], record['after']
                                changed = ', '.join(f'{k}={v}' for k, v in after['outputs'].items() if before['outputs'].get(k) != v) or 'none'
                                record = {**record, 'target': '', 'kind': 'held', 'sequence': record['name'], 'mode': 'held', 'run': '',
                                          'result': f"{changed} | {after['popups']} | @{after['active']}"}
                            samples.append({'test': f"{test['projectName']} › {spec['title']}", 'target': record.get('target'),
                                            'kind': record.get('kind'), 'sequence': record.get('sequence'), 'control': record.get('control') or '',
                                            'mode': record.get('mode'), 'run': record.get('run'), 'keys': ' '.join(record.get('keys', [])),
                                            'result': record.get('result'), 'window': window_hit(log),
                                            'handoff': int(any(not key['trusted'] for key in log)), 'keylog': compact(log)})
                    results.append({'status': result['status'], 'duration': result['duration'], 'retry': result['retry'],
                                    'errors': [error.get('message', '') for error in result.get('errors', [])], 'attachments': attachments})
                tests.append({'title': spec['title'], 'location': f"{spec['file']}:{spec['line']}", 'project': test['projectName'],
                              'expectedStatus': test['expectedStatus'], 'status': test['status'], 'results': results})
        for child in suite.get('suites', []):
            visit(child)

    for suite in report['suites']:
        visit(suite)
    summary = {'stats': report['stats'], 'errors': [error.get('message', '') for error in report.get('errors', [])], 'tests': tests}
    (dest / 'report.summary.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False) + '\n')
    if samples:
        with open(dest / 'samples.csv', 'w', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=COLUMNS)
            writer.writeheader()
            writer.writerows(samples)
    return {key: report['stats'].get(key) for key in ('expected', 'unexpected', 'skipped', 'flaky', 'duration')} | {'samples': len(samples)}


if __name__ == '__main__':
    print(json.dumps(slim_run(sys.argv[1], sys.argv[2])))
