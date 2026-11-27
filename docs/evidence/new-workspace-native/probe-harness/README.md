# TEMPORARY evidence probe — never merged

Task 350iNy7QepKiSO4d2lVku: New workspace on a machine that already has one (docs/mocks/new-workspace-form/02-apple-entry,
owner A 2026-11-20). It builds the iPhone app's own `CompactShell` and the Mac app's own `MainView` from the tree's shell and
shared sources into throwaway apps pointed at `stub.py`: orbit@austin (home `/home/orbit`) holds `orbit`, build-box holds
`wiki-site`, `/home/orbit/code/api` is a git repository on `main`, and anything else is not there. `NewWorkspaceShotTests`
presses the Workspaces group's +, picks orbit@austin from its menu, types a full path to the repository, then a missing
one, then presses Create workspace and checks the `POST /api/agents` the stub logged; on the phone in light and dark, and
from the machine page's New workspace row; on the Mac the same card from the sidebar's +. All data is made up.

Run it as `.nw-probe/` on a probe branch whose `.github/workflows/client.yml` is `client.probe.yml`: that file also runs
client.yml's macOS (OrbitKit `swift test`, OrbitApp `swift build`) and iOS jobs on the same commit, and pushes every
result to `probe/new-workspace-results`. Scaffold from docs/evidence/held-cancel-native/probe-harness, `ProbeCase` and the
stub's plumbing from docs/evidence/first-workspace-native/probe-harness.
