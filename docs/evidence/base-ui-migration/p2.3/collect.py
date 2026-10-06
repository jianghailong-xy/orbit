"""Collect a report and its actual attachments without overwriting earlier runs."""
import base64, hashlib, json, pathlib, re, shutil, sys
source, dest = map(pathlib.Path, sys.argv[1:3])
report = json.loads((source / 'report.json').read_text())
assert not dest.exists(), dest
assert not report['stats']['unexpected'] and not report['errors'], 'Not a passing run'
dest.mkdir(parents=True)
shutil.copy2(source / 'report.json', dest / 'report.json')
environment = source.parent / '.ui-migration-results/environment.json'
if environment.exists(): shutil.copy2(environment, dest / 'environment.json')
tests = []
def visit(suite):
    for spec in suite.get('specs', []):
        for test in spec['tests']:
            name = re.sub('[^a-zA-Z0-9.-]+', '-', test['projectName'] + '--' + spec['title'])
            artifacts = []
            for result in test['results']:
                for a in result['attachments']:
                    ext = {'application/json':'json','image/png':'png','text/markdown':'md'}.get(a['contentType'])
                    if not ext: continue
                    file = name + '--' + re.sub('[^a-zA-Z0-9.-]+', '-', a['name']) + '.' + ext
                    content = pathlib.Path(a['path']).read_bytes() if 'path' in a else base64.b64decode(a['body'])
                    (dest / file).write_bytes(content)
                    artifacts.append({'file':file,'sha256':hashlib.sha256(content).hexdigest()})
            tests.append({'name':name,'status':test['status'],'expectedStatus':test['expectedStatus'],'artifacts':artifacts})
    for child in suite.get('suites',[]): visit(child)
for suite in report['suites']: visit(suite)
(dest / 'summary.json').write_text(json.dumps({'stats':report['stats'],'tests':tests},indent=2)+'\n')
print(json.dumps({'destination':str(dest),'stats':report['stats'],'artifacts':sum(len(t['artifacts']) for t in tests)}))
