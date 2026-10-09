# TEMPORARY evidence probe — never merged

The managed runner's states in the iPhone app (`CompactShell`) and the Mac app (`MainView`), built from
the real shared sources into throwaway apps pointed at `stub.py`. Every state is a server state sample
from `src/shared/src/managed-runner-states.fixture.json`, the file the web, @orbit/shared, OrbitKit and
the apiserver are all tested against; the stub renames its runner and workspace to `r1` and `a1`.
`ManagedShotTests` photographs one state per launch, presses Retry and Set up, and fails when a state
never shows or when the app reads the status without the capability.

To run it: copy this directory to `.mr-probe/` at the repo root and `client.probe.yml` to
`.github/workflows/client.yml` on a `probe/c7-managed-runner-status` branch, and push; the report job
pushes the pictures, notes, request logs and build log tails to
`probe/c7-managed-runner-status-results`. The same push runs client.yml's two compile gates (OrbitKit
`swift test` and OrbitApp `swift build` on macOS; the iOS app for the simulator). Nothing here is a real
runner or model; all data is made up. The boards built from it are in `docs/mocks/managed-runner-status/`.
