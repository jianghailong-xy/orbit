#!/usr/bin/env python3
"""Usage: collect-run.py <results-dir> <dest> — every attachment of a Playwright JSON report, named
{project}--{test title}--{attachment}.{ext} like P2.3's collect.py, plus summary.json with each test's
status and artifact hashes. Unlike P2.3's collect.py it also collects failing runs (status is recorded)."""
import base64, hashlib, json, pathlib, re, sys
source, dest = map(pathlib.Path, sys.argv[1:3])
report = json.loads((source / 'report.json').read_text())
dest.mkdir(parents=True, exist_ok=False)
tests = []
def visit(suite):
    for spec in suite.get('specs', []):
        for test in spec['tests']:
            name = re.sub('[^a-zA-Z0-9.-]+', '-', test['projectName'] + '--' + spec['title'])
            artifacts = []
            for result in test['results']:
                for a in result['attachments']:
                    ext = {'application/json': 'json', 'image/png': 'png', 'text/markdown': 'md'}.get(a['contentType'])
                    if not ext: continue
                    file = name + '--' + re.sub('[^a-zA-Z0-9.-]+', '-', a['name']) + '.' + ext
                    path = pathlib.Path(a['path']) if 'path' in a else None
                    if path is not None and not path.exists():
                        # The run's own results directory was copied to <source>: find the file there.
                        parts = path.parts
                        marker = next((i for i, part in enumerate(parts) if part.startswith('.') and part.endswith('-results')), None)
                        path = source.joinpath(*parts[marker + 1:]) if marker is not None else None
                        if path is not None and not path.exists(): path = None
                    content = path.read_bytes() if path is not None else base64.b64decode(a['body']) if 'body' in a else None
                    if content is None: continue
                    (dest / file).write_bytes(content)
                    artifacts.append({'file': file, 'sha256': hashlib.sha256(content).hexdigest()})
            tests.append({'name': name, 'status': test['status'], 'expectedStatus': test['expectedStatus'], 'artifacts': artifacts})
    for child in suite.get('suites', []): visit(child)
for suite in report['suites']: visit(suite)
(dest / 'summary.json').write_text(json.dumps({'stats': report['stats'], 'tests': tests}, indent=2) + '\n')
print(json.dumps({'destination': str(dest), 'stats': report['stats'], 'artifacts': sum(len(t['artifacts']) for t in tests)}))
