# Cursor CLI model variants on the web: Context and Speed, beside the owner's board

This is the evidence for task 34iDjteT5qGcwXKjAUKj1, the Context/Speed follow-up of P7a, in project 34gyHIZv301nDWxKP9XkO. P7a's model menu had Effort alone. Its README's "No Context or Speed row" said why: the runner set only a session's model and effort, and a session had no field for the other two.

The board is `docs/mocks/cursor-engine/` (T0, af84e78dc), Web 5 ①. The coordinator ruled that Speed stays: `fast` is a setting of a Cursor model. It is not the engine-level fast mode that P1 does not declare.

## How a session names the two

The session has no field for either, so both go in its model value, written the way Cursor writes a variant: `claude-opus-5-5[context=1m,fast=true]`. The effort stays in `effort`. Auto is the bare `default`.

- A setting at the model's own default is left out, so a model on every default is its bare name.
- The runner sets each context and fast lane the model lists: the one the value names, else the model's default from the runner's catalogue. The CLI keeps its last selection in its config (contract §3.1), so a process can start on settings another session chose.
- shared's `encodeCursorModel` and `decodeCursorModel` (`src/shared/src/cursorModels.ts`) write and read the value. The runner's `decodeCursorModel` (`src/runner-go/cursor_models.go`) reads it the same way.
- The contract states the convention in §10 ("会话里怎么写 context 和 fast"). iOS (P7b) and Android (P7c) follow it.

## Result

The two Web 5 ① frames were taken again from the real page, light and dark, and set beside the board's frames of the same names.

| Scene | Board vs capture (raw PNGs, pixels whose channels differ by more than 32) |
| --- | --- |
| `w5-model-variant` light | 0 |
| `w5-model-variant` dark | 0 |
| `w5-model-menu` light | 681 (0.06%), all inside the Auto chip |
| `w5-model-menu` dark | 656 (0.05%), all inside the Auto chip |

- **`w5-model-variant`** matches the board frame for frame. Under the models, Effort "High", Context "1M" and Speed "Fast" each open a level down, and the chip reads "Claude Opus 5.5 High · 1M · Fast".
- **`w5-model-menu`**: Auto's note reads the board's words again: "Auto picks a model for each request. Cursor doesn’t report which one it used, and Auto has no effort or context to set."
  - The one difference is the Auto chip's width. The board's prototype kept an empty effort span on Auto, about 5 CSS px wide. The page draws no span there.
  - This is unchanged from P7a: its capture of the same scene has the same chip.

## Files

- `compare-web-5-session-<theme>.png`: the board's frame on the left, the capture on the right, at the same scale.
- `shots/<scene>-<theme>.png`: the four captures, in 256 colours, as P7a keeps its own.
- `capture/`: P7a's kit (`docs/evidence/cursor-engine/p7a/capture/`), copied with three changes:
  - its paths name this task's worktree and `/mnt/data/tmp/p7a-variants-shots`;
  - `data.mjs` gives Opus 5.5's settings the labels the pinned CLI lists and the runner reports (`300K`/`1M`, `Off`/`Fast`, `Extra High`), where P7a's copy labelled each value with itself;
  - `scene-list.mjs` puts `w5-model-variant`'s session on `claude-opus-5-5[context=1m,fast=true]` with effort `high`, hovers Context, and marks Effort, Context, Speed and the chip, as the board's own kit does.
- `retired-pin-probe.cjs`: the server-side check below.

**Taken again from the final tree.** After the project line was merged in and the convention settled on leaving defaults out, the kit ran again: all four frames came out byte-identical to these.

To take them again:

1. Copy `capture/` to `/mnt/data/tmp/p7a-variants-shots/`.
2. `unshare -n /mnt/data/tmp/p7a-variants-shots/run-ns.sh scenes.mjs w5-model-menu w5-model-variant`. It runs vite and Chromium in a private network namespace, with the board's fonts.
3. `python3 -I capture/compare.py docs/mocks/cursor-engine/shots /mnt/data/tmp/p7a-variants-shots/shots <out>`.
4. `python3 -I capture/quantize.py /mnt/data/tmp/p7a-variants-shots/shots <out>/shots`.

## The server kept nothing of the variant before this change

Dispatch drops a model the runner's catalogue no longer lists (`retiredPin`, `src/apiserver/src/providers/custom-provider.ts`). The parameterized picker lists bare names, so before this change every bracketed value was judged retired and replaced by Auto. That held on the config PATCH, which stores `exec.model`, at claim, and on the `cursor-api` key preset.

`retired-pin-probe.cjs` asks `resolveProviderExec` for a Cursor session on such a catalogue. It ran on two builds:

- **Before**, on the project tip this branch started from: 1ad059009, built in a scratch worktree against its own `src/shared`.

  ```
  "claude-opus-5-5" -> "claude-opus-5-5"
  "claude-opus-5-5[context=1m,fast=true]" -> "default" (retiredPin)
  ```
- **After**, on this branch:

  ```
  "claude-opus-5-5" -> "claude-opus-5-5"
  "claude-opus-5-5[context=1m,fast=true]" -> "claude-opus-5-5[context=1m,fast=true]"
  ```

The coordinator approved extending the task to these server paths, which are now among its declared paths:

- `retiredPin` judges a Cursor variant by its model, as it already judged an Antigravity slug by its base model.
- `runtimeCatalogReasoningLevels` (`src/apiserver/src/common/runtime-model.ts`) reads the effort levels off that model's row.
- A value the catalogue lists as it stands is still read as it stands.
- The cases are in `src/apiserver/src/common/cursor-model-variants.spec.ts`.

## No real Cursor CLI

Everything here ran on fixtures and recordings. The runner's tests replay P0's `parameterized-model-picker` recording (`src/runner-go/cursor_model_variants_test.go`). No real Cursor account, key or prompt was used: 0 real prompts.
