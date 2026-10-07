#!/usr/bin/env bash
# Production-build checks of the tree as it is: usage prod-runs.sh <label> <step> [<step> ...]
#   build    npm run build -w @orbit/shared && npm run build -w @orbit/web
#   pilot    the P3.2 pilot suite on that build, twice (the second run measures the tree's own run-to-run noise),
#            each with --update-snapshots=all into /var/tmp/kw2-246921c8/pilot/<label>-<n>-shots, raw results in
#            /var/tmp/kw2-246921c8/runs/pilot-<label>-<n>, slim copy (slim.py) in pilot-<label>-<n>/ here
#   choices-entry, choices-full, overlays
#            the choices original entry (npm run test:ui-choices -- --grep "Dialog owns choices|Dialog keeps
#            composition|Dialog Popover Select exits", eight projects), the whole choices matrix
#            (npm run test:ui-choices) and the overlays matrix (npm run test:ui-overlays), by their npm scripts; raw
#            results copied to /var/tmp/kw2-246921c8/runs/<step>-<label>, slim copy in <step>-<label>/ here
#   choices-list  the choices test list (playwright --list), to show no test was added, removed or renamed
#   entry-repeat  the choices entry's "Dialog Popover Select exits" test ten times in chromium-light-desktop and
#            webkit-dark-phone (--repeat-each 10), the two projects where it failed once under load; raw results
#            copied to /var/tmp/kw2-246921c8/runs/entry-repeat-<label>, slim copy in entry-repeat-<label>/ here
#   p0       P0 by its original command, npm run test:ui-migration -w @orbit/web (its pretest builds again); raw
#            results copied to /var/tmp/kw2-246921c8/runs/p0-<label>, slim copy in p0-<label>/ here. Its output
#            directory is src/web/.ui-migration-results, which every probe's globalSetup also writes, so it runs
#            when no other browser run of this tree is going.
# The runs are in their own network namespace at nice -10. Each step's output is checks/prod-<label>-<step>.txt and
# its command, tree, times, load and exit code checks/prod-<label>-<step>.json; an existing record is never replaced:
# a recorded step is skipped, so the same command resumes after an interruption. Each step starts only with at
# least 6 GB free on / (the coordinator's floor for this shared disk), waiting until then.
set -u
label=$1; shift
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
raw=/var/tmp/kw2-246921c8
mkdir -p "$raw/runs" "$raw/pilot" "$here/checks"
cd "$root"
run() {  # run <record name> <command>
  local name=$1 command=$2 record="$here/checks/prod-$label-$1"
  [ -e "$record.json" ] && { echo "$record.json exists; skipped"; return 1; }
  while [ "$(df --output=avail -B1M / | tail -1 | tr -d ' ')" -lt 6144 ]; do
    echo "$(date -u +%FT%TZ) $name waits for 6 GB free on /"; sleep 60
  done
  local start; start=$(date -u +%FT%TZ)
  local load; load=$(cut -d' ' -f1-3 /proc/loadavg)
  bash -c "$command" > "$record.txt" 2>&1
  local code=$?
  python3 - "$record.json" "$command" "$start" "$load" "$code" <<'EOF'
import datetime, json, subprocess, sys
path, command, start, load, code = sys.argv[1:]
git = lambda *a: subprocess.run(['git', *a], capture_output=True, text=True).stdout.strip()
json.dump({'command': command, 'commit': git('rev-parse', 'HEAD'), 'webTree': git('rev-parse', 'HEAD:src/web'),
           'dirtyWeb': git('status', '--porcelain', '--', 'src/web'), 'startedAt': start,
           'endedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
           'loadAverage': {'start': load, 'end': open('/proc/loadavg').read().split()[:3]}, 'exitCode': int(code)},
          open(path, 'w'), indent=1, ensure_ascii=False)
EOF
  echo "$name exit $code"
}
for step in "$@"; do
  case $step in
    build) run build 'nice -n 10 npm run build -w @orbit/shared && nice -n 10 npm run build -w @orbit/web' || continue ;;
    pilot) for n in 1 2; do
        run "pilot-$n" "unshare -n bash -c 'ip link set lo up && cd src/web && P32_SNAPSHOTS=$raw/pilot/$label-$n-shots P32_OUTPUT=$raw/runs/pilot-$label-$n NO_COLOR=1 nice -n -10 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all'" || continue
        cp src/web/.ui-migration-results/environment.json "$raw/runs/pilot-$label-$n/environment.json"
        python3 -B "$here/slim.py" "$raw/runs/pilot-$label-$n" "$here/pilot-$label-$n" > /dev/null
      done ;;
    p0) run p0 "unshare -n bash -c 'ip link set lo up && NO_COLOR=1 nice -n -10 npm run test:ui-migration -w @orbit/web'" || continue
        rm -rf "$raw/runs/p0-$label" && cp -r src/web/.ui-migration-results "$raw/runs/p0-$label"
        python3 -B "$here/slim.py" "$raw/runs/p0-$label" "$here/p0-$label" > /dev/null ;;
    choices-entry|choices-full|overlays)
        case $step in
          choices-entry) script=test:ui-choices; grep=' -- --grep "Dialog owns choices|Dialog keeps composition|Dialog Popover Select exits"'; results=.choices-results ;;
          choices-full) script=test:ui-choices; grep=''; results=.choices-results ;;
          overlays) script=test:ui-overlays; grep=''; results=.overlays-results ;;
        esac
        run "$step" "unshare -n bash -c 'ip link set lo up && NO_COLOR=1 nice -n -10 npm run $script -w @orbit/web$grep'" || continue
        rm -rf "$raw/runs/$step-$label" && cp -r "src/web/$results" "$raw/runs/$step-$label"
        cp src/web/.ui-migration-results/environment.json "$raw/runs/$step-$label/environment.json"
        python3 -B "$here/slim.py" "$raw/runs/$step-$label" "$here/$step-$label" > /dev/null ;;
    choices-list) run choices-list 'cd src/web && NO_COLOR=1 npx playwright test --config ui-migration/choices.config.mjs --list' || continue ;;
    entry-repeat) run entry-repeat "unshare -n bash -c 'ip link set lo up && NO_COLOR=1 nice -n -10 npm run test:ui-choices -w @orbit/web -- --grep \"Dialog Popover Select exits\" --project chromium-light-desktop --project webkit-dark-phone --repeat-each 10'" || continue
        rm -rf "$raw/runs/entry-repeat-$label" && cp -r src/web/.choices-results "$raw/runs/entry-repeat-$label"
        cp src/web/.ui-migration-results/environment.json "$raw/runs/entry-repeat-$label/environment.json"
        python3 -B "$here/slim.py" "$raw/runs/entry-repeat-$label" "$here/entry-repeat-$label" > /dev/null ;;
    *) echo "unknown step $step"; exit 2 ;;
  esac
done
