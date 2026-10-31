# A failed Codex model-catalog refresh is one grey row (task 34o8eWky47dEEFpLGc5W3)

Codex logs `<stamp> ERROR codex_models_manager::manager: failed to refresh available models: <err>` and
keeps the catalog it already had, whatever the cause. It retries on every later model request, so one
session repeats the line: `request timed out` ×10 in the 2026-10-28 iOS report, `timeout waiting for
child process to exit` ×3 on the web on 2026-08-12. Every such line is now one quiet row with its
count, on the web, iOS, macOS and Android, whether a current runner sent it with its diagnostic or an
older runner stored it without one. Any other stderr line stays a red error row.

## The row on each client

| Client | Mark | Label | The engine's words | Count | A `notice` event |
| --- | --- | --- | --- | --- | --- |
| Web `.chat-notice.chat-diagnostic` | ⚠ `--warning` | `--text-3` | `--text-2` | `--warning` at 70 % | the whole line `--warning` |
| iOS / macOS `DiagnosticNoticeRow` | orange | `.tertiary` | `.secondary` | orange at 70 % | the whole line orange |
| Android `DiagnosticLine` | `needsYou` | `outline` | `onSurfaceVariant` | `needsYou` at 70 % | the whole line `needsYou` |

The words are the logged line without its stamp, level and module (web's `parseEngineLogLine`). The
whole line is the web's tooltip, the Mac's help text, and what Android's "Copy message" copies.

## Pictures

- `android/diagnostic-row-{light,dark}.png`: Robolectric (`DiagnosticRowsTest`, `DiagnosticRowsDarkTest`),
  the production session page over `ComposerShell` at 411 dp, xxhdpi. The same test reads the drawn
  pixels inside each row: the words are `onSurfaceVariant` and never `needsYou`, the label is
  `outline`, the row holds the `needsYou` mark, the notice's words are `needsYou` and never grey, and the
  ERROR line is `error`.
- `orbitkit/ios/ios-diagnostic-row-{light,dark}.png` and `orbitkit/mac/mac-diagnostic-row-{light,dark}.png`:
  the probe in `orbitkit/probe-harness` on CI run 40826151243 (an iPhone simulator on `macos-26`, and
  the Mac app's own window), conversation D1 of its stub. `DiagnosticRowShotTests` asserted the label,
  the words, the ×10, the notice and the ERROR line before each picture (`orbitkit/*/notes.txt`). The
  "Landed without your confirmation" bar on the iPhone belongs to the stub's other projects (R29-11's).

## Tests

| What | Runner | Web | OrbitKit | Android |
| --- | --- | --- | --- | --- |
| A new runner's event becomes the diagnostic | `TestCodexStderrDiagnosticClassifiesRecoverableLines`, `TestCodexForwardsACatalogRefreshFailureAsADiagnosticOnBothPaths` | `renders a failed model-catalog refresh from a current runner as a notice` | `testCatalogRefreshFailureFromACurrentRunnerBecomesADiagnosticRow` | `catalogRefreshFailureFromACurrentRunnerBecomesADiagnosticRow` |
| An event stored without one | n/a | `recognizes a failed model-catalog refresh in an older persisted stderr event` | `testPersistedCatalogRefreshFailureBecomesADiagnosticRow` | `persistedCatalogRefreshFailureBecomesADiagnosticRow` |
| The same line ×10 is one row ×10 | n/a | `folds every repeat of a failed refresh into one notice row with a count` | `testRepeatedCatalogRefreshFailureFoldsIntoOneDiagnosticRow` | `repeatedCatalogRefreshFailureFoldsIntoOneDiagnosticRow` |
| An unrelated ERROR stays red | `TestCodexStderrDiagnosticLeavesUnknownAndFatalLinesUnclassified` | `keeps an unrelated ERROR line red` | `testUnrelatedErrorStderrStaysAnErrorRow` | `unrelatedErrorStderrStaysAnErrorRow` |
| A notice and a diagnostic are two kinds | n/a | (existing `NoticeNode` / `DiagnosticNode`) | `testANoticeAndADiagnosticAreRowsOfTwoKinds` | `aNoticeAndADiagnosticAreRowsOfTwoKinds` |
| How it is drawn | n/a | `.chat-notice.chat-diagnostic` (index.css) | `DiagnosticRowWiringTests` (ConsoleView read as source) | `DiagnosticRowsTest`, `DiagnosticRowsDarkTest` (pixels) |
| Snapshots | n/a | n/a | `testNoticeAndDiagnosticRowsSurviveTheSnapshot`, `testFileStoreDiscardsPreviousSchemaVersion` (schema 8) | n/a |

## Runs

- runner-go `go test ./...`, web Transcript suites and full vitest: revision 1, on 663c95e05.
  `src/runner-go` and `src/web` have not changed since.
- OrbitKit `swift test` (swift:6.1 docker) and Android `gradle test` (core, app debug and release):
  on 2f8809f1a.
- CI run 40826151243 on the probe commit be53d64a6 (2f8809f1a + this kit), i.e. client.yml's own gates:
  macOS OrbitKit test and OrbitApp build, iOS build, font tokens, navigation, OrbitKit on main
  3f25246f6 as a baseline, and the shots. All green, on Xcode 26.3 / Swift 6.2.4. Results branch:
  `probe/codex-catalog-refresh-notice-results`.
- Android CI (`android.yml`: test, lint, debug APK) on the same probe commit: run 40826151275.
