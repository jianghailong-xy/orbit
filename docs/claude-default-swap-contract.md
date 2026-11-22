# Claude Code login swap: the contract for "Set as default"

Project: *Set as default for Claude accounts*. This document fixes what one Claude Code login is
made of on each platform, how a runner swaps two of them and puts them back, how it proves the
result, and what the server and the runner say to each other while it happens. The server task
(*Set as default endpoint, state, and records that follow their account*) and the runner task
(*claude-account-swap/v1*) build on it.

Measured on Claude Code **2.1.326**, the build the runner's sessions run
(`/root/.local/share/claude/versions/2.1.326` on orbit-develop), on 2026-11-17.

## 1. What a login is

A Claude Code account folder ("slot") is a `CLAUDE_CONFIG_DIR`. Default is `~/.claude`, used with
`CLAUDE_CONFIG_DIR` **unset**. An added account is `~/.orbit/claude-accounts/<id>`
(`claude_account_slot.go`). Exactly two pieces of state say *which account* a folder is signed in to:

| Piece | Linux | macOS |
|---|---|---|
| **Credentials**: the `claudeAiOauth` object (`accessToken`, `refreshToken`, `expiresAt`, `refreshTokenExpiresAt`, `scopes`, `subscriptionType`, `subscriptionTypeSource`, `rateLimitTier`) | key `claudeAiOauth` of `<dir>/.credentials.json` (mode 0600) | key `claudeAiOauth` of the JSON password of the login-Keychain generic password with service `Claude Code-credentials` (Default) or `Claude Code-credentials-<sha256(dir)[:8]>` (added folder; `claudeKeychainService`), account attribute = `$USER`. No `.credentials.json` exists unless the Keychain was unusable. |
| **Identity**: the `oauthAccount` entry (`accountUuid`, `emailAddress`, `organizationUuid`, `organizationName`, `planDisplayName`, `billingType`, `seatTier`, `userRateLimitTier`, `organizationRateLimitTier`, `profileFetchedAt`, …) | Default: `$HOME/.claude.json`. Added: `<dir>/.claude.json`. | same |

Things that look account-related but are **not** swapped:

- **`mcpOAuth`** in the same credentials JSON (orbit-develop's `1e84046c` holds 7 entries): sign-ins
  to MCP servers, which belong to the folder, not to the Claude account. Swap only the
  `claudeAiOauth` key and leave every other key of that JSON where it is. Do not swap the whole file
  or the whole Keychain password.
- **`userID`**: a random per-install id (it differs between folders signed in to unrelated
  accounts and is not derived from either). Stays.
- **Caches keyed by account or org** carry their key and are ignored or refetched on a mismatch:
  `groveConfigCache` (by accountUuid), `passesEligibilityCache` (by org uuid),
  `clientDataCacheSlots`, `cachedUsageUtilization.accountUuid`, `cachedArtifactRoster.accountUuid`.
  Stay.
- **Unkeyed caches** (`cachedExtraUsageDisabledReason`, `passesLastSeenRemaining`,
  `claudeCodeFirstTokenDate`, `orgModelDefaultCache`, `cachedFeatureFlags*`,
  `cachedGrowthBook*`, `cachedExperiment*`) stay too. They are cosmetic, and the CLI refreshes
  them on its own schedule. The project's fixed decision applies: swap `oauthAccount` and nothing
  else in the user's `.claude.json`.
- **Transcripts, settings, plugins, skills, history** (`<dir>/projects`, `settings.json`, …)
  belong to the folder. Sessions follow their *account* to its new folder, and the runner's
  existing conversation carry (`carryClaudeConversation`, `claude-account-move/v1`) brings their
  conversation along. Default is in `claudeAccountKind.list()`, so a carry out of `~/.claude`
  works the same way.
- `~/.claude/.claude.json` (423 bytes, untouched since October on orbit-develop) is a leftover the
  CLI does not read when `CLAUDE_CONFIG_DIR` is unset. It reads `$HOME/.claude.json`. Leave it.
- An API-key login (`primaryApiKey`, `apiKeyHelper`, `ANTHROPIC_API_KEY`) is not an OAuth login and
  is not swappable. The runner refuses a swap unless both folders report
  `authMethod: "claude.ai"`.

**Pitfall: `claude auth status` reads only local state.** It reports `email`, `orgId`, `orgName`
and `planTier` from `oauthAccount` and `loginExpiresAt` from the credentials. It does not ask the
server whose token it holds: on Linux, two `auth status` runs and four atomic writes took 0.3 s in
total. If credentials and `oauthAccount` are swapped inconsistently, `auth status` will still
"verify" it. Verification therefore also asks the token's owner (§4).

## 2. Preconditions (the runner refuses or waits otherwise)

1. **No Claude Code process spans the swap**, on either folder. A running CLI keeps its tokens in
   memory and writes refreshed ones back to *its* folder. This includes the runner's own token
   refresher (`claudeRefreshing`), plan-usage reads that could start a refresh, and terminal
   `claude` processes the runner did not start (found by `CLAUDE_CONFIG_DIR` in the process
   environment; for Default, the variable is absent). The runner waits for in-flight turns to end
   and restarts idle engines afterwards (§5). It does not touch processes it does not own. Instead
   it reports them, and the swap waits (or fails at the deadline) while one runs.
2. **Neither access token is within 30 minutes of `expiresAt`.** The CLI refreshes from any command
   once `now + 5 min >= expiresAt` (`claudeCLIRefreshLead`). Keeping 30 minutes of margin means
   the verify step can never trigger a refresh. With less margin, the runner refreshes that folder
   first, through the CLI and before any backup, then re-reads it.
3. Both folders are signed in with `authMethod: "claude.ai"` and the two `oauthAccount.accountUuid`
   differ.

## 3. Swap and rollback

The swap moves the two logins: each credential exists in exactly one live place before, during and
after. It never makes a live copy of a credential, so a refresh can never run against a copy and
spend the original's refresh token.

1. **Back up** to a 0700 directory outside every config folder (e.g. `<runner state>/claude-swap/<attempt>/`):
   the two raw credential blobs (file bytes, or Keychain passwords) and the two `oauthAccount`
   values. The backup is read by the rollback only, never by a CLI. Delete it once the swap is
   verified or rolled back.
2. **Credentials.** Read both blobs and exchange their `claudeAiOauth` values (other keys stay).
   - Linux: write each `.credentials.json` with temp file + `rename` in the same directory, keeping mode 0600.
   - macOS: `security add-generic-password -U -a "<acct>" -s "<service>" -X "<hex of JSON>"`
     (Claude Code's hex encoding; `-U` updates the item in place and keeps its ACL). Prefer the
     argv form over `security -i` on stdin: interactive stdin is line-buffered around LINE_MAX
     (~2 KiB), and Default's blob with `mcpOAuth` is larger, so `-i` truncates the write and
     corrupts the item (measured 2026-11-18 on longdeMac-mini.local). ARG_MAX is large enough
     for the hex.
3. **Identity.** Read each `.claude.json` and exchange the two `oauthAccount` values, leaving every
   other key as read. Write with temp file + `rename`, keeping the mode.
4. **Verify** (§4). On success, delete the backup.

**Rollback**, whenever any step after 1 fails, or verification fails:

- If both folders' current `refreshToken` hashes are still the two backed-up ones (in either order,
  so no refresh happened), write the backup back: both credential blobs and both `oauthAccount`
  values. This works even when the failure struck between the two credential writes.
- If either hash is new, a refresh happened (a precondition was broken). Restoring would put a
  spent refresh token back. Rebuild by account instead: put each live `claudeAiOauth` in the
  folder whose backed-up `oauthAccount.accountUuid` owns it, determined with the token-owner check
  (§4). Then report `failed` with the reason.
- After a rollback, run the same verification against the backed-up identities and report
  `failed` with what failed and that both logins are as they were. If even that does not hold,
  keep the backup and name its path in the message.

Undoing a completed swap is the same operation run again on the same two folders: a second swap,
not a restore.

## 4. Verify

For each folder, with the folder's own environment (Default: `CLAUDE_CONFIG_DIR` unset; added:
`CLAUDE_CONFIG_DIR=<dir>`):

1. `claude auth status` exits 0 with `loggedIn: true`, `authMethod: "claude.ai"`, and `email` /
   `orgId` equal to the `oauthAccount` that was moved into that folder.
2. **Token owner:** `GET https://api.anthropic.com/api/oauth/profile` with
   `Authorization: Bearer <accessToken of that folder>` and `anthropic-beta: oauth-2025-04-20`.
   The response's `account.uuid` and `organization.uuid` must equal the folder's
   `oauthAccount.accountUuid` / `organizationUuid`. This call is read-only and never refreshes.
   The runner already sends its tokens to this host (`claude_region.go`, `planusage.go`).
3. Each folder's `refreshToken` hash equals the hash the *other* folder had before. Nothing
   rotated.

## 5. Server ↔ runner relay: `claude-account-swap/v1`

This reuses the account-removal relay (`accountRemoveRequest` / `POST /runner/account-remove-result`,
c7da4f818 / 96c35c3ed): a command delivered on every heartbeat until the runner reports, a pending
state with a deadline, and the waiting-for-turns machinery.

**Capability.** The runner lists `claude-account-swap/v1` in its capabilities. The server offers
Set as default only on a runner that declares it. It also requires `claude-account-move/v1`,
because sessions follow their account through a conversation carry.

**Command** (heartbeat response field `claudeAccountSwapRequest`, redelivered every heartbeat while
the swap is `pending`; carrying it out twice must equal carrying it out once):

```ts
interface ClaudeAccountSwapCommand {
  /** The added account to make the Default: its slot id under claude-accounts. */
  account: string;
  /** Identifies this swap (the server's request time, as for removal), echoed in every result. */
  attempt: string;
  /** accountUuid each folder holds when the server asked, as the runner last reported: lets the
   *  runner tell a redelivery of a swap it already finished (folders already exchanged → report
   *  done again) from a new request. */
  expect: { defaultAccountUuid: string; accountAccountUuid: string };
}
```

**Result** (`POST /runner/claude-account-swap-result`, the same body every time, latest wins):

```ts
interface ClaudeAccountSwapResult {
  account: string;
  attempt: string;
  status: 'pending' | 'done' | 'failed';
  /** failed: the machine's own one-line reason ("Rolled back: the Keychain refused the write — …").
   *  pending: omitted. done: omitted. */
  message?: string;
  /** pending: the sessions the swap is waiting on, i.e. Orbit sessions with a turn in progress on
   *  either folder. The server shows "waiting for N sessions to finish their turns" from this. */
  waitingOn?: string[];
  /** pending: Claude processes on either folder that are not Orbit sessions (a terminal `claude`),
   *  by pid and command name. The swap waits for them too and the page can say so. */
  foreignProcesses?: { pid: number; command: string }[];
  /** done: the accountUuid now in each folder, so the server can swap its per-account records
   *  (names, pause, workspace choices, session pins) to match; and the emailAddress now in the
   *  added folder — the former Default's — which names it there until the owner renames it. */
  now?: { defaultAccountUuid: string; accountAccountUuid: string; accountEmail?: string };
}
```

**Runner sequence for one command:**

1. **Quiet.** From now on, start no new engine process on either folder. Messages arriving for
   sessions on either account are held, not refused, and delivered after step 4. Each idle engine
   on either folder is stopped at once. A session with a turn in progress runs until the turn ends,
   and then its engine is stopped.
2. While any turn or foreign process remains, report `pending` with `waitingOn` /
   `foreignProcesses` on each heartbeat that delivers the command again. Do not hold the heartbeat
   goroutine. The wait runs off it, like the removal's.
3. **Swap** (§3) once nothing runs on either folder and the preconditions (§2) hold. Then
   **verify** (§4). Any failure rolls back (§3), and the result is `failed` with the reason.
4. **Release.** Each session's `CLAUDE_CONFIG_DIR` is now its account's new folder. The server
   moves the session pins, and the runner carries each conversation on its next spawn
   (`carryClaudeConversation`). Held messages are then delivered. Report `done` with `now`,
   re-probe the Claude engine and beat at once (as removal does), so the page shows the exchanged
   accounts without waiting for the next heartbeat.

**Server side:** the state is `pending` from the request until a `done` or `failed` result. The
deadline is the removal's: the 11-minute relay window while nothing is waited on, and 6 hours once
a result has named `waitingOn`. When the deadline passes, the result is `failed` with "Its sessions
did not finish their turns in time — try again." A `done` result is applied once (matched on
`account` + `attempt`), and in the same transaction the per-account records of the two accounts
swap. A result for an attempt that is not current is dropped.

**Names after a swap.** A name follows its account, but "Default" is the `default` slot's label, not a
name, and it never moves. A Default the owner never renamed lands in the added slot with no name.
The server keeps that slot marked as a former Default in `runner.account_names.formerDefault.claude`,
with `now.accountEmail`, or `""` where none was sent. It serves the slot's account with
`formerDefault: true` and `email`. Clients call it by the email, else "Former default"
(runnerAccountCopy `RUNNER_ACCOUNT_FORMER_DEFAULT`). The runner's own name for that slot belongs to
the account now in ~/.claude, so it is not shown. A name the owner gives it (Rename) wins and moves
with it. When the former Default is made the Default again, its mark stays behind, and the default
slot is called Default once more. This is the one place an account's email reaches the server. The
owner chose to name the former Default by it.

## 6. Evidence this contract rests on

- **Linux (orbit-develop), 2026-11-17:** a hand swap of Default (`~/.claude`, account `d2485e53…`)
  and the added folder `1e84046c` (account `327d66e0…`), run twice (Orbit bg jobs
  `bgj_aab6b3aff4ca` and `bgj_970efc38b04e`, the second with the token-owner check). Before the
  swap, `claude auth status` showed each folder's own account. After it, `~/.claude` reported
  `327d66e0`'s email/org and `1e84046c` reported `d2485e53`'s, and `/api/oauth/profile` confirmed
  each token's owner matched the folder's new `oauthAccount`. After the swap back, both reported
  their original accounts. Refresh-token and access-token hashes, `expiresAt` and `oauthAccount`
  were equal to before, so nothing rotated. The swapped window lasted 0.3 s and 1.0 s. `1e84046c`
  had one live `claude` process during the run. That was safe only because both tokens had about
  110 minutes left and the window was about a second. The runner must not rely on this (§2.1).
- **macOS: measured (longdeMac-mini.local), 2026-11-18, Claude Code 2.1.327.** Mixed layout —
  Default Keychain-backed, added folder file-backed — is the case this Mac had.

  **Storage rule (per folder; what the runner's `claudeKeychainCredentials` does).** A folder whose
  Keychain item (`claudeKeychainService(dir)`) exists keeps its login in that item. A folder without
  one keeps it in `<dir>/.credentials.json`. Claude Code reads its Keychain primary first and the
  file only as the fallback, so when a folder has both, the item is the login and the file is stale
  and is left untouched. The two folders are looked up separately, and any pair can occur:
  Keychain↔Keychain, Keychain↔file, file↔file. The swap moves `claudeAiOauth` between whatever the
  two are, and each folder keeps its own storage. An item is only ever updated (`-U`, under the
  account the item already has), never created or deleted, so no folder's storage changes. Backup,
  rollback and verify read and write through the same rule. A `security` lookup that fails other
  than "not found" (exit 44), or that blocks past 30 s, fails the swap. It is never taken to mean
  the folder uses the file. The script below checks for the file first instead. On the measured
  layout the two orders agree, because neither folder had both.

  **Storage layout**
  - Default (`~/.claude`, CLAUDE_CONFIG_DIR unset): login-Keychain generic password, service
    `Claude Code-credentials`, account `$USER`. Blob keys `claudeAiOauth` + `mcpOAuth`. No
    `~/.claude/.credentials.json`.
  - Added (`~/.orbit/claude-accounts/mac-swap-probe`): **file only** —
    `<dir>/.credentials.json` (mode 0600, key `claudeAiOauth` alone). Keychain service
    `Claude Code-credentials-9ec1515c` (`sha256(dir)[:8]`) is **absent**.

  **Why the added folder is file-based (not a broken half sign-in)**
  - Signed in from a terminal, not Orbit Add account: owner ran
    `CLAUDE_CONFIG_DIR=~/.orbit/claude-accounts/mac-swap-probe claude auth login` (and once more
    after `rm` of the file). Both folders answer `claude auth status` with `loggedIn: true` and
    `/api/oauth/profile` MATCH — usable logins.
  - Claude Code 2.1.327's macOS store is `keychain-with-plaintext-fallback`. When the Keychain
    primary write fails non-transiently it writes `.credentials.json` and records
    `plaintext_fallback_used` ("Warning: Storing credentials in plaintext."). That is what left
    the added folder on the file. Default's Keychain write succeeded in the same session
    (`Claude Code-credentials` created 2026-11-18T11:25:19Z).

  **Mixed-case procedure** (script [`claude-default-swap-mac.py`](claude-default-swap-mac.py)):
  detect file vs Keychain per folder; back up both credential blobs and
  both `oauthAccount` values; exchange only `claudeAiOauth` (leave `mcpOAuth`); exchange only
  `oauthAccount` in `$HOME/.claude.json` and `<dir>/.claude.json`; every `security` call under a
  30 s timeout; restore from backup on any failure; swap back and require identity equality.
  Keychain writes use argv `-X` (see §3) — not `security -i`.

  **Results** (Orbit bg job `bgj_5844845638d3`; first attempt `bgj_12e9af4813fc` with `-i` failed
  by truncating Default's Keychain item, then restored via argv `-X` with no dialog):
  - Before: Default `jianghailong.rd@gmail.com` / `327d66e0…`; added
    `jianghailong.orbit@gmail.com` / `5e7da146…`. Profile owner MATCH on both.
  - After swap: accounts exchanged; both still signed in; profile MATCH on both. Terminal
    `claude auth status` (CLAUDE_CONFIG_DIR unset) reported the former added account.
  - After swap-back: refresh/access hashes, `expiresAt` and `oauthAccount` equal to before
    (nothing rotated). Swapped window **1.3 s**.
  - **No Keychain dialog. No `security` call blocked.** Slowest `security` call **0.04 s**;
    all reads/writes exit 0 (except the intentional probe that the added Keychain item is
    absent, exit 44). This Cursor-session / runner-hosted process can read and `-U` update
    Default's Keychain item without a prompt.
