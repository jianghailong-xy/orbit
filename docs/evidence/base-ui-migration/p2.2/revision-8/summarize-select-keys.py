"""Summarize the archived select key-sequence samples: how often Enter left the value unchanged, and how often
the second ArrowDown reached the trigger while a listbox was already shown."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIES = {'select-keys-throttle': 'merged 38947755e, Chromium CPU throttling 1x/6x/20x, 5 samples per test',
           'select-keys-repeat-merged': 'merged 38947755e, unthrottled, 40 samples per target',
           'select-keys-repeat-accepted': 'accepted 45bb56928, unthrottled, 40 samples per target'}
report = {}
for study, scope in STUDIES.items():
    rows = {}
    for file in sorted((HERE / study).glob('*--select-keys.json')):
        data = json.loads(file.read_text())
        samples = data['runs'] if 'runs' in data else [data]
        for sample in samples:
            key = f"{data['target']}@{data.get('rate', 1)}x"
            row = rows.setdefault(key, {'samples': 0, 'valueUnchanged': 0, 'secondArrowAtTriggerWithListboxShown': 0, 'lost': []})
            keys = sample['keys']
            unchanged = sample['after'].split('\n')[0] in ('never', 'Never')
            early = len(keys) > 1 and keys[1]['target'].startswith('combobox') and keys[1]['listbox']
            row['samples'] += 1
            row['valueUnchanged'] += unchanged
            row['secondArrowAtTriggerWithListboxShown'] += early
            if unchanged:
                row['lost'].append({'file': file.name, 'run': sample['run'], 'keys': keys})
    summary = json.loads((HERE / study / 'summary.json').read_text())['stats']
    report[study] = {'scope': scope, 'playwright': {k: summary[k] for k in ['expected', 'unexpected', 'skipped', 'flaky']}, 'targets': rows}
(HERE / 'select-keys-summary.json').write_text(json.dumps(report, indent=1) + '\n')
for study, entry in report.items():
    print(study, entry['playwright'])
    for key, row in entry['targets'].items():
        print('  ', key, {k: v for k, v in row.items() if k != 'lost'}, [(l['file'][:40], l['run']) for l in row['lost']])
