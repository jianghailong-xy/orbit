# Owner request secrets: delivering an owner-entered credential to one runner

> Status: draft for the owner's security review (task "Design: delivering owner-entered secrets to a runner", project
> "Owner requests"). Nothing here is built; the implementation task waits for this approval.
> Code baseline: main `d21a46bff`. Line numbers refer to that commit.
> Mockup: `owner-action-mockup.png`, panels 1, 2 and 4.

## 0. Summary

**Recommendation.** A new write-only, per-request secret record on the apiserver, encrypted with the same AES-256-GCM
scheme as provider keys but not stored in the provider table. The named runner pulls it after the owner submits it.
The runner keeps an env-var secret in memory only and hands it to the single command that asks for it
(`orbit secret exec`), or writes a 0600 file. On every heartbeat the server states which secrets the runner may still
hold, and the runner removes the rest, so removal does not depend on any one event arriving.

**Three decisions need your ruling (§9).** The first one changes something the task asked for:

1. **Do not put the secret in the engine's environment.** The task offered "env var for the session's engine process".
   That option cannot meet the isolation requirement: the agent's own shell inherits the variable, so `env` or
   `echo $DEEPSEEK_API_KEY` returns the value as a tool result, and the engine sends tool results straight to its model
   vendor without passing through Orbit. A running process's environment also cannot be cleared, so removal would mean
   killing the engine. This design gives the declared variable to the command that needs it and to nothing else.
2. **The card's promise has to be worded more carefully.** The mockup says the key "never appears in this conversation
   or in the agent's context". Orbit can guarantee that for everything Orbit itself does, and for accidents. It cannot
   guarantee it against an agent that sets out to read the key, because the program using the key runs as the same OS
   user as the agent (§5.3).
3. **"Save to my account secrets" should start unchecked.** The mockup shows it checked.

## 1. Constraints from the code today

| Fact | Where | Consequence |
|---|---|---|
| Provider keys are AES-256-GCM, key = SHA-256 of `PROVIDER_SECRET_KEY`, no associated data | `src/apiserver/src/providers/provider-crypto.ts:8` | The cipher is fine to reuse. A ciphertext is not bound to its row. |
| A configured provider's key is decrypted into the engine's environment for every session on it | `src/apiserver/src/providers/custom-provider.ts:729` | That is the exposure we must avoid. |
| The owner can read a personal provider key back | `src/apiserver/src/providers/providers.controller.ts:48` | The provider table is not write-only. |
| `ModelProvider` requires `baseUrl`, a `runtime` and a model list | `src/apiserver/prisma/schema.prisma:6821` | A row is a model endpoint, not an arbitrary credential. |
| An engine is one long-lived process; new env needs a respawn | `src/runner-go/provider_runtime.go:20`, `src/runner-go/codex.go:285` | Engine env cannot be added or removed mid-session without a restart. |
| Every process of a session runs as the runner's OS user | `src/runner-go/orchestration_credentials.go`, §5.3 | A 0600 file protects against other OS users, not against the agent. |
| End of turn runs `git add -A` in the checkout | `src/runner-go/worktree.go:420`, `:1144` | A secret file inside a checkout ships with the commit. |
| `file_upload` and friends run outside the engine sandbox, limited by `localFileScope` | `src/runner-go/local_file.go:12` | A secret must stay outside the session's checkout and uploads roots. |
| The runner spools unacknowledged events to disk | `src/runner-go/link_events_spool.go:19` | Scrubbing must happen before an event is spooled. |
| The gateway logs only the sizes of bodies | `src/link-gateway/framelog.go:105`, `:138` | The link may carry the value as a provider key does today. |
| Gateway retries `GET` tunnels only | `src/link-gateway/forward.go:85` | The fetch is a `POST`, so nothing but the runner's own call asks for it. |
| A heartbeat answer is a full reconcile, delivered at least once; an empty one states nothing | `contracts/runner-link/v1/runner_link.proto:486` | Removal fits here, but "absent" must never read as "remove everything". |
| Heartbeats run every 30 s; the reaper sweeps every 30 s | `src/runner-go/runloop.go:23`, `src/apiserver/src/realtime/reaper.service.ts` | This sets the removal latency. |
| Exact-value redaction already exists on both sides | `src/apiserver/src/common/secret-redaction.ts:68` (`literals`), `src/runner-go/integration_output_upload.go:203` (streaming, with carry) | Reuse both rather than writing a third. |

## 2. Lifecycle

The owner request itself (PENDING → DONE / DECLINED / EXPIRED / WITHDRAWN) belongs to the owner-request model. A secret
also needs a second lifecycle, because it outlives the request: the request is finished at DONE, and that is when the
secret starts being live.

```
Owner submits       Runner writes it, acks     Trigger (§6.1)            Runner confirms
      │                     │                        │                         │
      ▼                     ▼                        ▼                         ▼
PENDING_DELIVERY ────► ACTIVE ───────────────► REMOVING ───────────────► REMOVED
      │                                              ▲
      └── request expires / withdrawn / cancelled ───┘ (ciphertext deleted at once)
```

- The request becomes **DONE only when the runner acknowledges delivery**. Until then the card says the key is on its
  way, and the agent hears nothing. "Key is in" (panel 4) is then true when it is said.
- The ciphertext is deleted on the server the moment a grant enters REMOVING. The server never waits for the runner to
  drop its own copy.

## 3. Storage

### 3.1 Decision: reuse the cipher, not the table

The project instructions said to reuse provider credential storage if it fits. It does not fit, for the reasons in §1:
a provider row is a model endpoint, it has no expiry or runner binding, its key goes into engine environments, and it
can be read back. Fitting a generic secret into it would weaken each of those.

### 3.2 `owner_request_secret` (the grant)

| Column | Notes |
|---|---|
| `id`, `owner_id` | `owner_id` is on every query, as everywhere else |
| `request_id` | Unique; the owner request this answers |
| `runner_id` | Composite FK with `owner_id`, as `ManagedRunner` does (`schema.prisma:1369`), so a grant cannot name another account's runner |
| `session_id`, `task_id` | The asking session; its task when it has one. `task_id` set means task scope, otherwise session scope |
| `name` | `DEEPSEEK_API_KEY`, `^[A-Z][A-Z0-9_]{0,63}$` |
| `exposure`, `file_path` | `ENV`, or `FILE` with its path |
| `value_enc` | Ciphertext; NULL from REMOVING on |
| `state`, `end_reason` | §2; `TASK_ENDED`, `SESSION_ENDED`, `EXPIRED`, `WITHDRAWN`, `REVOKED`, `MOVED`, `RUNNER_DELETED`, `KEY_UNREADABLE` |
| `expires_at` | At most 7 days after submission (panel 1). Not renewable; the agent files a new request |
| `delivered_at`, `removed_at`, `removal_note` | `removal_note` holds what the runner reported, for example that the file had been replaced |

No length, prefix, last-four or hash of the value is stored or returned. The `sk-…3f9a` in the mockup exists only in the
owner's input box while they type.

The table is registered in `src/apiserver/src/common/db-write-inventory.ts`, like every other table.

### 3.3 Encryption

A new pair of functions beside `provider-crypto.ts`:

- key = HKDF-SHA-256 of `PROVIDER_SECRET_KEY` with the domain `orbit:owner-secret:v1`. No new deployment secret, and a
  ciphertext from one store cannot be decrypted as the other (the same domain split as
  `src/apiserver/src/auth/impersonation.ts:20`);
- AES-256-GCM with associated data `grant id | owner id | runner id`, so a ciphertext copied to another row by anyone
  with database write access fails authentication instead of being delivered to their runner.

If `PROVIDER_SECRET_KEY` is unset, filing a `secret` request is refused (`SECRET_STORE_UNAVAILABLE`) instead of failing
when the owner submits. Rotating it makes live grants unreadable, as it does for provider keys: they end with
`KEY_UNREADABLE` and the agent must ask again.

### 3.4 Saved account secrets (optional)

`account_secret`: `id`, `owner_id`, `label` (unique per owner), `value_enc` (associated data: `secret id | owner id`),
timestamps.

- **Write-only.** No route returns a value, not even to the owner. Replace or delete only. This differs from provider
  keys on purpose.
- **"Use saved" is always the owner's click on one request.** Agents cannot list labels, and a saved secret is never
  applied automatically. Using one re-encrypts a copy into a new grant, so it follows that grant's scope and expiry.
- A saved secret has no expiry and is the one long-lived copy in this design, which is why it should be opt-in.
- Deleting a saved secret does not end grants already made from it. The owner revokes those on their cards.

## 4. Delivery to exactly one runner

### 4.1 Filing

The agent calls `request_owner_action` with `kind: secret`, a label, `name`, and `exposure` (`env`, or `file` with
`path`). The agent does **not** choose the runner: the server takes it from the asking session, and the card shows it.
A session can only use a secret on the machine it runs on, so accepting a different runner would only widen where a
hijacked agent could send a key.

Filing is refused when:

- the runner does not declare `owner-secret/v1` (added at `src/runner-go/transport.go:78`). Windows runners do not
  declare it, because 0600 has no meaning there;
- `name` is reserved: anything `sessionContextEnvKey` or `userCredentialEnvKey` matches, `ORBIT_*`, `PATH`, `HOME`,
  `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, `PYTHON*`;
- `path` fails the rules in §5.2. `orbit mcp` runs on that machine, so it checks them before filing.

### 4.2 Sequence

1. **Owner submits.** `POST /owner-requests/:id/secret` with `{value, saveAs?}` or `{savedSecretId}`. In one transaction,
   holding the request's row lock: confirm it is PENDING and the session is still on that runner, encrypt, and insert
   the grant as PENDING_DELIVERY. The value must be 8 bytes to 16 KiB with no NUL. Below 8 bytes it could not be scrubbed
   without mangling ordinary text. A second submit before delivery replaces the first (a typo fix); after delivery it is
   409.
2. **Runner learns.** The heartbeat reconcile lists grant ids and expiries and nothing else. The existing commands hint
   brings the next heartbeat forward.
3. **Runner fetches.** `POST /runner/secret-grants/:id/fetch` behind `RunnerAuthGuard`. The query is
   `WHERE id = ? AND runner_id = <authenticated runner> AND state IN (PENDING_DELIVERY, ACTIVE)` and the scope must be
   live. Anything else, including another runner of the same owner, is the same 404 as an id that does not exist.
4. **Runner materialises** the value (§5) and calls `POST /runner/secret-grants/:id/ack` with `DELIVERED` or `FAILED` and
   a code.
5. **Ack.** In one transaction: the grant becomes ACTIVE, the request becomes DONE, and the resolution turn is queued.
   A repeated ack is a no-op.

A delivery failure (the path now exists, disk full) deletes the ciphertext, returns the card to its input state with the
reason, and leaves the request PENDING. The agent can withdraw it or file a corrected one.

"Exactly one runner" therefore rests on three checks: the composite FK, the fetch predicate on the authenticated runner,
and no broadcast anywhere. The value never travels in a claim, an inbox response, a heartbeat or a hint.

### 4.3 Offline runner

The grant waits as PENDING_DELIVERY and the request stays PENDING. Nothing is queued on the runner side. The card says:
"HPC is offline. Orbit will deliver this when it comes back, until <request expiry>." The owner can cancel. If the
request expires first, the ciphertext is deleted and the agent receives EXPIRED.

A session the reaper marks `runner offline` does not end its grant: the session can be resumed, and only the states in
§6.1 count as ended.

## 5. How the runner exposes it

### 5.1 `ENV`: scoped to one command

```
orbit secret exec DEEPSEEK_API_KEY -- python run_experiment.py
bg_run: orbit secret exec DEEPSEEK_API_KEY -- python run_experiment.py
```

The runner holds the value **in memory only**, never on disk. After a restart it fetches again, which is why the server
keeps the ciphertext until the grant ends.

`orbit secret exec` is a CLI, since it must be exec'd in the agent's shell:

1. It connects to the session's existing socket (`src/runner-go/background_socket.go`) with a new op, `secret_lease`.
   The runner checks that this session may use the grant: same session, or same task.
2. It starts the command with the variable added to that child's environment, and pipes the child's stdout and stderr
   through the exact-value scrubber (§5.4) before writing them out.
3. It holds the lease connection open. On a revocation message it sends SIGTERM to the child's process group, then
   SIGKILL 10 s later. If the runner merely restarted (connection lost), the command continues, reconnects and asks
   again. With no answer it stops at the grant's `expires_at`, which it was told at lease time.

Why the CLI starts the child and the runner does not: the command then stays under the engine's own sandbox and
permission check. A runner-started process would run outside the sandbox and would need the `bg_run` owner gate
(`src/runner-go/background_gate.go`). `bg_run` composes with it for long jobs, and its output file only ever receives
scrubbed text because the scrubber is upstream of it.

The value never reaches `job.Agent.Env`, a claim, an argv or the `bg_run` card.

**To verify during implementation:** whether each engine's sandbox allows the unix socket connection from its shell.
Where it does not, `bg_run` is the path, and the refusal message says so.

### 5.2 `FILE`: 0600 at a declared path

For tools that read a fixed file. The path is shown verbatim on the card.

Rules, checked by `orbit mcp` at filing and by the runner again at delivery:

- absolute or `~/…`, no `..`, under the runner user's home;
- not inside Orbit's directory (`machineHome`: worktrees, uploads, runs), any workspace's work directory, any directory
  with a `.git` above it, or an engine's config directory (`~/.claude`, `~/.codex`, `~/.kimi` and so on). The first two
  keep it out of `git add -A` and out of `localFileScope`;
- no symlink in any component (the descending open used by `openWorktreeArtifactFile`);
- **must not exist**: `O_CREAT|O_EXCL|O_NOFOLLOW`, with `fchmod 0600`, so nothing of the owner's is overwritten and a
  hijacked agent cannot aim the write at `~/.bashrc`. Missing parents are created 0700 and recorded.

A ledger at `~/.orbit/secret-grants/ledger.json` (directory 0700, file 0600) records grant id, path, device, inode,
parents created and expiry. **The entry is written before the file**, so a crash cannot leave a file nobody knows about.
The ledger holds no value and no hash of one.

### 5.3 What this does and does not protect

Everything a session runs shares one OS user. So a session that sets out to get the value can: read the file, read the
runner token from `~/.orbit/config.json` and call the fetch route, or run `orbit secret exec X -- sh -c 'echo $X | rev'`.
No exposure option closes this; only running the command under a separate OS user would (§10). Engine env would make it
worse by making the same read happen by accident.

### 5.4 The scrubber

One routine, built on `integrationOutputRedactor` and its carry logic. It replaces the raw value, its base64, base64url,
hex and URL-encoded forms, and each line of a multi-line value, with `[redacted]`.

## 6. Removal

### 6.1 Triggers

| Trigger | `end_reason` |
|---|---|
| The task reaches DONE, CANCELLED or FAILED (task scope) | `TASK_ENDED` |
| The session is completed, archived or deleted (session scope) | `SESSION_ENDED` |
| `expires_at` passes | `EXPIRED` |
| The request is withdrawn while PENDING, or the agent releases the grant after DONE | `WITHDRAWN` |
| The owner presses Revoke on the card or inbox | `REVOKED` |
| The session moves to another runner | `MOVED` |
| The runner is deleted | `RUNNER_DELETED` (removal unconfirmed) |

A reopened task does not get its secret back. The agent asks again.

### 6.2 Enforcement: one predicate, evaluated when asked

No hook on every door that can end a task. `tasks.service.ts` alone has many, and a missed one would be a silent leak.
Instead, a single SQL predicate, "is this grant's scope still live", joins the task and session and checks `expires_at`.
It is used by:

- the **heartbeat**, to build the list of grants the runner may hold;
- the **fetch** route, so an ended grant can never be delivered;
- a **sweep** in the reaper's 30 s cycle, which moves dead grants to REMOVING and deletes their ciphertext.

Removal therefore takes effect on the next heartbeat after the trigger, about 30 s, with no event to lose.

### 6.3 On the runner

Each full reconcile carries `secretGrants: [{id, expiresAt}]`. The runner removes whatever it holds that is not listed.
**Only a present list counts**: a heartbeat with no reconcile, or a control plane that omits the field, states nothing.
`[]` means remove everything.

Removing means:

- `ENV`: drop it from memory and send revocation to every open lease, which ends those commands;
- `FILE`: unlink if it is still the regular file at the recorded device and inode, and remove the empty parents the
  runner created. If a different file now stands there, leave it and report that in `removal_note`, which the card shows;
- then `POST /runner/secret-grants/:id/removed`, repeated until acknowledged. The grant becomes REMOVED.

### 6.4 Runner restarts and outages

- At start, **before** `reclaimMissingSessions` (`src/runner-go/runloop.go:560`): read the ledger, delete everything past
  `expires_at`, whether or not the control plane is reachable.
- Memory is empty after a restart, so `ENV` removal holds by construction.
- The first full reconcile removes any `FILE` whose grant ended while the runner was down, and re-fetches live grants to
  rebuild the scrubber. Sessions start only after this.
- If the runner cannot reach the server, files live until their own expiry, then go. A running runner checks the ledger
  every minute.
- `orbit unregister` removes everything in the ledger.
- **Limit:** removal needs a runner process. A machine that stays powered off, or a runner that is uninstalled by hand,
  keeps the file. The grant stays REMOVING and the card says "Removal pending: HPC has not been online since …", which
  is what is actually true.

## 7. Isolation

### 7.1 Three levels, stated plainly

| Level | Claim | Basis |
|---|---|---|
| **A. By construction** | Orbit's own code never places the value in any agent-visible or stored text | There is no field or path that could carry it; canary test |
| **B. Accidents are scrubbed** | If a command or agent output happens to contain the value, it is removed before it leaves through Orbit | Exact-value matching at each door below |
| **C. Not guaranteed** | An agent deliberately reading and transforming the value | §5.3; compensated by short lifetime, scoped keys and the card's wording |

### 7.2 Surface by surface

| Surface | Protection | Level |
|---|---|---|
| Tool result and resolution turn to the agent | Only `{state, name, exposure, path?, runner, expiresAt}` and the usage line. The sibling task's acceptance criteria already require no value in that payload | A |
| Owner request rows, list and inbox payloads, activity | The value exists only in `value_enc`, which is in no response DTO. The submit route has no response body beyond state | A |
| Claim, inbox, heartbeat, hints | Never carry it. `TestAgentEnvironmentsWithholdUserCredentials` is extended to assert no agent environment does | A |
| Push notifications, Feishu | Secret requests have no reply path there. "Provide key" only opens the card (panel 2) | A |
| Clients | `autocomplete=off`, no draft persistence, never in a URL; the input is cleared on submit | A |
| Apiserver logs | `pat-request-audit` does not read bodies (`auth/pat-request-audit.ts`), the slow-request log is route and time only; `ValidationPipe` messages for this DTO are checked not to echo values | A |
| Gateway logs | Sizes only (`framelog.go`) | A |
| Runner logs | The value is never formatted; no `logln` on these paths | A |
| Output of `orbit secret exec` (reaches the engine and model) | Scrubbed in the CLI before the engine sees it | B |
| Transcript, live view, shared links, wiki import | Scrubbed at the single event choke point, `emitOn` (`src/runner-go/session.go:1039`), **before** the spool, walking every string in the payload | B |
| Commits | After `git add`, staged content is scanned for the value; a matching file is unstaged and named in a warning event. Without this one hardcoded key reaches GitHub | B |
| `file_upload`, reply attachments | `localFileScope` already refuses a path outside the session's roots, which covers the file. Files inside the roots are scanned for the value when opened | B |
| Task evidence, comments, notify, session messages, every other agent write | One interceptor on the runner-authenticated routes: if the runner has ACTIVE grants, decrypt them and check every string in the body with `literals`. A hit is refused with `SECRET_IN_TEXT`, naming the variable, and nothing is stored | B |
| Engine's own transcript on disk (for example `~/.claude/projects`) and the model vendor | Clean if the value only ever passed through `orbit secret exec`. **If the agent `cat`s a `FILE`, the tool result goes to the vendor and that file, and Orbit cannot intercept it** | C |

The interceptor costs one indexed read per agent write and decrypts only on a runner with a live grant.

### 7.3 The card's wording (§9, decision 2)

Replace the mockup's line under the input with:

- `ENV`: "Goes straight to HPC. Orbit keeps it out of this conversation and away from the agent; only commands the
  agent runs with it can use it."
- `FILE`: "Goes straight to HPC as a file. Orbit keeps it out of this conversation, but any program running as *user*
  on HPC can read the file until it is removed."
- Both: "Use a key you can revoke."

## 8. Threat model and tenant isolation

| # | Attacker | Attempt | Defence | Residual |
|---|---|---|---|---|
| 1 | Another account | Fetch, submit to or list a grant or saved secret by id | `owner_id` on every query; census (§8.1) | None known |
| 2 | Another account's runner | Fetch with its own token | Fetch predicate on the authenticated runner; 404 | None known |
| 3 | The owner's other runner | Fetch a grant meant for runner A | Same predicate; a dedicated test, since the census only compares accounts | None known |
| 4 | Agent, including a prompt-injected one | Read the value | Level A and B remove every accidental path | **Level C: it can succeed.** Egress is not controlled. The key's own scope limits the damage |
| 5 | Agent | Phish a credential with a persuasive card | Card shows who asks, which runner and when it is removed; agent text is rendered as a quote; one owner action per request | The owner can still paste what they should not |
| 6 | Agent | Aim the write at a sensitive path | §5.2: must not exist, home only, deny roots, no symlinks, shown on the card | None known |
| 7 | Agent | Submit the value itself, resolve its own card, or list saved secrets | Owner routes refuse sessions and tokens (§8.1) | None known |
| 8 | Another session of the same account on the same runner | Use the secret | `secret_lease` checks session or task. `FILE` is readable by any process of that OS user | Same-account, same-user; same as §5.3 |
| 9 | Another OS user on the host | Read the file or memory | 0600 under a 0700 parent; per-account runners run as separate users | Root on the host can read it |
| 10 | Stolen database or backup | Decrypt | AES-GCM with an application key held outside the database | **Backups keep the ciphertext after removal.** Removal is not cryptographic erasure. An attacker with a backup and `PROVIDER_SECRET_KEY` recovers it |
| 11 | Database writer | Move a ciphertext to their own runner's row | Associated data fails authentication | None known |
| 12 | Administrator using impersonation | Submit or read | Writes are refused `IMPERSONATION_READ_ONLY`; there is no read path | An operator with the server's environment and database is trusted, as for provider keys |
| 13 | Stolen runner token | Fetch live grants for that runner | Only that runner's live grants, up to 7 days; revoking the runner ends them | Inherent to a machine credential |
| 14 | Compromised apiserver | Read values at submit or fetch | Not defended, as for provider keys | §10 |
| 15 | Runner re-registered or replaced | Old process keeps a secret | Fetch needs the credential the server currently holds for that runner; the grant is delivered only to the runner row it names | The old machine's file lasts until its local expiry |
| 16 | Managed runner | Operator reads the pod | Card names the runner | Operators of the cluster are trusted with that account's volume |

### 8.1 Tenant isolation: what the census must hold

The census fails the merge check for any new route it does not list, so these are required, not optional:

- `src/apiserver/src/auth/tenant-isolation-cases.ts`: `POST /owner-requests/:id/secret`, the cancel and revoke routes,
  `GET /account-secrets`, `PUT` and `DELETE /account-secrets/:id`. `savedSecretId` in `TENANT_ISOLATION_FIELD_CASES`:
  a body naming another account's saved secret must answer as an unknown id.
- `src/apiserver/src/auth/tenant-isolation-runner-cases.ts`: `fetch`, `ack` and `removed` in `RUNNER_ISOLATION_CASES`,
  each with an ack body's ids in `RUNNER_ISOLATION_FIELD_CASES`.
- `src/apiserver/src/auth/pat-owner-channel-routes.ts`: every owner route is `@PatForbidden('OWNER_INTERACTIVE')`, and
  each refuses a request carrying an acting session.
- Beyond the census: the same-owner second-runner test (#3), and a test that a grant's `session_id` and `runner_id`
  cannot be set from any request field.

## 9. Decisions for the owner

Decided by the owner on 2026-11-09, when confirming this design: the recommended option on all three.

| # | Decision | Decided | Alternative not taken, and its cost |
|---|---|---|---|
| 1 | Env-var exposure | Scoped to one command (`orbit secret exec`) | Inject into the engine's environment. Simpler for agents, but `env` puts the key in the model's context and vendor logs, and removal requires killing the engine. Project criterion 3 ("the declared env var") is still met by the decision |
| 2 | Card wording | §7.3 | Keep the mockup's sentence, which is not true for a deliberate read or for `FILE` |
| 3 | "Save to my account secrets" | Unchecked by default | Checked as in the mockup: every submitted key becomes a permanent server-side copy unless the owner notices |

## 10. Considered and not in this version

- **End-to-end encryption from client to runner** (runner keypair, server sees only sealed bytes). It would remove the
  server from the trust path at submit time. But "use saved" and the write-door check both need the plaintext, all four
  clients would need the crypto, and the server still vouches for the runner's public key. A good later hardening.
- **Running secret-holding commands under a separate OS user.** This is the only thing that would close level C for
  reading. hostd is the natural home, but it exists only on set-up Linux hosts.
- **Sealing the fetch response to an ephemeral key.** TLS plus size-only gateway logs match how provider keys travel
  today; it can be added without changing the model.
- **Egress control** for commands holding a secret. Out of scope for Orbit today.

## 11. What the implementation must prove

The implementation task is an end-to-end run against a real runner with a random canary value, plus:

1. **Absence.** After a full flow (submit, delivery, `orbit secret exec` printing the value raw and in base64, a command
   failing with it, end of task), search for the canary in: a dump of all database text columns, apiserver, gateway and
   runner logs, the link spool, session events, the engine's on-disk transcript, tool results, evidence and git objects.
   Only `value_enc` may hold it, and only encrypted.
2. **One runner.** Second runner of the same owner and another account's runner both get 404; a moved session ends the
   grant.
3. **Removal, one test per row of §6.1**, including with the runner stopped during the trigger and restarted afterwards,
   and `expires_at` passing with the control plane unreachable.
4. **Reconcile safety.** A heartbeat without a reconcile, or an older server omitting the field, removes nothing.
5. **Crash windows.** Kill the runner between ledger write and file write, and between file write and ack.
6. **Path rules.** Each refusal in §5.2, and a symlink swapped in between check and write.
7. **Write-door refusal** for a sample of agent routes, and the census additions in §8.1.
8. **Each engine's sandbox** with `orbit secret exec` (§5.1).
