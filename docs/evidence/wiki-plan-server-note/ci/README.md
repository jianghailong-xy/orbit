# The client.yml probe — the two shells compiled on CI

The merge check is one Linux container and never compiles OrbitApp (SwiftUI doesn't exist there), so the
three OrbitApp files this delivery changes — `Views/WikiPlanView.swift`, `Views/WikiDocScreens.swift`,
`WikiModel.swift` — are covered locally only by OrbitKit (Linux) and by `WikiWiringTests`' source
assertions. This is the probe that compiles them, as P9's did.

## What was pushed

| ref | commit | what it is |
| --- | --- | --- |
| `probe/plan-system-model-note` | `8793ce12c35669678f7a146ed8a865b09f9c3988` | the delivery's tip, exactly — a plain push |
| `probe/plan-system-model-note-compile` | `b76a0246c397b4805df22bbb752fb6fff0fbfcf7` | the same tip plus one file, `plan-note-dispatch.yml` |

The macOS and iOS jobs of `client.yml` run only on a pull request or an explicit dispatch (macOS runners
bill at 10×), and this machine has neither a token nor `gh`. So the second branch carries a one-file
temporary workflow — `plan-note-dispatch.yml`, kept beside this README — that turns the push into the
dispatch with the repository's own `GITHUB_TOKEN`, exactly as `probe-dispatch.yml` does for the
source-refused probe. It is the only difference between the compiled commit and the delivery's tip, and
it is deleted with the branch.

## What CI said

| run | event | conclusion |
| --- | --- | --- |
| [37761308160](https://github.com/jianghailong-xy/orbit/actions/runs/37761308160) — `Client CI (macOS + iOS)`, plain push of the tip | `push` | **success** — the jobs a push runs: *Navigation (one push mechanism per stack)*, *Font tokens (bare system(size:) audit)*. The two Mac jobs are skipped by design on a push. |
| [37762671046](https://github.com/jianghailong-xy/orbit/actions/runs/37762671046) — `Client CI (macOS + iOS)`, dispatched at the probe commit | `workflow_dispatch` | **success** — `macos-15`: **Test OrbitKit (macOS) → success**, **Build OrbitApp → success**; `macos-15`: Generate Xcode project → **Build for iOS Simulator → success**. Both, and every step of them, `completed / success`. |

The reads behind the table are in this directory:

- `push-runs.json`, `push-jobs.json` — the push run and its jobs;
- `compile-run.json`, `compile-runs.json`, `compile-jobs.json` — the dispatch run, the runs on the probe
  branch, and the dispatch run's every step;
- `plan-note-dispatch.yml` — the temporary workflow, as it was pushed.

The two Mac jobs are the point: the first proves OrbitKit's macOS half and that **OrbitApp builds** —
the SwiftUI files this delivery touched; the second proves the shared SwiftUI surface still builds for
the iOS Simulator.
