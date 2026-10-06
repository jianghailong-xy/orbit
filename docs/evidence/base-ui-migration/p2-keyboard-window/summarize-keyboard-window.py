"""Summarize the archived keyboard-window studies into keyboard-window-summary.json.

Each sample's `result` is one comparable string: a Select's value and whether its list is still open, or a
menu's outcome (`open`; `ran <item>` when an Enter on a menu item closed the menu; `closed`). Per target and
sequence the reference is the paced majority (focus already in the list); a burst sample is wrong when its
result differs from it. Each sequence is then judged on the old AntD target first, as the task requires:
a key the old component gives no function (a Select result equal to its control sequence's, a menu that runs
no item) or loses inside its own window is not changed on Orbit; only "AntD correct, Orbit wrong" is a fix."""
import collections
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIES = {
    'dev-check': 'development pass before the baseline: sample 0 of every combination, burst and paced',
    'baseline-menu': 'unchanged tree, menu sequences: 20 burst + 20 paced samples per target and sequence',
    # One select run was killed by a runner drain before writing any report (checks/baseline-select-killed.*);
    # the select sequences were then run in five chunks.
    'baseline-select-a': 'unchanged tree, select-down, select-down-enter, select-down-enter-from-7: 20 burst + 20 paced each',
    'baseline-select-b': 'unchanged tree, select-down-home-enter, select-down-end-enter: 20 burst + 20 paced each',
    'baseline-select-c': 'unchanged tree, select-down-pageup-enter, select-down-pagedown-enter: 20 burst + 20 paced each',
    'baseline-select-d': 'unchanged tree, select-down-space, select-down-space-from-null, select-space-down-enter: 20 burst + 20 paced each',
    'baseline-select-e': 'unchanged tree, select-enter-down-enter, select-down-7-enter, select-down-n-enter: 20 burst + 20 paced each',
    'baseline-rerun': 'unchanged tree, the baseline samples whose page never mounted (environmental), run again',
}
# The judged data set: the studies of one tree taken together (a rerun replaces nothing; it only adds samples).
DATASETS = {'baseline': ['baseline-menu', 'baseline-select-a', 'baseline-select-b', 'baseline-select-c',
                         'baseline-select-d', 'baseline-select-e', 'baseline-rerun']}
ANTD = {'menu': 'antd-menu', 'select': 'antd-sample'}
ORBIT = {'menu': ['orbit-menu', 'orbit-menu-sample'], 'select': ['orbit-field', 'orbit-sample']}
CONTROLS = {'menu-enter', 'select-down', 'select-down-enter', 'select-down-enter-from-7'}
REFERENCE_ONLY = {'menu-enter-tab-down-enter': 'Tab is outside the task keys: the old Dropdown\'s own way into its menu'}
# Only the Orbit field can start from null (the old sample has no Clear); the old Select's Space is judged on the
# same key from its own value.
ANTD_PROXY = {'select-down-space-from-null': 'select-down-space'}
# The Orbit field reports raw values; the samples (old and Orbit) show labels.
LABELS = {'never': 'Never', '7': '7 days', '30': '30 days'}


def records(study):
    for file in sorted((HERE / study).glob('*--keyboard-window.json')):
        yield file.name, json.loads(file.read_text())


def label(result):
    value, _, rest = result.partition(' | ')
    return f"{LABELS.get(value, value)} | {rest}" if rest else result


def rows_of(studies):
    rows = {}
    for name, data in (record for study in studies for record in records(study)):
        row = rows.setdefault((data['target'], data['sequence']), {
            'keys': data['keys'], 'from': data['from'], 'control': data['control'],
            'paced': collections.Counter(), 'burst': collections.Counter(), 'windowHits': 0, 'handedOver': 0, 'samples': []})
        row[data['mode']][data['result']] += 1
        log = data['keyLog']
        trusted = [key for key in log if key['trusted']]
        row['samples'].append((name, data))
        if data['mode'] == 'burst':
            # A later input key reached the element the first key went to while a list was already shown.
            row['windowHits'] += any(key['target'] == trusted[0]['target'] and key['listbox'] for key in trusted[1:])
            row['handedOver'] += any(not key['trusted'] for key in log)
    for row in rows.values():
        row['reference'] = row['paced'].most_common(1)[0][0] if row['paced'] else None
        row['pacedUnanimous'] = len(row['paced']) == 1
        row['burstWrong'] = sum(n for result, n in row['burst'].items() if result != row['reference'])
        row['wrong'] = [{'file': name, 'result': data['result'], 'keyLog': data['keyLog']}
                        for name, data in row.pop('samples') if data['mode'] == 'burst' and data['result'] != row['reference']]
    return rows


def verdicts(rows):
    out = {}
    for sequence in sorted({s for _, s in rows}):
        kind = 'menu' if sequence.startswith('menu-') else 'select'
        antd = rows.get((ANTD[kind], ANTD_PROXY.get(sequence, sequence)))
        orbit = {target: rows[(target, sequence)] for target in ORBIT[kind] if (target, sequence) in rows}
        entry = {'orbitBurstWrong': {t: f"{r['burstWrong']}/{sum(r['burst'].values())}" for t, r in orbit.items()},
                 'orbitPaced': {t: r['reference'] for t, r in orbit.items()},
                 'orbitWindowHits': {t: r['windowHits'] for t, r in orbit.items()},
                 'orbitHandedOver': {t: r['handedOver'] for t, r in orbit.items()}}
        if sequence in ANTD_PROXY:
            entry['antdJudgedOn'] = ANTD_PROXY[sequence]
        if antd:
            entry.update({'antdPaced': antd['reference'], 'antdBurstWrong': f"{antd['burstWrong']}/{sum(antd['burst'].values())}",
                          'antdWindowHits': antd['windowHits']})
        if sequence in CONTROLS:
            entry['decision'] = 'control'
        elif sequence in REFERENCE_ONLY:
            entry['decision'] = 'reference'
            entry['why'] = REFERENCE_ONLY[sequence]
        elif antd is None:
            entry['decision'] = 'incomplete'
        else:
            control = rows.get((ANTD[kind], antd['control'])) if antd['control'] else None
            handles = antd['reference'].startswith('ran ') if kind == 'menu' else control is not None and antd['reference'] != control['reference']
            entry['antdGivesTheKeyAFunction'] = handles
            if kind == 'select':
                entry['antdControlPaced'] = control['reference'] if control else None
                entry['orbitControlPaced'] = {t: rows[(t, antd['control'])]['reference'] for t in orbit if (t, antd['control']) in rows}
            if sequence not in ANTD_PROXY:
                entry['orbitPacedMatchesAntd'] = {t: label(r['reference']) == label(antd['reference']) for t, r in orbit.items()}
            if not handles:
                entry['decision'] = 'antd-no-function: record, no change'
            elif antd['burstWrong']:
                entry['decision'] = 'antd-loses-in-its-window: record, no change'
            elif all(r['burstWrong'] == 0 for r in orbit.values()):
                entry['decision'] = 'both-correct: no change'
            else:
                entry['decision'] = 'fix: AntD correct, Orbit wrong in the window'
        out[sequence] = entry
    return out


def entry_of(studies, scope):
    stats = [json.loads((HERE / study / 'summary.json').read_text())['stats'] for study in studies]
    rows = rows_of(studies)
    return {'scope': scope, 'playwright': {k: sum(s[k] for s in stats) for k in ['expected', 'unexpected', 'skipped', 'flaky']},
            'targets': {f'{t} {s}': row for (t, s), row in sorted(rows.items())}, 'sequences': verdicts(rows)}


report = {}
for study, scope in STUDIES.items():
    if (HERE / study / 'summary.json').exists():
        report[study] = entry_of([study], scope)
for dataset, studies in DATASETS.items():
    present = [study for study in studies if (HERE / study / 'summary.json').exists()]
    if present:
        report[f'dataset:{dataset}'] = entry_of(present, ' + '.join(present))
(HERE / 'keyboard-window-summary.json').write_text(json.dumps(report, indent=1, ensure_ascii=False) + '\n')
for study, entry in report.items():
    print(study, entry['playwright'])
    for key, row in entry['targets'].items():
        print('  ', key, {k: (dict(v) if isinstance(v, collections.Counter) else v) for k, v in row.items() if k in ('paced', 'burst', 'burstWrong', 'windowHits', 'handedOver')})
    for sequence, verdict in entry['sequences'].items():
        print('  =>', sequence, verdict['decision'])
