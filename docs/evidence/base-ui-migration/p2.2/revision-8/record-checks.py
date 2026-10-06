"""Archive this round's runner-hosted (bg_run) jobs as ../checks/r8-*.json/.txt without overwriting.

Exit codes are the ones the runner's own wait() reported through bg_output; the .txt files are the
jobs' original output files, byte for byte (ANSI colour codes included)."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[5]
CHECKS = Path(__file__).resolve().parents[1] / 'checks'
RUNS = Path('/root/.orbit/runs/a110c7ff-d224-5578-84b1-3e07548136d2')
MERGED = ('/root/.orbit/worktrees/a110c7ff-d224-5578-84b1-3e07548136d2', '38947755e48ac979362db36f82bfcf966b527a75')
ACCEPTED = ('/var/tmp/p22-r8-accepted', '45bb56928225bbe6d00800180ebcc73f26250fd4')
FINAL = ('/root/.orbit/worktrees/a110c7ff-d224-5578-84b1-3e07548136d2', '8a29e349324e7aaca83827a52148b540c118b992')
LIST = 'node node_modules/@playwright/test/cli.js test --config src/web/ui-migration/{}.config.mjs --list --reporter=list'
RERUN = ("npm run test:ui-choices -w @orbit/web -- --project chromium-light-desktop --project chromium-dark-desktop "
         "--project chromium-dark-phone --project webkit-light-desktop --grep 'touch or pointer menus dismiss outside|"
         "reduce Dialog Popover Select exits|select supports arrows, Enter, clear|tooltip center zoom origin matches|"
         "normal flipped entrance and exit motion matches search' --repeat-each 3")
PROBE = 'node node_modules/@playwright/test/cli.js test --config docs/evidence/base-ui-migration/p2.2/revision-8/{}.config.mjs'
JOBS = [
    ('prepare-dependencies', 'bgj_8e6055e973fd', 'bash scripts/worktree-overlay.sh', MERGED, 0, '2026-10-06T05:14:51Z'),
    ('build-test', 'bgj_8a52de0d2369', 'npm run build -w @orbit/web && npm run test -w @orbit/web', MERGED, 0, '2026-10-06T05:15:12Z'),
    ('list-choices', 'bgj_bf01e86bc02e', LIST.format('choices'), MERGED, 0, '2026-10-06T05:19:34Z'),
    ('list-toasts', 'bgj_1d3531b0c4cd', LIST.format('toasts'), MERGED, 0, '2026-10-06T05:19:35Z'),
    ('list-p0', 'bgj_91054c003c9e', LIST.format('playwright'), MERGED, 0, '2026-10-06T05:19:36Z'),
    ('choices-entry', 'bgj_58ae8e7158b3', "npm run test:ui-choices -w @orbit/web -- --grep 'Dialog owns choices|Dialog keeps composition|Dialog Popover Select exits'", MERGED, 0, '2026-10-06T05:21:00Z'),
    ('production-notifications', 'bgj_dd22677afc6c', 'node node_modules/@playwright/test/cli.js test --config src/web/ui-migration/playwright.config.mjs feedback-production.browser.mjs', MERGED, 0, '2026-10-06T05:22:18Z'),
    ('toasts-full', 'bgj_fa6ca3793db8', 'npm run test:ui-toasts -w @orbit/web', MERGED, 0, '2026-10-06T05:22:57Z'),
    ('choices-full-first', 'bgj_94ab8b1fe065', 'npm run test:ui-choices -w @orbit/web', MERGED, 1, '2026-10-06T05:33:49Z'),
    ('attention-link', 'bgj_32c7c3c078f1', PROBE.format('attention-link'), MERGED, 0, '2026-10-06T06:02:29Z'),
    ('fixture-types', 'bgj_132520d9a0f9', ' && '.join(f'node node_modules/typescript/bin/tsc -p src/web/ui-migration/{name}.tsconfig.json --noEmit'
                                                  for name in ['choices', 'overlays', 'toasts', 'toasts-tests']), MERGED, 0, '2026-10-06T06:03:07Z'),
    ('accepted-prepare-dependencies', 'bgj_ea6fc076e39d', 'cd /var/tmp/p22-r8-accepted && bash scripts/worktree-overlay.sh', ACCEPTED, 0, '2026-10-06T06:03:38Z'),
    ('rerun-merged', 'bgj_d2ce2a1a41bc', RERUN, MERGED, 0, '2026-10-06T06:04:03Z'),
    ('rerun-accepted', 'bgj_014ba3f67af3', 'cd /var/tmp/p22-r8-accepted && ' + RERUN, ACCEPTED, 0, '2026-10-06T06:06:26Z'),
    ('select-keys-throttle', 'bgj_45195f18db99', PROBE.format('select-keys') + ' --project chromium-dark-desktop', MERGED, 0, '2026-10-06T06:08:46Z'),
    ('select-keys-repeat-timeout', 'bgj_6b6825b1dfd1', PROBE.format('select-keys-repeat') + ' --project chromium-dark-desktop', MERGED, 1, '2026-10-06T06:11:57Z'),
    ('select-keys-repeat-killed', 'bgj_b22f37618622', PROBE.format('select-keys-repeat') + ' --project chromium-dark-desktop --reporter=dot,json', MERGED, None, '2026-10-06T06:17:03Z'),
    ('select-keys-repeat-merged', 'bgj_4c53248760df', PROBE.format('select-keys-repeat') + ' --project chromium-dark-desktop', MERGED, 0, '2026-10-06T06:17:15Z'),
    ('select-keys-repeat-accepted', 'bgj_e3a6b73936d9', 'cd /var/tmp/p22-r8-accepted && ' + PROBE.format('select-keys-repeat') + ' --project chromium-dark-desktop', ACCEPTED, 1, '2026-10-06T06:20:44Z'),
    ('final-prepare-dependencies', 'bgj_50d72c76ef96', 'bash scripts/worktree-overlay.sh', FINAL, 0, '2026-10-06T06:25:11Z'),
    ('final-build-test', 'bgj_6ad1c0483740', 'npm run build -w @orbit/web && npm run test -w @orbit/web', FINAL, 0, '2026-10-06T06:25:45Z'),
    ('final-list-choices', 'bgj_90a6c8811200', LIST.format('choices'), FINAL, 0, '2026-10-06T06:29:59Z'),
    ('final-list-toasts', 'bgj_f841f7f77c7f', LIST.format('toasts'), FINAL, 0, '2026-10-06T06:30:00Z'),
    ('final-list-p0', 'bgj_6a34648ee304', LIST.format('playwright'), FINAL, 0, '2026-10-06T06:30:01Z'),
    ('final-choices-entry', 'bgj_599ea454c708', "npm run test:ui-choices -w @orbit/web -- --grep 'Dialog owns choices|Dialog keeps composition|Dialog Popover Select exits'", FINAL, 0, '2026-10-06T06:30:10Z'),
    ('final-production-notifications', 'bgj_75b37d089a59', 'node node_modules/@playwright/test/cli.js test --config src/web/ui-migration/playwright.config.mjs feedback-production.browser.mjs', FINAL, 0, '2026-10-06T06:31:24Z'),
    ('final-fixture-types', 'bgj_d582e2fee425', ' && '.join(f'node node_modules/typescript/bin/tsc -p src/web/ui-migration/{name}.tsconfig.json --noEmit'
                                                        for name in ['choices', 'overlays', 'toasts', 'toasts-tests']), FINAL, 0, '2026-10-06T06:31:55Z'),
    ('final-attention-link', 'bgj_2c6376696b5b', PROBE.format('attention-link'), FINAL, 0, '2026-10-06T06:32:02Z'),
]
NOTES = {
    'choices-full-first': '515 passed / 5 failed; see revision-8/README.md and choices-full-first/.',
    'select-keys-repeat-timeout': 'Probe design error: 40 samples looped inside one test exceeded the inherited 90s test timeout before attaching; no product result. It ran the first version of the probe, kept as select-keys-repeat-timeout/select-keys-repeat.browser.mjs.as-run.',
    'select-keys-repeat-killed': 'Killed by the session after 5s: the CLI --reporter override would have sent the JSON report to stdout instead of the configured file. Not a result.',
    'select-keys-repeat-accepted': '119 passed / 1 failed: orbit-sample 29 never mounted (15 module requests net::ERR_NETWORK_CHANGED); orbit-sample lost the selection once in the 39 recorded samples.',
}


def main(exit_codes):
    rows = []
    for name, job, command, (cwd, commit), code, started in JOBS:
        code = exit_codes.get(name, code)
        record, log = CHECKS / f'r8-{name}.json', CHECKS / f'r8-{name}.txt'
        if record.exists() or log.exists():
            raise SystemExit(f'{record.name}: retained evidence is never overwritten')
        output = (RUNS / f'{job}.output').read_bytes()
        log.write_bytes(output)
        ended = datetime.datetime.fromtimestamp((RUNS / f'{job}.output').stat().st_mtime, datetime.timezone.utc).isoformat()
        row = {'command': command, 'runner': 'mcp__orbit__bg_run', 'bgJobId': job, 'cwd': cwd, 'commit': commit,
               'webTree': subprocess.check_output(['git', 'rev-parse', f'{commit}:src/web'], cwd=ROOT, text=True).strip(),
               'started': started, 'outputLastWritten': ended, 'exitCode': code,
               'outputSha256': hashlib.sha256(output).hexdigest(), 'outputBytes': len(output)}
        if name in NOTES:
            row['note'] = NOTES[name]
        record.write_text(json.dumps(row, indent=2) + '\n')
        rows.append({'name': f'r8-{name}', 'ref': job, 'command': command, 'exitCode': code})
    (Path(__file__).resolve().parent / 'tool-call-refs.json').write_text(json.dumps(rows, indent=2) + '\n')
    print(json.dumps(rows, indent=1))


if __name__ == '__main__':
    import sys
    # A job whose exit code was read after this list was written is passed as name=code.
    main({k: (None if v == 'null' else int(v)) for k, v in (arg.split('=', 1) for arg in sys.argv[1:])})
