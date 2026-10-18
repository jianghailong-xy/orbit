# Web tests on main under UTC: CI "Test web" red since 2026-10-08

Evidence for the task [Fix main's CI web tests](orbit-task:34cp3FjQRKF6ch5PGvhCa). Measured on 2026-10-09 in two
places. GitHub Actions: the JavaScript job of `.github/workflows/ci.yml` (ubuntu-latest, Node 26, UTC). HPC: runner
workstation-gpu (Node 26.10.0, UTC+8), running `vitest run --maxWorkers=2`, which is what `npm test -w @orbit/web` runs.

## What failed

One test failed in every main CI run that reached "Test web", from run 2331 (`d3ef58c75`, 2026-10-08 08:30Z) to run
2419 (`c8a431304`, 2026-10-09 11:35Z). That is 41 runs, with the same single failure each time and nothing else
failing in that step. The last main runs where "Test web" passed are 2329 (`bcc89c7af`) and 2330 (`4d77d69b7`).
[ci-test-web-runs.md](ci-test-web-runs.md) lists every run, read from the JavaScript job's own log.

- `src/components/ProjectPanoramaHeader.test.tsx > the landing row, from a server that lists its jobs > makes the
  row a button that opens the list, and keeps it a line to read from an older server`
- The test expects the older server's row to carry `class="project-landing project-landing-running"`. On CI the row
  read `No report`, with `No report for 479m`.

## Why only on CI

- The test sets the clock to `NOW = new Date(2026, 8, 25, 21, 57, 30)`, which is 21:57:30 on the *local* clock.
- The older server's row comes from `integration()`, whose in-flight report is a *UTC* instant: the job was claimed
  and last heard from at `2026-09-25T13:58:00Z`.
- For a server that does not list its jobs, the row reads "No report" once the report is older than
  `INTEGRATION_CLAIM_STALE_MS` (10 min), and a "No report" row is not drawn as running.
- At UTC+8 (HPC), NOW is 13:57:30Z, so the report is 30 s ahead of NOW and fresh: the row is Running and the test
  passes. At UTC (GitHub's runners), NOW is 21:57:30Z, so the report is 479 min old: the row reads No report and the
  test fails. The test passes only where local time is 8 hours or more ahead of UTC.
- Each side was fine on its own line:
  - The test came with 4be4b01fe (project/34bmzOkov3xN2yLPrnsCk). At that point the fixture had no heartbeat, and
    only a stale heartbeat that was actually there counted. So the test passed in every time zone (run 2330).
  - befc9694c (project/34bZ3i4AvgJaaoaw5E9tH) gave the fixture its heartbeat, and made a runner that has gone quiet
    read "No report".
  - The two met in the merge 3c46f83fb, which reached main with d3ef58c75. The merged tree passes on HPC, at UTC+8.

The component is right: it compares two absolute instants, and a report 8 hours old is "No report". The test mixed a
local clock with UTC instants, so the fix is in the test.

## Fix

`b9b52a924`, on this branch before landing: `test(web): make the older-server landing-row case independent of the time
zone`. The older server's report is now claimed and stamped 80 s before NOW, on the same clock the test sets. It
changes one test file. There is no component change, no skipped or deleted test, and no time zone pinned in a config.

## Before and after

GitHub Actions, JavaScript job:

| Run | Commit | Test web | Vitest |
|---|---|---|---|
| [2419](https://github.com/jianghailong-xy/orbit/actions/runs/37924682927) (main, push) | `c8a431304`, the fix's parent | failure | files 1 failed, 375 passed (376); tests 1 failed, 4904 passed (4905) |
| [2420](https://github.com/jianghailong-xy/orbit/actions/runs/37925405725) (`probe/main-web-tests-utc`, workflow_dispatch) | `b9b52a924`, the fix | **success** | files 376 passed (376); tests 4905 passed (4905) |

Run 2420 is the CI workflow, unchanged, dispatched on a branch that points at the fix commit. All 14 steps of its
JavaScript job passed. That includes the two steps after "Test web", which main has skipped since 10-08. The steps were
read twice: from the API, and from the `<check-step data-conclusion>` tags on the public job page.

HPC, the whole web suite in 4 shards, each run outside the runner's cgroup:

| Tree | TZ | Files | Tests | Failed |
|---|---|---|---|---|
| base `c8a431304` | UTC | 376 | 4905 | 1: the test above |
| base `c8a431304` | Asia/Shanghai | 376 | 4905 | 0 |
| fix `b9b52a924` | UTC | 376 | 4905 | 0 |
| fix `b9b52a924` | Asia/Shanghai | 376 | 4905 | 0 |

The changed file alone (63 tests), in five time zones:

| TZ | UTC offset on 2026-10-09 | base `c8a431304` | fix `b9b52a924` |
|---|---|---|---|
| Pacific/Pago_Pago | −11 | 1 failed, 62 passed | 63 passed |
| America/Los_Angeles | −7 | 1 failed, 62 passed | 63 passed |
| UTC | 0 | 1 failed, 62 passed | 63 passed |
| Asia/Shanghai | +8 | 63 passed | 63 passed |
| Pacific/Kiritimati | +14 | 63 passed | 63 passed |

## Notes

- The task named run 2333 (`075b7a6c8`) as the first failure. Runs 2331 (`d3ef58c75`) and 2332 (`93ab20b8c`) were
  cancelled as runs, but their JavaScript jobs had already finished, failing on this test.
- Runs 2371–2376 never reached "Test web", because "Build workspaces" failed earlier in the JavaScript job. That is
  outside this task.
- The commit that adds this directory cannot name its own CI run. That run is in the task's evidence.
