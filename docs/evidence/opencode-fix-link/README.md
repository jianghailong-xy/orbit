# An unavailable engine row's "fix" lands on the web Providers row

Evidence for the change in `ConsoleModel.webFixURL` (iOS/macOS): an engine row this machine can't
run opens the web Providers page for **that runner and that engine**
(`/providers?runner=<id>&engine=<slug>`) instead of falling back to the runner's own page — which
has no install for the login engines or for OpenCode.

Shot on the iPhone 17 Pro simulator (iOS 26.5), app built from this branch with default signing.
The workspace is `orbit-develop`, whose runner is `workstation-gpu` (named "HPC" in the web UI),
reporting `opencode: installed=false` — so the row is the "Not installed" one this task is about.

| File | What it shows |
| --- | --- |
| `ios-engine-sheet-not-installed.png` | The new-session Engine sheet: **OpenCode — Not installed →**, the row whose press had nowhere to go before this change. |
| `ios-tap-on-production-web.png` | Tapping that row with the app on `orbitd.io`: Safari opens the Providers page and the **HPC runner's card is expanded** for the link. Production's web build predates the OpenCode row (below), so this is where it stops there. |
| `ios-tap-lands-on-providers-row.png` | The same tap against *this branch's* web build: the runner's card open and the **OpenCode row focused** (highlighted, with its `Install` button). The server's access log for that press reads `GET /providers?runner=34P34HcKKoFRn2j9KitgJ&engine=opencode` — the exact path the app opened. |

## Why the web is served locally in the last shot

The web half of this project (`ROW_ENGINES` gaining OpenCode, and `?engine=` focusing it) ships on
the project branch and is **not on `main` yet** — the bundle `orbitd.io` serves has no
`opencode auth login` copy, and no runner's card draws the row. To watch the whole press rather
than half of it, that shot serves *this branch's* web build (`npm run build -w @orbit/web`) on
`http://localhost:4173` with `/api` proxied to `orbitd.io`, and the app's instance was pointed at
it for the check (then restored to `orbitd.io`). The link the app builds is identical apart from
the origin — the same `webFixURL`, the same `?runner=&engine=` query.
