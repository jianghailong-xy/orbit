#!/usr/bin/env bash
# One run at a time, resumable: a step whose record (runs/<label>/meta.json) exists is skipped.
# usage: queue.sh <label>=<step> ...   steps:
#   firstframe        the new test only, eight projects (npm run test:ui-choices -- choices-first-frame.browser.mjs)
#   choices           the whole choices matrix, eight projects (npm run test:ui-choices)
#   overlays          the overlays matrix (npm run test:ui-overlays)
#   build             npm run build -w @orbit/shared && npm run build -w @orbit/web
#   merge-check       the project's merge check: npm run build -w @orbit/web && npm run test -w @orbit/web
#   p0                P0 by its original command (npm run test:ui-migration -w @orbit/web; its pretest builds)
#   pilot / p41       the P3.2 pilot / P4.1 suite on the tree's build, --update-snapshots=all into runs/<label>/shots
#   held-frames | prior-select | prior-menu | kw2   the second window batch's probes (p2-keyboard-window-2 configs)
#   antd-first        the replaced popups' first frames (overlay-first-frame/antd-first-frame.config.mjs)
#   probes            painted frames and owner scroll (scripts/probes.sh, both trees)
#   vitest-graph      the one Vitest file that timed out in a merge check, on its own
# A label's tree is ref (component fix left out) when the label starts with "ref-", else run (the fix).
# Each step runs in its own network namespace (only lo, so fixed ports cannot meet another session's), at
# nice -10; raw results stay under runs/<label>. Below 2 GB free on / a step waits (coordinator's rule).
set -u
B=/mnt/data/tmp/overlay-first-frame-34brok
export TMPDIR=$B/tmp
for item in "$@"; do
  label=${item%%=*}; step=${item#*=}
  out=$B/runs/$label
  [ -e "$out/meta.json" ] && { echo "$label recorded; skipped"; continue; }
  case $label in ref-*) tree=$B/ref ;; *) tree=$B/run ;; esac
  rm -rf "$out"; mkdir -p "$out"
  web=src/web; results=
  case $step in
    firstframe) cmd='npm run test:ui-choices -w @orbit/web -- choices-first-frame.browser.mjs'; results=.choices-results ;;
    choices) cmd='npm run test:ui-choices -w @orbit/web'; results=.choices-results ;;
    overlays) cmd='npm run test:ui-overlays -w @orbit/web'; results=.overlays-results ;;
    build) cmd='npm run build -w @orbit/shared && npm run build -w @orbit/web' ;;
    merge-check) cmd='npm run build -w @orbit/web && npm run test -w @orbit/web' ;;
    p0) cmd='npm run test:ui-migration -w @orbit/web'; results=.ui-migration-results ;;
    pilot) cmd="cd src/web && P32_SNAPSHOTS=$out/shots P32_OUTPUT=$out/results npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --update-snapshots=all" ;;
    p41) cmd="cd src/web && P41_SNAPSHOTS=$out/shots P41_OUTPUT=$out/results npx playwright test -c ui-migration/p41.config.mjs --update-snapshots=all" ;;
    held-frames) cmd="KW2_RESULTS=$out/results node node_modules/@playwright/test/cli.js test --config docs/evidence/base-ui-migration/p2-keyboard-window-2/held-frames-2.config.mjs" ;;
    prior-select) cmd="KW2_RESULTS=$out/results node node_modules/@playwright/test/cli.js test --config docs/evidence/base-ui-migration/p2-keyboard-window-2/prior-select-keys.config.mjs" ;;
    prior-menu) cmd="KW2_RESULTS=$out/results node node_modules/@playwright/test/cli.js test --config docs/evidence/base-ui-migration/p2-keyboard-window-2/prior-menu-held-frames.config.mjs" ;;
    kw2) cmd="KW2_RESULTS=$out/results node node_modules/@playwright/test/cli.js test --config docs/evidence/base-ui-migration/p2-keyboard-window-2/keyboard-window-2.config.mjs --project chromium-dark-desktop" ;;
    antd-first) cmd="FIRST_FRAME_RESULTS=$out/results node node_modules/@playwright/test/cli.js test --config docs/evidence/base-ui-migration/overlay-first-frame/antd-first-frame.config.mjs" ;;
    probes) cmd="bash $B/scripts/probes.sh $out" ;;
    vitest-graph) cmd='cd src/web && npx vitest run src/components/ProjectTasksGraph.test.tsx' ;;
    *) echo "unknown step $step"; exit 2 ;;
  esac
  while [ "$(df --output=avail -B1M / | tail -1 | tr -dc 0-9)" -lt 2048 ]; do
    echo "$(date -u +%FT%TZ) $label waits: under 2 GB free on /"; sleep 60
  done
  start=$(date -u +%FT%TZ); load=$(cut -d' ' -f1-3 /proc/loadavg)
  echo "$start $label ($step) in $tree: $cmd"
  (cd "$tree" && unshare -n bash -c "ip link set lo up && NO_COLOR=1 nice -n -10 bash -c \"$cmd\"") > "$out/output.txt" 2>&1
  code=$?
  if [ -n "$results" ]; then cp -r "$tree/$web/$results" "$out/results"; fi
  [ -e "$tree/$web/.ui-migration-results/environment.json" ] && cp "$tree/$web/.ui-migration-results/environment.json" "$out/environment.json"
  python3 - "$out/meta.json" "$tree" "$label" "$step" "$cmd" "$start" "$load" "$code" <<'EOF'
import datetime, json, subprocess, sys
path, tree, label, step, command, start, load, code = sys.argv[1:]
git = lambda *a: subprocess.run(['git', '-C', tree, *a], capture_output=True, text=True).stdout.strip()
diff = subprocess.run(['git', '-C', tree, 'diff', 'HEAD', '--', 'src/web'], capture_output=True).stdout
import hashlib
json.dump({'label': label, 'step': step, 'tree': tree, 'command': command, 'commit': git('rev-parse', 'HEAD'),
           'webChanges': git('status', '--porcelain', '--', 'src/web').splitlines(),
           'webDiffSha256': hashlib.sha256(diff).hexdigest(), 'startedAt': start,
           'endedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
           'loadAverage': {'start': load, 'end': ' '.join(open('/proc/loadavg').read().split()[:3])}, 'exitCode': int(code)},
          open(path, 'w'), indent=1)
EOF
  echo "$(date -u +%FT%TZ) $label exit $code"
done
