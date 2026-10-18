# TEMPORARY evidence probe — never merged

Task P7b (34h05g5qDzqxO4Cg6dHtP, project 34gyHIZv301nDWxKP9XkO): the Cursor CLI boards iOS 1–6
(`docs/mocks/cursor-engine/`) on the iPhone app.

This probe builds the iOS app's own shell (`src/ios/Sources` minus its `@main`) and the shared OrbitApp sources
into a throwaway app that opens Settings, a new session or a session (`-probe.surface settings | compose |
console`), pointed (`-orbit.instance`) at `stub.py`: the account the boards draw — five machines, one per state
Cursor CLI can be in on a machine, two Cursor keys (one Cursor refused), and four Cursor CLI sessions — served
in the API's own shapes, as the web's P7a captures serve them (`../capture/data.mjs` there). `CursorShotTests`
reaches every screen with the app's own presses on the newest iPhone simulator, photographs it in light and
dark, and checks the words the board puts on it.

Run it from a copy of this directory at the repository root (`project.yml`'s `../src` paths are relative to
it): `ci/client.probe.yml` is the probe branch's `client.yml`, which stages it at `.p7b-probe/`.

Fixture names and data are made up; nothing here is real data.
