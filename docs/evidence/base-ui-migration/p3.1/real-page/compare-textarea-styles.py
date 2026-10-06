"""Compare the TEXTAREA controls recorded by the P0 harness in two same-commit runs (AntD control vs Orbit swap)."""
import json, sys
from pathlib import Path
control, swap = Path(sys.argv[1]), Path(sys.argv[2])
rows, differences = [], []
for directory in sorted(control.iterdir()):
    if not (directory / 'evidence.json').exists() or not (swap / directory.name / 'evidence.json').exists():
        continue
    a = json.loads((directory / 'evidence.json').read_text())
    b = json.loads((swap / directory.name / 'evidence.json').read_text())
    for ca, cb in zip(a['captures'], b['captures']):
        assert ca['name'] == cb['name']
        ta = [c for c in ca['controls'] if c['tag'] == 'TEXTAREA']
        tb = [c for c in cb['controls'] if c['tag'] == 'TEXTAREA']
        if not ta and not tb:
            continue
        rows.append({'test': directory.name, 'capture': ca['name'], 'textareas': len(ta)})
        if len(ta) != len(tb):
            differences.append({'test': directory.name, 'capture': ca['name'], 'count': [len(ta), len(tb)]})
            continue
        for x, y in zip(ta, tb):
            for key in ['label', 'disabled', 'focused', 'hovered', 'rect']:
                if x[key] != y[key]:
                    differences.append({'test': directory.name, 'capture': ca['name'], 'key': key, 'antd': x[key], 'orbit': y[key]})
            for key in x['style']:
                if x['style'][key] != y['style'][key]:
                    differences.append({'test': directory.name, 'capture': ca['name'], 'key': 'style.' + key, 'antd': x['style'][key], 'orbit': y['style'][key]})
by_key = {}
for d in differences:
    by_key.setdefault(d.get('key', 'count'), []).append(d)
print(json.dumps({'compared': len(rows), 'differences': len(differences), 'byKey': {k: len(v) for k, v in by_key.items()},
                  'samples': {k: v[:2] for k, v in by_key.items()}}, indent=1, ensure_ascii=False))
