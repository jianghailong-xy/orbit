# TEMPORARY evidence probe — never merged

Task T8 (34cdPiDErJ3Zc2bsj7hcm, project 34ccMg4EoSorpVooMC4kg): the provider/engine decoupling boards iOS 1, 2,
4 and 5 (`docs/mocks/provider-engine-decoupling/`) on the iPhone app.

This probe builds the iOS app's own shell (`src/ios/Sources` minus its `@main`) and the shared OrbitApp sources
into a throwaway app that opens Settings, a new session or a session (`-probe.surface settings | compose |
console`), pointed (`-orbit.instance`) at `stub.py`: the account the boards draw — three machines, two DeepSeek
keys, Gemini, Kimi and GLM keys, a Claude subscription token, a Claude account pool — served in the API's own
shapes. `T8ShotTests` reaches every screen with the app's own presses on the newest iPhone simulator,
photographs it in light and dark, and checks the words the board puts on it.

Fixture names and data are made up; nothing here is real data.
