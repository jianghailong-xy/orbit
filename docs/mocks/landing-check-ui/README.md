# Landing check UI review

Open [board.html](board.html) for the complete review. PNG exports:

- [Settings and start cards](01-settings.png)
- [Confirmation and waiting readouts](02-confirmation-readouts.png)
- [Timeline and baseline open item](03-timeline.png)
- [English copy, file map and owner decisions](04-copy-rules.png)

This is a source-informed HTML reconstruction, not a screenshot of a running product. The checkout had no installed web dependencies or built application. Native layouts are illustrative; no simulator capture is claimed. All annotations are Chinese and product copy is English. Nothing under `src/` is changed.

References: main `fae9003a5f555c90ab54b7c86ab4f2f6ad5e52a8`, `docs/project-integration-line-contract.md` §11 (especially §11.3 and §11.6), and `docs/mocks/landing-two-tier/board.html`. The source map lists proposed implementation entry points, not a promise that each file must change. The integration proposal renderer and its payload plumbing must be traced during implementation, as called out under owner decisions.

Rendering: local Chromium 1243, 1440 CSS pixel viewport, device scale 1, full document PNG. All four exports were checked for horizontal overflow in cards, fields and table cells (zero). HTML uses local system fonts and has no external assets or network requirements.

Owner confirmation is still required. This submission does not authorize product implementation by itself.
