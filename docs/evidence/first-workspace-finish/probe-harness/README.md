# Evidence probe: the setup card's finishing touches on iPhone and Mac

Task 34pSMchIBHSRImnxiCxuk, copied from `docs/evidence/first-workspace-native/probe-harness` (task
34pLtXs3PjSVUmtKFuDvQ). The probe builds the apps' own shells from the real shared sources into throwaway apps
pointed at `stub.py`, and drives three states of the setup card (docs/mocks/first-workspace-in-conversation) as a
person does:

- F1: a machine approved a moment ago and not connected yet (`scene: connecting`: offline, no heartbeat, nothing
  declared) is waited for, never said to update itself, and its folder step opens within seconds of its first
  heartbeat, with nothing but the page's own reads to find it.
- F4: the register directory's first question waits (`slow: true`) until a typed path takes the machine's one
  slot; the card asks it again once the path has its answer, and the suggestion comes.
- F6: a new folder's name is asked about at `<reposRoot>/<name>` before anything is sent: a folder there already
  (`payments`) is used with what is in it and goes by its path; a file there (`notes.txt`) can't be one.

- `stub.py` is the fixture API (all data made up); `POST /__set` picks a scene, `GET /__log` is the request log.
- `UITests/FirstWorkspaceFinishShotTests.swift` defines what is pressed and what has to be on screen.
- `project.yml`, `ProbeArgs.swift`, `ios/`, `mac/`, `Info.plist` and `run.sh` build and run it (Mac, then iPhone).
- `ci/client.probe.yml` is client.yml on a `probe/…` branch, with the macOS and iOS gates beside the shots. It is
  never merged.

To run it again, copy this directory to `.fwf-probe/` at the repository root, because its `../src` paths are
relative to there, and `ci/client.probe.yml` to `.github/workflows/client.yml`.
