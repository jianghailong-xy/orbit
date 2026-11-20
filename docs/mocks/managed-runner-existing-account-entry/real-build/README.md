# Real-build shots: managed runner entry on web (board 2)

Captured from a production build (`npm run build`, served by `npm run preview`) with the UI-migration
fixtures answering every API call and the managed-runner routes answered from
`src/shared/src/managed-runner-states.fixture.json`. Script: `src/web/ui-migration/managed-runner-entry.capture.mjs`.

| Shot | What it shows | Beside the board |
| --- | --- | --- |
| `1-entry.png` | Settings → Machines: "Managed runner · Set up" first, its page with the notice and the sentence | `1-entry-beside-board.png` |
| `2-confirmation.png` | Set up on an account with machines asks first (D3) | `2-confirmation-beside-board.png` |
| `3-after-setup.png` | REQUESTED replaced the route with the runner's machine page; its row and pill say Preparing, its notice on top, and Resources and Engines say only "Available once the runner is ready." until it reports | `3-after-setup-beside-board.png` |
| `5-once-ready.png` | The same runner once it reports (READY, with a version): Ready on its row and pill, the ordinary machine page | `5-once-ready-beside-board.png` |
| `4-asleep-sidebar-composer.png` | A sleeping managed runner: the sidebar's mark and tooltip say Asleep, the composer has the shared line, sending stays open | — |
