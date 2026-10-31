# Evidence probe: a machine's first workspace on iPhone, iPad and Mac

Task 34pLtXs3PjSVUmtKFuDvQ. The probe builds the apps' own shells from the real shared sources into
throwaway apps pointed at `stub.py`, and drives the flow of boards 03 and 04
(docs/mocks/first-workspace-in-conversation) as a person does.

- `stub.py` is the fixture API: orbit@austin with no workspace, the directory probe relay of
  docs/first-workspace-contract.md §2 and `POST /sessions` with `newWorkspace` of §3. `POST /__set` picks a
  scene (`bare`, `mixed`, `offline`, `old`) or lands a sign-in. All data is made up.
- `UITests/FirstWorkspaceShotTests.swift` defines what is pressed and what has to be on screen. A missing
  word, a press offered where there should be none, or a create that didn't name the machine and the
  folder fails the test.
- `project.yml`, `ProbeArgs.swift`, `ios/`, `mac/`, `Info.plist` and `run.sh` build and run it.
- `ci/client.probe.yml` is client.yml on a `probe/…` branch, with the macOS and iOS gates beside the shots.
  It is never merged.

To run it again, copy this directory to `.fw-probe/` at the repository root, because its `../src` paths are
relative to there, and `ci/client.probe.yml` to `.github/workflows/client.yml`.
