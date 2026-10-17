"""Summarize the archived p2-select-keys studies into select-keys-summary.json.

The unchanged r8 probes (repeat/throttle) get the counts of ../p2.2/revision-8/summarize-select-keys.py:
Enter left the value at Never ("valueUnchanged", i.e. lost), and the second ArrowDown reached the trigger
while a listbox was already shown. `handedOver` adds the samples whose log holds a fourth keydown, the key
the fixed Select re-dispatched to the list. The burst probe is grouped by target, sequence and mode; each
result is compared with the fixed expectation, or with the paced samples where there is none."""
import collections
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIES = {
    'before-repeat': ('r8', 'unfixed 8ef6b60d1, r8 select-keys-repeat probe unchanged, --repeat-each 5: 200 samples per target'),
    'before-throttle': ('r8', 'unfixed 8ef6b60d1, r8 select-keys probe unchanged: CPU throttling 1x/6x/20x, 5 samples per test'),
    'before-burst': ('burst', 'unfixed 8ef6b60d1, select-keys-burst probe: keys queued without waiting (burst) or 300ms apart (paced)'),
    'after-repeat': ('r8', 'fixed tree, r8 select-keys-repeat probe unchanged, --repeat-each 5: 200 samples per target'),
    'after-throttle': ('r8', 'fixed tree, r8 select-keys probe unchanged: CPU throttling 1x/6x/20x, 5 samples per test'),
    'after-burst': ('burst', 'fixed tree, select-keys-burst probe: keys queued without waiting (burst) or 300ms apart (paced)'),
}


def records(study):
    for file in sorted((HERE / study).glob('*--select-keys.json')):
        yield file.name, json.loads(file.read_text())


def r8(study):
    rows = {}
    for name, data in records(study):
        for sample in data['runs'] if 'runs' in data else [data]:
            row = rows.setdefault(f"{data['target']}@{data.get('rate', 1)}x", {
                'samples': 0, 'valueUnchanged': 0, 'secondArrowAtTriggerWithListboxShown': 0, 'handedOver': 0, 'lost': []})
            keys = sample['keys']
            unchanged = sample['after'].split('\n')[0] in ('never', 'Never')
            row['samples'] += 1
            row['valueUnchanged'] += unchanged
            row['secondArrowAtTriggerWithListboxShown'] += len(keys) > 1 and keys[1]['target'].startswith('combobox') and keys[1]['listbox']
            row['handedOver'] += len(keys) > 3
            if unchanged:
                row['lost'].append({'file': name, 'run': sample['run'], 'keys': keys})
    return rows


def burst(study):
    samples = list(records(study))
    paced = collections.defaultdict(collections.Counter)
    for _, data in samples:
        if data['mode'] == 'paced':
            paced[data['target'], data['sequence']][data['after']] += 1
    rows = {}
    for name, data in samples:
        reference = data['expected'] or next(iter(paced[data['target'], data['sequence']].most_common(1)), (None,))[0]
        row = rows.setdefault(f"{data['target']} {data['sequence']} {data['mode']}", {
            'samples': 0, 'reference': reference, 'results': collections.Counter(), 'differ': 0,
            'laterKeyAtTriggerWithListShown': 0, 'handedOver': 0, 'differing': []})
        log = data['keyLog']
        trusted = [key for key in log if key['trusted']]
        row['samples'] += 1
        row['results'][data['after']] += 1
        # The first key opens the list from the trigger; a later input key with the same target arrived there too.
        row['laterKeyAtTriggerWithListShown'] += any(key['target'] == trusted[0]['target'] and key['listbox'] for key in trusted[1:])
        row['handedOver'] += any(not key['trusted'] for key in log)
        # A fixed single value is compared with the first line, as the r8 summary does (AntD's sample text repeats it).
        if (data['after'].split(' | ')[0] if data['expected'] else data['after']) != reference:
            row['differ'] += 1
            row['differing'].append({'file': name, 'after': data['after'], 'listboxOpen': data['listboxOpen'], 'keyLog': log})
    return rows


report = {}
for study, (kind, scope) in STUDIES.items():
    if not (HERE / study / 'summary.json').exists():
        continue
    stats = json.loads((HERE / study / 'summary.json').read_text())['stats']
    report[study] = {'scope': scope, 'playwright': {k: stats[k] for k in ['expected', 'unexpected', 'skipped', 'flaky']},
                     'targets': r8(study) if kind == 'r8' else burst(study)}
(HERE / 'select-keys-summary.json').write_text(json.dumps(report, indent=1, ensure_ascii=False) + '\n')
for study, entry in report.items():
    print(study, entry['playwright'])
    for key, row in entry['targets'].items():
        print('  ', key, {k: v for k, v in row.items() if k not in ('lost', 'differing')})
