# Kimi Code accounts: integration run

This is the evidence for task 34cM1TaZiO8CtZCSGxdDp, the integration and compatibility check of project
34cLiNWD4Qj0nQOpG4uZG.

**Result: all six scenarios pass.** The run was one clean pass of `bash scripts/kimi-accounts-stack/run-all.sh` on
2026-10-08, between 17:12 and 17:21 UTC (Orbit job `bgj_3eedab37faf0`, exit 0). It built everything from the
project line at 6c10d1ed9, plus this harness, and started from nothing:

- a new database;
- new runners, each with its own `ORBIT_HOME`, `HOME` and Default `~/.kimi-code`;
- a new fake Kimi server.

`logs/run-all.out` is the summary. Each `<n>-…/scenario<n>.txt` lists that scenario's API calls, the web's own
requests, what the runner and the fake `kimi` recorded, and its PASS/FAIL checks. `SHA256SUMS` covers every file.
The harness, the stack and the fake `kimi` are described in `scripts/kimi-accounts-stack/README.md`.

What ran:

- postgres 16 (tmpfs);
- the apiserver;
- two runners built from `src/runner-go`:
  - `hpc-kimi`, as is;
  - `old-kimi`, with `kimi-account-login/v1`, `kimi-account-remove/v1` and `kimi-account-move/v1` removed from its capability list — `logs/runner-nocap.diff` is the whole change;
- vite dev of `src/web`;
- vite dev of the old client: main's `src/web` at 721e48275, which is main just before this project's web landed in b8bc76d1f;
- the fake `kimi` (Kimi Code 2.1.x) and the fake Kimi server.

Each runner runs in a private mount namespace: `/root` is hidden, and the Kimi hosts resolve to 127.0.0.1. No real
Kimi site, model or credential was involved.

## 1. Add a kimi.com account on the Providers page; Default unchanged — PASS

`1-add-account/`: `1a-before`, `1b-name-and-site`, `1c-device-code`, `1d-added`.

- **The web's sign-in request.** After Add account → name "Work" → kimi.com, the web sent `POST /api/runners/<hpc-kimi>/login {"engine":"kimi","accountName":"Work","region":"mainland-cn"}`.
- **The device code.** The runner made slot `a70fa033` and ran `kimi login --region mainland-cn` with `KIMI_CODE_HOME` set to that slot. The device code reached the page 3 s after the press: `42MQ-6MWC`, `https://www.kimi.com/code/authorize_device?…`, "Sign in with the **kimi.com** account you are adding". The fake server approved it as work@kimi.com.
- **The new account.** The runner reports `{id: a70fa033, name: Work, home: <ORBIT_HOME>/kimi-accounts/a70fa033, auth: yes, kimiRegion: mainland-cn}`. The page shows Default (kimi.ai, NEXT) and Work (kimi.com).
- **Where `kimi login` ran.** It ran only in the new slot (`logs/fake-kimi-hpc-kimi.jsonl`).
- **Default.** Its home was byte-identical before and after (`homehash.sh` digest `dedd7517b70952a2` both times), and it is still signed in on kimi.ai.

## 2. The workspace picks the account; a new session's KIMI_CODE_HOME is it — PASS

`2-workspace-account/`: `2a` (the field's options), `2b` (Work picked), `2c`/`2d` (a new Kimi session and its reply).

- **The workspace.** The workspace form's Kimi account was set to Work and saved as `PATCH /api/workspaces/<id> {…"kimiAccount":"a70fa033"}`.
- **The new session.** It was started from the web with the Kimi engine. The runner's record (`runs/<uuid>/meta.json`) has `kimiCodeHome = …/kimi-accounts/a70fa033`.
- **Where kimi ran.** `kimi acp` ran in the session's private overlay, whose `sessions/` links to Work's directory.
- **The reply.** It says `account a70fa033 — KIMI_CODE_HOME …/runs/<uuid>/kimi-home → sessions in …/kimi-accounts/a70fa033`.
- **Where the conversation is.** It is in Work's `sessions/wd_work_…/session_629d05ad…`, and not in Default's.

## 3. A session that has talked moves to Default and goes on — PASS

`3-switch-to-default/`: `3a` (two turns on Work), `3b` (the composer's Provider menu: Kimi / Default / Work ✓), `3c` (the turn on Default).

- **The switch.** The web sent `PATCH /api/sessions/<id>/account {"account":"default"}`. The session reads `kimiAccount: default, kimiAccountPinned: true`.
- **The runner.** It logs `kimi conversation for session_629d05ad… carried from account a70fa033 (…) to default (…)`.
- **The resume.** Kimi resumed the same session id in Default's home and found both turns (`acp.session.resume … turnsFound: 2`).
- **The reply on Default.** It lists both turns said on Work, and the page marks "Switched to Default".
- **The copies.** Default's home now holds the conversation, with its `session_index.jsonl` line. Work keeps its own copy.

## 4. Each account's quota; NEXT and Automatic follow it — PASS

`4-quota-next/`. Quotas are set per Kimi user on the fake server and read by the runner from each account's own
login, so Default is read via `api.kimi.ai` and Work via `api.kimi.com`. The runner reports Default's windows as
`planUsage.kimi`'s own and Work's under `planUsage.kimi.accounts.a70fa033`. Each row draws its own 5h, weekly and
monthly bars.

- **Round 1** (`4a1`–`4a5`):
  - Default's 5-hour window is at 85% and Work's at 20%, so NEXT is on Work. The folded head says "Next: Work · 5h limit 20%".
  - The workspace was set to Automatic, and a new session started on Work (`kimiAccount: a70fa033, pinned: false`) and ran in Work's `KIMI_CODE_HOME`.
  - The composer's quota popover names Work.
- **Round 2** (`4b1`–`4b5`): Default's 5-hour window is at 10% and Work's at 90%, so NEXT moved to Default, and a new Automatic session started on Default.
- **Round 3, Automatic at the limit** (`4c1`, `4c2`):
  1. A session that Automatic put on Work had answered once. Then work@kimi.com ran out.
  2. Work's next turn ended `failed` with `APIProviderQuotaExhaustedError`, and the runner reported the usage limit. The page shows "Usage limit reached — Retrying".
  3. The control plane moved the session to Default, still on Automatic.
  4. The runner carried the conversation from Work to Default, and the re-sent message was answered there with the earlier turns. The page shows "Switched to Default — the usage limit on Work is reached".
- **Token refresh.** Default's first token lived four minutes. Once it had expired, the runner refreshed it on Default's own site, `POST auth.kimi.ai:18741/api/oauth/token grant=refresh_token`, under Kimi's lock. It then read Default's quota with the new token. The fake `kimi`'s own quota check afterwards used that same refreshed token from the account's credentials file.

## 5. Removing an account: refused while it is used, done once it is not — PASS

`5-remove-account/`.

- **While a turn runs** (`5a`, `5b1`, `5b2`): a session on Work had a turn in flight. Remove, then confirm, sends `DELETE /api/runners/<id>/accounts/kimi/a70fa033`.
  - The runner refused: `kimi account a70fa033 is in use by a session running on this machine — end that session, then remove it`.
  - The page shows that under the Work row, with "…/kimi-accounts/a70fa033 on hpc-kimi is untouched".
  - Work stays Available, and its directory stays.
- **Turn over, session still open** (`5c1`, `5c2`): refused again, with the same reason. The runner supervises an open session (warm, then cold) until the session ends, and counts it as using its account.
- **Every open session completed** (`5d1`, `5d2`): the open sessions were completed with the web's Complete, `POST /sessions/:id/complete`, and their runs ended in the runner's log.
  - Remove then went through (`status: done`).
  - Work left the runner's report, and its directory and record are gone.
  - Default's home is unchanged.

## 6. Compatibility — PASS

`6-compat/`.

**(a) A runner without the kimi-account capabilities.** Its only Kimi capability is `kimi-login-region/v1`.

- **No Add account.** Its Kimi row has no Add account (`6a1`); hpc-kimi's row on the same page does.
- **Named sign-in.** A named Kimi sign-in sent to it anyway was accepted as pending and refused at the runner's next beat: "This runner is too old to sign in another Kimi account — update it, then try again." No `kimi login` ran on that machine, no slot was made, and its Default home is unchanged.
- **Removal.** `DELETE …/accounts/kimi/<id>` returns 400: "This runner is too old to remove a Kimi account — update it, then try again."
- **Account switch.** The runner was given a second Kimi account, as if it had been added before a downgrade. Switching a Kimi session on it to that account returns 409: "this session's runner cannot move a conversation to another account yet — it updates itself when no turn is running".
- **Composer.** The composer offers that session no account rows (`6a2`).

**(b) The old client** (721e48275) on the same server and data, with two Kimi accounts and quota on hpc-kimi.

- It renders the Providers page (`6b1`), a Kimi session that moved accounts (`6b2`) and the runner page (`6b3`).
- There are no page errors.
- It draws the Kimi accounts as it already drew accounts: the "5-hour limit" and "Weekly · all models" bars, no monthly bar, no site in the meta, and NEXT.

## What this does not establish, and what was seen on the way

- **The fake.** The fake `kimi` is not Kimi Code. It follows the file layout and wire records documented in the runner's tests, and the 2.1.1 bundle installed on HPC:
  - the session store;
  - `turn.ended` with `APIProviderQuotaExhaustedError`;
  - the credentials and `config.toml` shapes;
  - an append-only `session_index.jsonl`, and `workspaces.json` replaced by write-and-rename.

  Real device approval, real model calls and real quota numbers are left to the owner's HPC check.
- **Model list.** The runner reads one Kimi model list for all accounts: Default's when Default is signed in, else the first signed-in account's. Sessions on any account are then told `set_config_option model=<alias>`, and Kimi's `setModel` throws for an alias that account's login did not bring.
  - The real kimi.com login on HPC lists four aliases (kimi-for-coding, -highspeed, k3, k3-256k). The fake gives both sites the same four, so nothing here exercises a mismatch.
  - If accounts can carry different aliases (another site, or a plan), a session on such an account would fail at "configure".
- **Overlay.** Kimi appends its session index through the overlay's link only when the account's home already has `session_index.jsonl`, and it rewrites `workspaces.json` by rename. Either way, lines written from a session overlay stay in the overlay and go with it. Those lines name the overlay's path, which Kimi itself passes over. Resume by id is unaffected (scenario 3), but Kimi's own pickers in an added account's home don't list Orbit sessions.
- **Removal semantics.** "In use" means any session the runner currently supervises. An open idle session therefore blocks removal until it is completed.
  - Right after a runner restart, open sessions it has not picked up again do not count.
  - A session ended while unsupervised is claimed for a moment just to be ended. A removal in that moment is refused.
  - The refusal names the slot id ("kimi account a70fa033"), not the account's name.
- **Old client limits.** These come from reading its code; 6b only checks that it renders. Its composer shows a Kimi session on another account as on Default, and it cannot move one. Its Add account for Kimi starts with no site choice.
- **Not Kimi.** Every `304` that `GET /api/sessions` answers is logged as an ERROR with `ERR_HTTP_HEADERS_SENT`. The handler ends the response itself, and Nest then still calls `send()`. This is on main since 5b132c135.
- **No product code changed.** No seam needed a code change in runner, apiserver, shared or web. The scripts in `scripts/kimi-accounts-stack/` are new and were fixed while they were built.
