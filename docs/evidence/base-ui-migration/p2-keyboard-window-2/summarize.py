"""Per-combination verdicts of keyboard-window-2 datasets (samples.csv files under this directory).

usage: summarize.py <dataset>=<dir>[,<dir>...] [<dataset>=...] [--run <name>=<dir>[,<dir>...]] [--json <file>] [--table <name>]

For every target × sequence of a dataset: the paced reference (the majority paced result), how many burst samples
differ from it (and with what), window hits and hand-offs, as in ../p2-keyboard-window/summarize-keyboard-window.py.
A result is `outcome | shown popups | @focus`; `outcome` alone (what ran, was chosen or answered) is compared too.

Per sequence, the rule of the two earlier tasks, old AntD first:
1. the old component gives the key under test a function: its paced result differs from the control sequence's (for
   menus and submenus, as before, its paced reference runs an item; for Popconfirm, it answers the question);
2. its burst samples keep its paced reference (the whole result, focus included);
and only then is an Orbit target whose burst differs from its own paced reference to be fixed.
`--run` summarises a run per test and project instead (the held-frames probe, the earlier tasks' probes)."""
import collections
import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ANTD = {'menu': 'antd-menu', 'submenu': 'antd-submenu', 'select': 'antd-sample', 'popconfirm': 'antd-popconfirm'}
DIALOG_PAIRS = {'orbit-dialog': 'antd-dialog', 'orbit-confirm': 'antd-confirm'}


def outcome(result):
    return result.split(' | @')[0] if result else result


def load(dirs):
    rows = []
    for name in dirs:
        path = HERE / name / 'samples.csv'
        with open(path, newline='') as handle:
            rows.extend(csv.DictReader(handle))
    return rows


def cells(rows):
    grouped = collections.defaultdict(lambda: {'burst': [], 'paced': []})
    meta = {}
    for row in rows:
        key = (row['sequence'], row['target'])
        grouped[key][row['mode']].append(row)
        meta[key] = row
    out = {}
    for key, modes in grouped.items():
        paced = collections.Counter(row['result'] for row in modes['paced'])
        reference, count = paced.most_common(1)[0] if paced else (None, 0)
        paced_outcome = collections.Counter(outcome(row['result']) for row in modes['paced'])
        reference_outcome = paced_outcome.most_common(1)[0][0] if paced_outcome else None
        burst = modes['burst']
        wrong = collections.Counter(row['result'] for row in burst if row['result'] != reference)
        wrong_outcome = collections.Counter(outcome(row['result']) for row in burst if outcome(row['result']) != reference_outcome)
        out[key] = {'kind': meta[key]['kind'], 'control': meta[key]['control'] or None, 'keys': meta[key]['keys'],
                    'paced': {'reference': reference, 'count': count, 'samples': len(modes['paced']), 'others': dict(paced - collections.Counter({reference: count}))},
                    'burst': {'samples': len(burst), 'differ': sum(wrong.values()), 'differOutcome': sum(wrong_outcome.values()),
                              'results': dict(wrong), 'window': sum(int(row['window']) for row in burst),
                              'handoff': sum(int(row['handoff']) for row in burst)},
                    'pacedHandoff': sum(int(row['handoff']) for row in modes['paced'])}
    return out


def verdicts(table):
    sequences = sorted({sequence for sequence, _ in table})
    out = {}
    for sequence in sequences:
        targets = {target: cell for (seq, target), cell in table.items() if seq == sequence}
        kind = next(iter(targets.values()))['kind']
        control = next(iter(targets.values()))['control']
        pairs = [(target, DIALOG_PAIRS[target]) for target in targets if target in DIALOG_PAIRS] if kind == 'dialog' else \
            [(target, ANTD[kind]) for target in targets if not target.startswith('antd')]
        for orbit, antd in pairs:
            old = targets.get(antd)
            new = targets[orbit]
            entry = {'kind': kind, 'control': control, 'antd': antd}
            if old is None:
                entry['verdict'] = 'no old sample'
            else:
                old_ref = old['paced']['reference']
                old_control = table.get((control, antd), {}).get('paced', {}).get('reference') if control else None
                if kind in ('menu', 'submenu', 'popconfirm'):
                    # As in the earlier tasks' menu rule: the key counts when the old component runs an item or
                    # answers the question; re-pressing its trigger to close it does not.
                    function = old_ref.split(' | ')[0] != 'none'
                else:
                    function = control is not None and old_control is not None and old_ref != old_control
                stable = old['burst']['differ'] == 0
                orbit_stable = new['burst']['differ'] == 0
                entry.update({'antdFunction': function, 'antdStable': stable, 'orbitStable': orbit_stable,
                              'antdPaced': old_ref, 'antdControlPaced': old_control, 'orbitPaced': new['paced']['reference'],
                              'antdBurstDiffer': old['burst']['differ'], 'orbitBurstDiffer': new['burst']['differ'],
                              'orbitBurstDifferOutcome': new['burst']['differOutcome'], 'orbitBurstSamples': new['burst']['samples']})
                if control is None:
                    entry['verdict'] = 'control'
                elif function and stable and not orbit_stable:
                    entry['verdict'] = 'fix: old AntD correct, Orbit not'
                elif function and stable:
                    entry['verdict'] = 'both correct'
                elif orbit_stable:
                    entry['verdict'] = 'old AntD does not handle it; Orbit already keeps its paced result'
                else:
                    entry['verdict'] = 'old AntD does not handle it: record, no change'
            out[f'{sequence} / {orbit}'] = entry
    return out


def tests_by_case(dirs):
    """A run's tests from report.summary.json: {title: {project: status}}, for the held-frames and earlier probes."""
    out = collections.defaultdict(dict)
    for name in dirs:
        for test in json.loads((HERE / name / 'report.summary.json').read_text())['tests']:
            out[test['title']][test['project']] = test['status']
    return out


def main(argv):
    datasets, runs, json_out, show = {}, {}, None, []
    while argv:
        item = argv.pop(0)
        if item == '--json':
            json_out = argv.pop(0)
        elif item == '--table':
            show.append(argv.pop(0))
        elif item == '--run':
            # A run summarised per test and project (held frames, the earlier tasks' probes).
            name, dirs = argv.pop(0).split('=', 1)
            runs[name] = dirs.split(',')
        else:
            name, dirs = item.split('=', 1)
            datasets[name] = dirs.split(',')
    summary = {}
    for name, dirs in datasets.items():
        table = cells(load(dirs))
        summary[name] = {'dirs': dirs, 'cells': {f'{seq} / {target}': cell for (seq, target), cell in sorted(table.items())},
                         'verdicts': verdicts(table)}
    for name, dirs in runs.items():
        cases = tests_by_case(dirs)
        summary[name] = {'dirs': dirs, 'passed': sum(status == 'expected' for projects in cases.values() for status in projects.values()),
                         'tests': sum(len(projects) for projects in cases.values()),
                         'cases': {title: {'passedProjects': sum(status == 'expected' for status in projects.values()), 'projects': len(projects),
                                           'failed': sorted(project for project, status in projects.items() if status != 'expected')}
                                   for title, projects in sorted(cases.items())}}
    if json_out:
        Path(json_out).write_text(json.dumps(summary, indent=1, ensure_ascii=False) + '\n')
    for name in show:
        print(f'## {name}')
        if 'cases' in summary[name]:
            print(f"{summary[name]['passed']}/{summary[name]['tests']} passed")
            for title, case in summary[name]['cases'].items():
                print(f"{title:<70} {case['passedProjects']}/{case['projects']}{' failed: ' + ', '.join(case['failed']) if case['failed'] else ''}")
            print()
            continue
        for key, cell in summary[name]['cells'].items():
            burst = cell['burst']
            print(f"{key:<58} paced {cell['paced']['count']}/{cell['paced']['samples']} [{cell['paced']['reference']}]"
                  f"{' others ' + json.dumps(cell['paced']['others'], ensure_ascii=False) if cell['paced']['others'] else ''}"
                  f" | burst differ {burst['differ']}/{burst['samples']} (outcome {burst['differOutcome']}) window {burst['window']} handoff {burst['handoff']}"
                  f"{' ' + json.dumps(burst['results'], ensure_ascii=False) if burst['results'] else ''}")
        print()
        for key, entry in summary[name]['verdicts'].items():
            print(f"{key:<58} {entry['verdict']}  (AntD fn={entry.get('antdFunction')} stable={entry.get('antdStable')}; Orbit stable={entry.get('orbitStable')})")


if __name__ == '__main__':
    main(sys.argv[1:])
