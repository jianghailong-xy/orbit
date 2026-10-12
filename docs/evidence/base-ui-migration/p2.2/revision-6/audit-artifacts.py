"""Verify final-tree reports, their original attachments, and preserved test inputs."""
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
CHECKS = HERE.parent / 'checks'
TESTED = 'baec95275814fdeb6a6530fefeb533338a426787'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


assert subprocess.check_output(['git', 'diff', '--name-only', TESTED, '--', 'src',
    'scripts', 'package.json', 'package-lock.json'], cwd=ROOT, text=True).strip() == ''
baseline = json.loads((ROOT / 'docs/evidence/base-ui-migration/p0.2/environment.json').read_text())
runs = {}
for name, count in [('choices-entry', 32), ('notification-combinations', 88), ('production-notifications', 8)]:
    directory = HERE / name
    summary = json.loads((directory / 'summary.json').read_text())
    report = json.loads((directory / 'report.json').read_text())
    assert summary['stats'] == report['stats']
    assert report['stats']['expected'] == count and not report['errors']
    assert all(report['stats'][s] == 0 for s in ['unexpected', 'flaky', 'skipped'])
    assert report['config']['workers'] == 1
    assert all(p['retries'] == 0 for p in report['config']['projects'])
    assert json.loads((directory / 'environment.json').read_text()) == baseline
    attachments = [a for t in summary['tests'] for a in t['artifacts']]
    assert all(sha(directory / a['file']) == a['sha256'] for a in attachments)
    assert all(len(t['results']) == 1 and t['results'][0]['status'] == 'passed' for t in summary['tests'])
    runs[name] = {'stats': report['stats'], 'attachmentsVerified': len(attachments),
                  'singleAttempt': True, 'baselineEnvironmentMatches': True}

checks = ['upstream-build-test', 'fixture-types', 'choices-entry', 'notification-combinations',
          'production-notifications', 'list-choices', 'list-toasts', 'list-p0']
for name in checks:
    check = json.loads((CHECKS / ('r6-' + name + '.json')).read_text())
    assert check['commit'] == TESTED and check['exitCode'] == 0
    assert all(sha(ROOT / p) == digest for p, digest in check['sourceHashes'].items())
result = {'testedCommit': TESTED, 'webTree': subprocess.check_output(
          ['git', 'rev-parse', TESTED + ':src/web'], cwd=ROOT, text=True).strip(),
          'sourceInputsUnchanged': True, 'checks': checks, 'runs': runs}
(HERE / 'artifact-audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
