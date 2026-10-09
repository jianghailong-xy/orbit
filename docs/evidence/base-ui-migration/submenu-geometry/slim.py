"""slim.py <run-dir> <evidence-dir>: a Playwright run's committed copy.

report.summary.json is the run's report.json with only attachments[].body removed (titles, projects, statuses,
durations, retries, errors and attachment paths stay). geometry.json collects the bodies of the
submenu-geometry attachments, and threshold.json those of the threshold probe's, by project and test. run.txt,
output.txt and environment.json are copied as they are.
"""
import base64, json, os, shutil, sys

run, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
report = json.load(open(os.path.join(run, 'results', 'report.json')))
records = {'submenu-geometry': {}, 'threshold': {}}

def walk(suites):
    for suite in suites:
        yield from walk(suite.get('suites', []))
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                for result in test['results']:
                    yield spec, test, result

for spec, test, result in walk(report['suites']):
    for attachment in result.get('attachments', []):
        body = attachment.pop('body', None)
        if body is not None and attachment['name'] in records:
            records[attachment['name']].setdefault(test['projectName'], {})[spec['title']] = json.loads(base64.b64decode(body))
json.dump(report, open(os.path.join(out, 'report.summary.json'), 'w'), indent=1)
for name, file in (('submenu-geometry', 'geometry.json'), ('threshold', 'threshold.json')):
    if records[name]:
        json.dump(records[name], open(os.path.join(out, file), 'w'), indent=1)
for name in ('run.txt', 'output.txt', 'environment.json'):
    if os.path.exists(os.path.join(run, name)):
        shutil.copy(os.path.join(run, name), out)
