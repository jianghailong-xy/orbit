# Prompt optimizer, iOS and macOS shots (TEMPORARY probe, never merged)

Board: docs/mocks/prompt-optimizer/01-board.png. The real iPhone `CompactShell` and Mac `MainView`
run over `stub.py` and photograph frames 1 (Settings, switch off), 1b (no DeepSeek key), 2 (✦ Optimize
beside Send), 3 (Optimizing…), 4 (iPhone: sheet over the composer; Mac: card above it), 4b (the gloss,
"Show in Chinese"), 5 (after Use, with Undo), 5b (after Undo) and 6 (failure).

- `-probe.page settings|chat`; `-probe.draft "<text>"` puts the draft into C1's composer (the Mac
  composer field is not reliably queryable, so nothing is typed).
- Stub modes (`GET /__mode/<m>`): off, unavailable, ok (answers after 9 s, Translation on, Chinese),
  fail (422 PROMPT_OPTIMIZATION_FAILED).
- CI: the probe branch's client.yml is the real one plus the `prompt_optimizer_probe` dispatch input
  and the `prompt-optimizer-shots` job; `gh workflow run client.yml --ref probe/<x> -f prompt_optimizer_probe=true`
  runs the unchanged macOS and iOS gates beside the shots. `gh run download <id> -n prompt-optimizer-shots`.
- Built from the handing-over-header kit (ProbeCase.swift, project.yml, run.sh).

- 2026-11-16 (task 34yIrQl86ZpHtOhDa7nsH, on by default): `test0SettingsUntouchedIsOn` alone, stub mode
  `untouched` (no promptOptimizer key, key present); shots `<p>-1-settings-untouched-on` and `<p>-1-settings-turned-off`.
