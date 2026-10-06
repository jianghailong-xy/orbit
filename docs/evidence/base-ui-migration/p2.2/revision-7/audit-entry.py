"""Summarize original and final native observations, without editing raw attachments."""
import hashlib
import json
from pathlib import Path
import zipfile

out = Path(__file__).resolve().parent
observations = []
runs = []
for name, count in [('original-entry-probe', 5), ('entry-eight', 8), ('entry-finite', 40)]:
    directory = out / name
    summary = json.loads((directory / 'summary.json').read_text())
    stats = summary['stats']
    assert (stats['expected'], stats['unexpected'], stats['flaky'], stats['skipped']) == (count, 0, 0, 0)
    assert len(summary['tests']) == count
    runs.append({'name': name, 'stats': stats})
    for test in summary['tests']:
        assert len(test['results']) == 1 and test['results'][0]['status'] == 'passed'
        for artifact in test['artifacts']:
            p = directory / artifact['file']
            assert hashlib.sha256(p.read_bytes()).hexdigest() == artifact['sha256']
            if not p.name.endswith('--native-entry.json'):
                continue
            entries = json.loads(p.read_text())
            first = next(e for e in entries if e.get('dialog'))
            start = next(e for e in entries if e.get('dialog', {}).get('opacity') == '0' and e.get('animations'))
            clicks = [e for e in entries if e['kind'] == 'click' and e['event']['targetOK']]
            assert len(clicks) == 1
            click = clicks[0]
            assert click['event']['trusted'] and click['hitOK']
            assert click['dialog']['opacity'] == '1' and click['dialog']['transform'] == 'none'
            assert not click['animations']
            pointer = [e for e in entries if e['kind'] in ['pointerdown', 'pointerup'] and e['event']['targetOK']]
            assert {e['kind'] for e in pointer} == {'pointerdown', 'pointerup'}
            assert all(e['event']['trusted'] and e['hitOK'] for e in pointer)
            first_miss = next((e for e in entries if e.get('dialog') and e.get('entrancePoint') and not e['entrancePointHitOK']), None)
            confirmed = next((e for e in entries if e['confirmed']), None)
            if name == 'entry-finite':
                assert confirmed is not None and not entries[-1].get('dialog')
                assert first_miss is not None
            observations.append({'run': name, 'test': test['name'], 'raw': str(p.relative_to(out)),
                                 'firstDialog': first, 'entranceStart': start,
                                 'initialPointFirstMiss': first_miss, 'trustedClick': click,
                                 'firstConfirmation': confirmed,
                                 'entryToClickMs': click['time'] - first['time']})

trace = next((out / 'coordinator-input/notification-first-run').rglob('trace.zip'))
with zipfile.ZipFile(trace) as archive:
    events = [json.loads(line) for line in archive.read('1-trace.trace').decode().splitlines()]
    original = [e for e in events if e.get('callId') == 'call@1123' and e['type'] != 'frame-snapshot']
    box = next(e['box'] for e in original if e['type'] == 'input')
    desktop = [o for o in observations if 'webkit-dark-desktop' in o['test']]
    for item in desktop:
        assert item['entranceStart']['box'] == box | {k: item['entranceStart']['box'][k] for k in ['top', 'right', 'bottom', 'left']}
result = {'runs': runs, 'originalFailure': {'raw': str(trace.relative_to(out)), 'click': original,
          'inputBoxMatchesAllWebKitDarkDesktopEntranceSamples': len(desktop),
          'domEventTargetRecordedInOriginalTrace': False}, 'observations': observations,
          'limitations': ['Original pointer dispatch/DOM target cannot be recovered from the old trace. Entrance overlap and the scaled input box are direct observations; the exact lost-event path is an inference.',
                          'The first 5 diagnostic runs used an explicit-role-only confirmation probe; its confirmed=false field misses the implicit section landmark. Their original visible-success assertions and traces passed. Final 40 samples use the actual aria-label and also assert confirmation in the observer.']}
(out / 'entry-audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'runs': runs, 'nativeClickSamples': len(observations),
                  'originalBoxMatchedSamples': len(desktop),
                  'finalConfirmationSamples': sum(o['firstConfirmation'] is not None for o in observations)}, indent=2))
