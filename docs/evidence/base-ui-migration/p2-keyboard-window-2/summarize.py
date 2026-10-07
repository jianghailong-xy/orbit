"""Per-combination verdicts of keyboard-window-2 datasets (samples.csv files under this directory).

usage: summarize.py <dataset>=<dir>[,<dir>...] [<dataset>=...] [--json <file>] [--table <dataset>]

For every target × sequence of a dataset: the paced reference (the majority paced result), how many burst samples
differ from it (and with what), window hits and hand-offs, as in ../p2-keyboard-window/summarize-keyboard-window.py.
A result is `outcome | shown popups | @focus`; `outcome` alone (what ran, was chosen or answered) is compared too.

Per sequence, the rule of the two earlier tasks, old AntD first:
1. the old component gives the key under test a function: its paced outcome differs from the control sequence's
   (for menus and submenus, as before: its paced reference runs an item);
2. its burst samples keep its paced reference;
and only then is an Orbit target whose burst differs from its own paced reference to be fixed."""
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
                old_ref = outcome(old['paced']['reference'])
                old_control = outcome(table.get((control, antd), {}).get('paced', {}).get('reference')) if control else None
                if kind in ('menu', 'submenu'):
                    function = bool(old_ref and old_ref.startswith('ran '))
                else:
                    function = control is not None and old_control is not None and old_ref != old_control
                stable = old['burst']['differOutcome'] == 0
                orbit_stable = new['burst']['differOutcome'] == 0
                entry.update({'antdFunction': function, 'antdStable': stable, 'orbitStable': orbit_stable,
                              'antdPaced': old_ref, 'antdControlPaced': old_control, 'orbitPaced': outcome(new['paced']['reference']),
                              'orbitBurstDiffer': new['burst']['differOutcome'], 'orbitBurstSamples': new['burst']['samples']})
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


def main(argv):
    datasets, json_out, show = {}, None, []
    while argv:
        item = argv.pop(0)
        if item == '--json':
            json_out = argv.pop(0)
        elif item == '--table':
            show.append(argv.pop(0))
        else:
            name, dirs = item.split('=', 1)
            datasets[name] = dirs.split(',')
    summary = {}
    for name, dirs in datasets.items():
        table = cells(load(dirs))
        summary[name] = {'dirs': dirs, 'cells': {f'{seq} / {target}': cell for (seq, target), cell in sorted(table.items())},
                         'verdicts': verdicts(table)}
    if json_out:
        Path(json_out).write_text(json.dumps(summary, indent=1, ensure_ascii=False) + '\n')
    for name in show:
        print(f'## {name}')
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
