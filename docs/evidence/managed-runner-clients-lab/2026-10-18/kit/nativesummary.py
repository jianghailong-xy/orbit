#!/usr/bin/env python3
"""A Markdown table for one probe round: for each replayed scene, the test's result on the iPhone and on the Mac,
the replay's verdict (requests answered, violations, fields an app's write sent differently from the recording
outside its key fields), and the pictures the scene's steps took on each.

  python3 -I nativesummary.py RESULTS_DIR SCENES_DIR LINK_PREFIX

RESULTS_DIR is a round's results branch as fetched (replay-ios/, replay-mac/); SCENES_DIR holds the scenes as
pushed (*.json or *.json.gz); LINK_PREFIX is where the round's pictures sit relative to the Markdown file.
"""
import gzip
import json
import re
import sys
from pathlib import Path

results, scenes_dir, prefix = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3].rstrip('/')
PLATFORMS = [('ios', 'iPhone'), ('mac', 'Mac')]


def test_name(scene):  # gen_tests.py's naming
    return 'test' + ''.join(part[:1].upper() + part[1:] for part in re.split(r'[^A-Za-z0-9]+', scene) if part)


def load(path):
    raw = path.read_bytes()
    return json.loads(gzip.decompress(raw) if path.suffix == '.gz' else raw)


scenes = {}
for path in sorted(scenes_dir.glob('*.json*')):
    data = load(path)
    scenes[data['name']] = data.get('meta', {})

outcome = {}
for platform, _ in PLATFORMS:
    summary = results / f'replay-{platform}' / 'shots' / f'summary-build-{platform}.txt'
    text = summary.read_text(errors='replace') if summary.exists() else ''
    for scene in scenes:
        name = test_name(scene)
        found = [f for f in (results / f'replay-{platform}' / 'shots' / platform / f'verdict-{scene}{suffix}'
                             for suffix in ('.json', '')) if f.exists()]
        verdict = json.loads(found[0].read_text()) if found else None
        ran = re.search(rf"ReplayTests {name}\]' (passed|failed) \(([\d.]+) seconds\)", text)
        # The replay's own verdict says a violation in full; the assertion's message is cut at its first line.
        errors = [m.group(1).strip() for m in re.finditer(rf'ReplayTests {name}\] : (?:XCTAssertTrue )?failed - (.*)', text)
                  if 'the app sent what the scene does not hold' not in m.group(1)]
        outcome[(platform, scene)] = (ran.group(1) if ran else 'not run', ran.group(2) if ran else None, errors, verdict)

print('| Scene | ' + ' | '.join(label for _, label in PLATFORMS) + ' | Pictures (iPhone · Mac) |')
print('| --- | ' + ' | '.join('---' for _ in PLATFORMS) + ' | --- |')
for scene, meta in scenes.items():
    if all(outcome[(platform, scene)][0] == 'not run' for platform, _ in PLATFORMS):
        continue  # not in this round
    cells = []
    for platform, _ in PLATFORMS:
        result, seconds, errors, verdict = outcome[(platform, scene)]
        cell = f'**{result}**' + (f' ({float(seconds):.0f} s)' if seconds else '')
        if verdict:
            cell += f", {verdict['requests']} requests, {len(verdict['violations'])} violations"
            for v in verdict['violations']:
                cell += f"; {v['what']}: {v.get('request', '')} {json.dumps(v.get('fields', ''), ensure_ascii=False)}"
            for n in verdict.get('notes', []):
                cell += f"; other fields: {json.dumps(n, ensure_ascii=False)}"
            if verdict.get('actionsLeft'):
                cell += f"; writes never sent: {verdict['actionsLeft']}"
        for e in errors:
            cell += f'; {e[:160]}'
        cells.append(cell.replace('|', '\\|'))
    shots = [s['shot'] for s in meta.get('steps', []) if s.get('shot')]
    pictures = []
    for shot in shots:
        links = [f'[{label}]({prefix}/{platform}/{shot}.png)' for platform, label in PLATFORMS
                 if (results / f'replay-{platform}' / 'shots' / platform / f'{shot}.png').exists()]
        pictures.append(f"{shot} {' '.join(links) if links else '(none)'}")
    print(f"| {scene} | {' | '.join(cells)} | {'<br>'.join(pictures)} |")
