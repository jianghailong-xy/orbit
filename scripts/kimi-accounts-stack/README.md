# Kimi Code accounts: local stack and fake kimi

The integration check for Kimi Code accounts (project 34cLiNWD4Qj0nQOpG4uZG, task 34cM1TaZiO8CtZCSGxdDp). It runs
the runner, the control plane and the web together on one machine, against a fake `kimi` CLI and a fake Kimi
server. Nothing reaches a real Kimi site or a model. Everything listens on 127.0.0.1.

```sh
bash scripts/worktree-overlay.sh                     # once per checkout: node_modules, Prisma client, shared dist
bash scripts/kimi-accounts-stack/run-all.sh          # build, fresh stack, seed, scenarios 1–6
```

`run-all.sh` prints one `SCENARIO n PASS|FAIL` line per scenario. Each scenario writes its log and screenshots to
`$KIMI_STACK_DIR/shots/<n>-…/` (default `/var/tmp/kimi-accounts-stack`). `stack.sh status`, `stack.sh down` and
`stack.sh clean` look after the stack; `clean` removes the postgres container.

Two helpers:

- `collect.sh <dest>` copies a run's logs (as `.txt`, since `*.log` is gitignored) and screenshots out with `SHA256SUMS`, and never the files that hold credentials.
- `node peek.mjs <api path> [field.path]` prints an API answer as the stack's owner.

Needs docker, Go, and node at `/usr/local/bin/node`. That is the fake `kimi`'s interpreter: the runners' `PATH` leaves
`/usr/local/bin` out, so the host's own engines stay out of reach. Playwright's Chromium comes from this checkout's
`node_modules`. Set `KIMI_STACK_FONTCONFIG` to a fontconfig file to fix the screenshots' fonts.

## What runs

| Part | What it is |
|---|---|
| postgres | `postgres:16-alpine` on tmpfs, 127.0.0.1:5741, migrated with this checkout's `prisma migrate deploy` |
| apiserver | this checkout's `src/apiserver/dist/main.js` on 127.0.0.1:3741, started under `env -i` |
| web | vite dev of this checkout's `src/web` on 127.0.0.1:4741 (`serve-web.mjs`; `/api` is proxied to the apiserver) |
| old client | vite dev of main's `src/web` at 721e48275 on 127.0.0.1:4742. That is main just before this project's web landed (b8bc76d1f). |
| runner `hpc-kimi` | this checkout's `src/runner-go`. Its Default Kimi account is signed in on kimi.ai. |
| runner `old-kimi` | the same source with `kimi-account-login/v1`, `kimi-account-remove/v1` and `kimi-account-move/v1` removed from its capability list (`logs/runner-nocap.diff`). Its Default is signed in on kimi.com. |
| fake Kimi server | `fake-kimi-server.mjs` on 127.0.0.1:18741 |
| fake `kimi` | `fake-kimi.mjs`, installed as `kimi` on the runners' PATH |

Each runner runs in a private mount namespace:

- an empty tmpfs over `/root`, so it finds no real engine and no real `~/.kimi-code`;
- its own `HOME`, `ORBIT_HOME`, `TMPDIR` and `PATH`;
- an `/etc/hosts` that sends `auth.`/`api.`/`www.kimi.com` and `auth.`/`api.`/`www.kimi.ai` to 127.0.0.1.

The fake logins therefore name `http://api.kimi.com:18741/coding/v1` and `http://auth.kimi.ai:18741`. The runner
reads the site from those hosts, as it does for a real login, and its quota reads and token refreshes reach the fake
server and nothing else.

## The fake `kimi` (Kimi Code 2.1.x)

It keeps everything in the `KIMI_CODE_HOME` it runs in, the way 2.1.x lays it out. Every call is appended to
`logs/fake-kimi-<runner>.jsonl` with its argv, its `KIMI_CODE_HOME` and where that home's `sessions/` leads.

- **`--version`** prints `2.1.1`.
- **`login --help`** mentions `--region`.
- **`login [--region mainland-cn|global]`** runs the RFC 8628 device flow against the fake server:
  - It writes `device_id`, then prints `Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=XXXX-XXXX` and `…enter code: XXXX-XXXX` on stderr.
  - Once the code is approved, it writes `config.toml`, with `[providers."managed:kimi-code"]` and the four model aliases a real kimi.com login lists, and `credentials/<storage>.json`. `<storage>` is the name the CLI derives from the site and the API, as `kimiTokenStorageName` in `src/runner-go/kimi_usage.go` does.
- **`provider list --json`** prints `config.providers` and the models. An empty home gives `{"providers": {}, "models": {}}`, after the template `config.toml` and `device_id` the real CLI writes.
- **`acp`** speaks JSON-RPC on stdio:
  - `initialize`.
  - `authenticate`: `-32000` when no token is stored.
  - `session/new` and `session/resume`. It keeps `sessions/<wd_slug_hash12>/<id>/{state.json,agents/main/wire.jsonl}`, `session_index.jsonl`, `workspaces.json` and `sessions/.index-dirty`. Resume finds the session by id among the buckets.
  - `session/set_config_option`: an unknown model alias is refused, as Kimi's `setModel` refuses it.
  - `session/prompt` and `session/cancel`.
  - A reply names the account that answered, meaning the home its `sessions/` leads to, and lists every earlier turn it can read there. That is how a carried conversation shows.
  - A prompt that contains `FAKE_KIMI_SLOW <n>` holds the turn for n seconds.
  - A turn on an account whose quota is used up ends `failed` with `APIProviderQuotaExhaustedError` in the wire, the way Kimi records a 429. `FAKE_KIMI_QUOTA_EXHAUSTED` forces this. The prompt is still answered `end_turn`.
  - Orbit's `<orbit-agent-instructions>` block is left out of what the reply quotes.

The fake server keeps one quota per Kimi user and answers `GET …/coding/v1/usages` for that user's token.
`POST /api/oauth/token` handles the device-code grant and refresh-token rotation. Its admin API is what the user's
browser and Kimi's billing would do:

- `POST /__admin/approve {userCode, user[, ttl]}`
- `POST /__admin/usage {user, limit_5h, limit_7d, limit_month_total, limit_month_code}` (used ratios)
- `GET /__admin/state` (token values only as hashes)

Every request is logged to `logs/fake-kimi-requests.jsonl`, with tokens hashed.

## Scenarios

1. **Add a kimi.com account from the Providers page** (`scenario1.mjs`)
   - Steps: Add account → name → kimi.com → device code → approved as work@kimi.com.
   - Checks: the new account is signed in on kimi.com in `<ORBIT_HOME>/kimi-accounts/<id>`, and `kimi login` ran only there. Default is still kimi.ai, and its home is byte-identical (`homehash.sh`).
2. **The workspace picks the account** (`scenario2.mjs`): the workspace form's Kimi account is set to Work, then a new Kimi session is started from the web.
   - The runner records `KIMI_CODE_HOME` = Work's directory.
   - The fake ran in an overlay whose `sessions/` is Work's.
   - The conversation is in Work's home and not Default's.
3. **A session that has talked switches to Default and goes on** (`scenario3.mjs`): the composer's Provider menu is set to Default.
   - The runner logs the conversation carried from Work to Default.
   - Kimi resumes the same session id with its two turns.
   - The reply on Default lists them.
4. **Quota per account; NEXT and Automatic follow it** (`scenario4.mjs`)
   - Round 1: Default's 5-hour window is at 85%, so NEXT and a new Automatic session go to Work.
   - Round 2: Work's 5-hour window is at 90%, so they go to Default.
   - Round 3: a session Automatic put on Work hits Work's limit mid-conversation. It moves to Default and the message is sent again there, with the earlier turn.
   - Default's four-minute token has expired by this point. The check is that the runner refreshed it on Default's own site and read Default's quota with the new token.
5. **Remove an account** (`scenario5.mjs`)
   - With a turn running on Work, Remove is refused by the runner and the page shows why.
   - With the turn over but the session still open, Remove is still refused. A session counts as using its account until it ends, not only while a turn runs: the runner keeps supervising it, warm or cold (`src/runner-go/session_pool.go`).
   - After every open session is completed (the web's Complete, `POST /sessions/:id/complete`), Remove takes Work's directory and record, and Default stays untouched.
6. **Compatibility** (`scenario6.mjs`)
   - (a) `old-kimi` shows no Add account. A named Kimi sign-in, a removal and an account switch sent to it are refused with the upgrade message. No `kimi login` runs there.
   - (b) The old client renders the Providers page, a Kimi session and the runner page on the same data with no page error.

The quota of an idle account is read every 10 minutes (`planUsageIdleInterval`), and only once a workspace on that
runner has run Kimi. Scenario 4 therefore restarts `hpc-kimi` after changing quotas, so the change is read at once.
