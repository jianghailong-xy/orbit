# TEMPORARY evidence probe — never merged

P5 (DeepSeek Harness on the native clients). Builds the iPhone app's `CompactShell` and the Mac app's
`MainView` from the real shared sources into throwaway apps pointed at `stub.py`, a fixture API with
three runners (ready / old / not installed), a Harness key beside the Claude-borrowing DeepSeek key,
and a Harness session that advances only when the app sends the real request (create, approve,
interrupt, follow-up). `DshShotTests` presses those controls and photographs each state, light and
dark, plus the unavailable states. The stub has no event stream: after each press the console is
reopened to read the next state. Nothing here is a real runner or model; all data is made up.
