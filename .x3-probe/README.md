# TEMPORARY evidence probe — never merged

Task 34vcF5ruSIhVT0TeMblMY (Translation X3 · cross-client check of translated conversations). Task M's `.tm-probe`
(iPhone `CompactShell` and Mac `MainView` built from the tree's own sources into throwaway apps), with its stub's
made-up conversation replaced by `recorded/`: what the real apiserver of the project branch (f55897697) answered for a
real translated session. That stack ran on the HPC host with a fake engine (src/android/scripts/qa/stack_runner.py)
and a stubbed DeepSeek (no key on the host): `events-page.json` is `GET /sessions/:id/events/page?tail=1`,
`turns-active.json` is `GET /sessions/:id/turns?view=active`, taken while one held message had failed and another was
still translating. A GitHub runner cannot reach that host, so the apps read the recording.

`TranslationShotTests` photographs board frames 4–6 and 8: the translated conversation (tool calls, thinking, inline
code and code block as written), Show original on one message, the failure rows and Translating…, reply Retry (the
stub answers it and pushes the live `translation` event), and a streaming reply's "Translates when the reply is done".
