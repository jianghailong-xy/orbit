"""Summarize the archived composer runs (composer-run/*) into composer-summary.json.

Reads only the archived attachments; never edits them. Refuses to overwrite an existing summary."""
import hashlib
import json
from pathlib import Path

here = Path(__file__).resolve().parent
destination = here / 'composer-summary.json'
if destination.exists():
    raise SystemExit('Retained evidence is never overwritten.')
summary = {'runs': {}, 'states': 0, 'statesWithDifferences': 0, 'pixels': {'captures': 0, 'identical': 0, 'maxChannelDelta': 0, 'nonIdentical': []},
           'mirrorProbe': {}, 'motion': {}, 'reducedMotion': {}, 'cost': None, 'p0Anchors': [], 'attachments': 0}
for run in sorted((here / 'composer-run').iterdir()):
    report = json.loads((run / 'summary.json').read_text())
    summary['runs'][run.name] = report['stats'] | {'tests': len(report['tests'])}
    for test in report['tests']:
        for artifact in test['artifacts']:
            path = run / artifact['file']
            assert hashlib.sha256(path.read_bytes()).hexdigest() == artifact['sha256'], path
            summary['attachments'] += 1
            if not artifact['file'].endswith('.json'):
                continue
            body = json.loads(path.read_text())
            project = test['name'].split('--')[0]
            if artifact['file'].endswith('-states.json'):
                for impl_states in [body['states']['orbit']]:
                    summary['states'] += len(impl_states)
                summary['statesWithDifferences'] += len({entry['case'] for entry in body['differences']})
                for state, result in body['pixels'].items():
                    for capture in ['repainted', 'firstPaint']:
                        summary['pixels']['captures'] += 1
                        if result[capture]['different'] == 0:
                            summary['pixels']['identical'] += 1
                        else:
                            summary['pixels']['nonIdentical'].append({'project': project, 'file': artifact['file'], 'state': state, 'capture': capture,
                                'pixels': result[capture]['different'], 'maxChannelDelta': result[capture]['maxChannelDelta'], 'box': result[capture]['box']})
                        summary['pixels']['maxChannelDelta'] = max(summary['pixels']['maxChannelDelta'], result[capture]['maxChannelDelta'])
            elif artifact['file'].endswith('mirror-probe.json'):
                summary['mirrorProbe'][project] = {impl: {case: value['different'] for case, value in cases.items()} for impl, cases in body.items()}
            elif artifact['file'].endswith('normal-motion.json'):
                summary['motion'][project] = {impl: {key: value['animations'] for key, value in entries.items() if isinstance(value, dict) and 'animations' in value}
                                              for impl, entries in body.items()}
            elif artifact['file'].endswith('reduced-motion.json'):
                summary['reducedMotion'][project] = body
            elif isinstance(body, dict) and set(body) == {'ant', 'orbit'} and isinstance(body['ant'], list):
                # Input-behaviour recordings: re-check independently that both fields recorded the same steps.
                name = artifact['file'].split('--')[-1].removesuffix('.json')
                summary.setdefault('inputBehaviour', {}).setdefault(name, {})[project] = {
                    'steps': len(body['orbit']), 'identical': body['orbit'] == body['ant'], 'labels': [step['label'] for step in body['orbit']]}
            elif artifact['file'].endswith('keystroke-cost.json'):
                summary['cost'] = {'project': project, 'method': body['method'], 'results': {impl: {draft: {metric: {k: v for k, v in values[metric].items() if k != 'samples'}
                    for metric in ['inputWork', 'twoFrames']} | {'height': values['height']} for draft, values in drafts.items()} for impl, drafts in body['results'].items()}}
destination.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({key: summary[key] for key in ['runs', 'states', 'statesWithDifferences', 'attachments']}, indent=2))
print(json.dumps({key: value for key, value in summary['pixels'].items() if key != 'nonIdentical'}), len(summary['pixels']['nonIdentical']), 'non-identical captures')
