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
    'baseline-menu': 'baseline tree, menu sequences: 20 burst + 20 paced samples per target and sequence',
    # One select run was killed by a runner drain before writing any report (checks/baseline-select-killed.*);
    # the select sequences were then run in five chunks.
    'baseline-select-a': 'baseline tree, select-down, select-down-enter, select-down-enter-from-7: 20 burst + 20 paced each',
    'baseline-select-b': 'baseline tree, select-down-home-enter, select-down-end-enter: 20 burst + 20 paced each',
    'baseline-select-c': 'baseline tree, select-down-pageup-enter, select-down-pagedown-enter: 20 burst + 20 paced each',
    'baseline-select-d': 'baseline tree, select-down-space, select-down-space-from-null, select-space-down-enter: 20 burst + 20 paced each',
    'baseline-select-e': 'baseline tree, select-enter-down-enter, select-down-7-enter, select-down-n-enter: 20 burst + 20 paced each',
    'baseline-rerun': 'baseline tree, the baseline samples whose page never mounted (environmental), run again',
    # Taken on the delivered tree (the branch after merging the project tip with P3.1): Menu, Select, Floating,
    # Base UI, AntD, the lockfile and the choices fixture and config are byte-identical to the tree above.
    'baseline-menu-up': 'delivered tree, menu-up-enter, menu-up-up-enter, menu-up-down-enter: 20 burst + 20 paced per target and sequence',
    'baseline-menu-up-rerun': 'delivered tree, the baseline-menu-up sample whose page never mounted (environmental), run again',
    # The Menu window fix the coordinator authorized on 2026-10-07 (plan B). The tree before the fix (46a418fba, a
    # temporary worktree) and the fixed tree (4fb7ee43f) ran the menu sequences at the same time, each in its own
    # network namespace; each run is judged on its own, its AntD target included.
    'fix-menu-before': 'before-fix tree 46a418fba, all menu sequences: 20 burst + 20 paced per target and sequence (A/B with fix-menu-after)',
    'fix-menu-after': 'fixed tree 4fb7ee43f, all menu sequences: 20 burst + 20 paced per target and sequence (A/B with fix-menu-before)',
}
# The judged data set: the studies taken together (a rerun replaces nothing; it only adds samples).
DATASETS = {'baseline': ['baseline-menu', 'baseline-select-a', 'baseline-select-b', 'baseline-select-c',
                         'baseline-select-d', 'baseline-select-e', 'baseline-rerun', 'baseline-menu-up',
                         'baseline-menu-up-rerun']}
# The fixed tree's select sequences (Select is not changed), run one sequence per chunk by run-chunks.py after a
# runner drain lost the single run (checks/fix-select-after-killed.*); each chunk is judged with the others.
CHUNKS = lambda prefix: sorted(p.name for p in HERE.glob(f'{prefix}-*') if (p / 'summary.json').exists())
DATASETS['fix-select-after'] = CHUNKS('fix-select-after')
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


def select_keys_burst(studies):
    """The previous task's burst probe (../p2-select-keys, unchanged) run again on this tree: grouped and judged as
    its own summarize-select-keys.py does (a fixed expectation, or the paced majority), which is not run here
    because it rewrites that directory's summary."""
    samples = [json.loads(file.read_text()) for study in studies for file in sorted((HERE / study).glob('*--select-keys.json'))]
    paced = collections.defaultdict(collections.Counter)
    for data in samples:
        if data['mode'] == 'paced':
            paced[data['target'], data['sequence']][data['after']] += 1
    rows = {}
    for data in samples:
        reference = data['expected'] or paced[data['target'], data['sequence']].most_common(1)[0][0]
        row = rows.setdefault(f"{data['target']} {data['sequence']} {data['mode']}", {
            'samples': 0, 'reference': reference, 'results': collections.Counter(), 'differ': 0, 'handedOver': 0})
        row['samples'] += 1
        row['results'][data['after']] += 1
        row['handedOver'] += any(not key['trusted'] for key in data['keyLog'])
        row['differ'] += (data['after'].split(' | ')[0] if data['expected'] else data['after']) != reference
    return rows


# The fix A/B ran in chunks by target (run-chunks.py), after a runner drain lost both single runs.
for study, (tree, studies) in {'regression-select-keys-burst': ('baseline tree', ['regression-select-keys-burst']),
                               'regression-select-keys-burst-delivered': ('delivered tree', ['regression-select-keys-burst-delivered']),
                               'fix-select-keys-burst-before': ('before-fix tree 46a418fba (A/B)', CHUNKS('fix-select-keys-burst-before')),
                               'fix-select-keys-burst-after': ('fixed tree (A/B)', CHUNKS('fix-select-keys-burst-after'))}.items():
    studies = [name for name in studies if (HERE / name / 'summary.json').exists()]
    if studies:
        stats = [json.loads((HERE / name / 'summary.json').read_text())['stats'] for name in studies]
        report[study] = {
            'scope': f'{tree}, the unchanged ../p2-select-keys/select-keys-burst.browser.mjs (20 burst + 3 paced per combination)'
                     + (': ' + ' + '.join(studies) if study.startswith('fix-') else ''),
            'playwright': {k: sum(stat[k] for stat in stats) for k in ['expected', 'unexpected', 'skipped', 'flaky']},
            'targets': select_keys_burst(studies), 'sequences': {}}


def before_after(before, after):
    """Per menu sequence and target: burst samples that differ from the paced reference before and after the fix,
    the paced references (focus already in the menu; the fix must not change them) and the hand-overs after it."""
    rows = {}
    for sequence, entry in report[after]['sequences'].items():
        prior = report[before]['sequences'][sequence]
        keys = report[after]['targets'][f'{ORBIT["menu"][0]} {sequence}']['keys']
        # The AntD rule alone says "record, no change" for every menu sequence; the coordinator's 2026-10-07 exception
        # covers the Menu trigger's ArrowDown/ArrowUp/Enter while the menu is open and focus has not entered it.
        row = {'antdRule': entry['decision'], 'coordinatorException': sequence not in CONTROLS
               and set(keys) <= {'ArrowDown', 'ArrowUp', 'Enter'}, 'keys': keys}
        for target in ['antd-menu', *ORBIT['menu']]:
            key = 'antd' if target == 'antd-menu' else target
            pick = (lambda e, field: e.get(f'antd{field}')) if key == 'antd' else (lambda e, field: e[f'orbit{field}'][target])
            row[target] = {'burstWrongBefore': pick(prior, 'BurstWrong'), 'burstWrongAfter': pick(entry, 'BurstWrong'),
                           'pacedBefore': pick(prior, 'Paced'), 'pacedAfter': pick(entry, 'Paced')}
            if key != 'antd':
                row[target]['handedOverAfter'] = entry['orbitHandedOver'][target]
        rows[sequence] = row
    return rows


def held_frames(study):
    """menu-held-frames.browser.mjs: per test, the projects that passed and failed, and from each record whether the key
    after the opener reached the trigger with the menu shown (the window) and whether a key was handed to the menu."""
    tests = {}
    for test in json.loads((HERE / study / 'summary.json').read_text())['tests']:
        project, _, title = test['name'].partition('--')
        row = tests.setdefault(title, {'passed': [], 'failed': [], 'window': 0, 'handedOver': 0})
        row['passed' if test['status'] == 'expected' else 'failed'].append(project)
        for artifact in test['artifacts']:
            if not artifact['file'].endswith('--menu-held-frames.json'):
                continue
            log = json.loads((HERE / study / artifact['file']).read_text())['keyLog']
            trusted = [key for key in log if key['trusted']]
            row['window'] += len(trusted) > 1 and trusted[1]['target'] == trusted[0]['target'] and trusted[1]['menu']
            row['handedOver'] += any(not key['trusted'] for key in log)
    return tests


if all(study in report for study in ['fix-menu-before', 'fix-menu-after']):
    report['fix:menu-before-after'] = {'scope': 'fix-menu-before vs fix-menu-after (A/B)', 'playwright': {}, 'targets': {},
                                       'sequences': before_after('fix-menu-before', 'fix-menu-after')}
for study, tree in {'fix-held-frames-before': 'before-fix tree 46a418fba (A/B)', 'fix-held-frames-after': 'fixed tree (A/B)'}.items():
    if (HERE / study / 'summary.json').exists():
        stats = json.loads((HERE / study / 'summary.json').read_text())['stats']
        report[study] = {'scope': f'{tree}, menu-held-frames.browser.mjs in all eight projects',
                         'playwright': {k: stats[k] for k in ['expected', 'unexpected', 'skipped', 'flaky']},
                         'targets': held_frames(study), 'sequences': {}}
(HERE / 'keyboard-window-summary.json').write_text(json.dumps(report, indent=1, ensure_ascii=False) + '\n')
for study, entry in report.items():
    print(study, entry['playwright'])
    for key, row in entry['targets'].items():
        print('  ', key, {k: (dict(v) if isinstance(v, collections.Counter) else v) for k, v in row.items()
                         if k in ('paced', 'burst', 'burstWrong', 'windowHits', 'handedOver', 'results', 'differ', 'passed', 'failed', 'window')})
    for sequence, verdict in entry['sequences'].items():
        print('  =>', sequence, verdict.get('decision') or {k: v for k, v in verdict.items() if k != 'keys'})
