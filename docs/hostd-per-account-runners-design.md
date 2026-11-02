<!-- 2026-11-02 · draft for the owner's review. Board: docs/mocks/hostd-per-account/01-architecture.html (+ PNGs). -->

# Set-up hosts: each account's runner is named after the account and runs the account's own binary

On a Linux host set up with `orbit host setup`, an account's runner becomes `orbit-runner@<user name>.service`
and runs that account's own `~/.orbit/bin/orbit`. The account's runner updates its own copy, as on a host that
is not set up. hostd stays the root broker that starts and stops runners without sudo. It keeps one root-owned
binary for itself.

This reverses two choices of the hostd project (34BLpZtxltHQ2iYOwEssM, August 2026):

- instances keyed by uid (`orbit-runner@1000.service`), and
- one shared machine binary (`/usr/local/bin/orbit`) that every instance runs and that hostd updates for all of
  them.

The owner made the call on 2026-11-02, after a production host was moved to the hostd layout and its account's
runner turned out to be `orbit-runner@1000` running `/usr/local/bin/orbit`: "it should be `orbit-runner@<user>`,
named by the Linux user name, and it should start from `.orbit/bin/orbit`".

## 1. Where things stand

| | Host not set up (since 2026-11-01) | Set-up host, today | Set-up host, this design |
|---|---|---|---|
| Binary an account's runner runs | `~/.orbit/bin/orbit`, the account's own | `/usr/local/bin/orbit`, shared, root's | `~/.orbit/bin/orbit`, the account's own |
| Unit | `orbit-runner-<user>.service`, written through sudo | `orbit-runner@<uid>.service`, a template instance, `User=%i` | `orbit-runner@<escaped user>.service`, `User=%I` |
| Who updates that binary | the runner itself | hostd, for every instance at once (`update` verb) | the runner itself |
| Root needed after setup | yes (register writes the unit) | no | no |
| What hostd runs as root | n/a | `/usr/local/bin/orbit hostd` | `/usr/local/bin/orbit hostd` (unchanged) |

Hosts that are not set up do not change.

## 2. Goals and non-goals

Goals:

1. The unit names the account: `systemctl status orbit-runner@alice` is alice's runner.
2. The process is the account's own binary: `/proc/<pid>/exe` is `/home/alice/.orbit/bin/orbit`.
3. Every account updates its own runner with no root, as on a host that is not set up.
4. Everything hostd gives today stays: no sudo to register, unregister, restart or check a runner after setup;
   `Restart=always`; a drain on stop (`KillMode=mixed`, `TimeoutStopSec=180`).
5. Root never executes a file an account can change, and never executes a download (unchanged rules).

Non-goals: root's own runner as a hostd instance (hostd keeps refusing uid 0); macOS (launchd is unchanged).

## 3. Design

### 3.1 Instance name: the user name, escaped by systemd's own rule

The instance string is `systemd-escape <user name>`. The template sets `User=%I`, the unescaped instance name.
Checked with systemd 257:

| User name | Instance string | Unit |
|---|---|---|
| `alice` | `alice` | `orbit-runner@alice.service` |
| `alice.b` | `alice.b` | `orbit-runner@alice.b.service` |
| `alice_b` | `alice_b` | `orbit-runner@alice_b.service` |
| `test-user` | `test\x2duser` | `orbit-runner@test\x2duser.service` |
| `.hidden` | `\x2ehidden` | `orbit-runner@\x2ehidden.service` |

systemd's escaping is reversible, so two accounts never share a unit. The collision that led to uid keys came from
`systemdServiceFor`, orbit's own lossy mapping (`alice.b` and `alice_b` both become `orbit-runner-alice_b`), not
from systemd. The plain user name is not enough: `%I` unescapes `-` to `/`, so an instance written `test-user`
would run as `test/user`.

hostd derives the name the way it derives the uid today: SO_PEERCRED gives the uid, the passwd database gives the
name, and the request body never names a target.

A numeric instance string is a uid to systemd: `User=1000` runs as uid 1000, which was checked with
`User=65534`. So an `orbit-runner@1000` instance left from before keeps working under the new template until it
is migrated (3.7).

### 3.2 What an instance runs: the account's own `~/.orbit/bin/orbit`

One template serves every account, and `%h` in a system unit is root's home, not the instance user's. Three ways
for the template to reach each account's binary (decision 1):

- **A (recommended).** `ExecStart=/bin/sh -c 'exec "$HOME/.orbit/bin/orbit" run'`. systemd sets `$HOME` from the
  passwd entry for a unit with `User=`. Checked: `User=daemon` gets `HOME=/usr/sbin`. An account whose home is
  `/nonexistent` gets no `$HOME`, and hostd refuses it (3.3). `exec` leaves the account's binary as the unit's
  main process, so drain, `KillMode=mixed` and `/proc/<pid>/exe` behave as today.
- **B.** hostd writes a drop-in per instance, `orbit-runner@<name>.service.d/exec.conf`, with the absolute path.
  `systemctl cat` shows the path, but hostd now owns per-account unit files that it has to create, rewrite and
  remove.
- **C.** `ExecStart=/usr/local/bin/orbit run-account`: the machine binary starts as the account and execs the
  account's copy, installing it first if it is missing. Every account then executes the machine binary at every
  start, so it has to stay executable by others (today's `checkRunnable`).

### 3.3 hostd

- Every verb acts on `orbit-runner@<escaped name>.service`. uid 0 is still refused for `enable`, `start` and
  `restart`.
- `enable` refuses, with the command to run, when the account has no executable `~/.orbit/bin/orbit` or no home
  directory. hostd only looks at the file. It never executes, reads or writes anything in an account's home.
- `enable` and `disable` also take down the account's older units, by their `User=` as today:
  `orbit-runner@<uid>`, `orbit-runner-<user>` and `orbit-runner`. No account has two runners at any point.
- `status` reports the unit and the binary the main process runs.

### 3.4 `orbit register` and the account's copy

Before it asks hostd to enable the instance, register (running as the account) makes sure `~/.orbit/bin/orbit`
exists. If register runs from somewhere else (`/usr/local/bin/orbit`, a download), it copies itself there the way
install.sh does: a new file in the same directory, renamed over the old one. It writes only into the account's
own home, as the account. The credential flow and the register receipt do not change.

### 3.5 Updates

- An instance's binary is the account's own, in a directory the account can write. So the runner swaps it and
  re-execs, as on a host that is not set up. It does not ask hostd.
- hostd's own binary is the one `orbit-hostd.service` names (decision 2):
  - **A (recommended).** Keep the `update` verb, but only for hostd's binary. After a runner installs a release,
    it asks hostd once. hostd installs the published release into `/usr/local/bin/orbit` through today's checks
    (manifest sha256, version and contract, every probe run as the caller, never as root) and restarts no
    instance. The next connection activates hostd from the new file.
  - **B.** Remove the verb. The admin updates the machine binary (`sudo /usr/local/bin/orbit upgrade`), or a root
    runner that runs it does.
- The case where a root runner swaps the shared binary first and an instance stays on its old image cannot
  happen: no instance runs the shared binary.

### 3.6 install.sh

On a set-up host, every account installs the way it does on a host that is not set up: into its own
`~/.orbit/bin/orbit`, plus the `~/.local/bin/orbit` launcher, with no sudo. install.sh never writes `/usr/local/bin/orbit`. Only the
admin puts that file in place, before setup as documented, and hostd's update replaces it. The branch that
installs the machine binary through sudo (`MACHINE_DIR`, `TEMPLATE`) goes away. The `curl … | sudo bash`
hand-off to `orbit register` as the account (task 34q8KOQYHUWSI89y6Gw3W) stays as it is.

### 3.7 `orbit host setup`

- It writes the template above. The rule for the binary hostd runs, `checkMachineBinary`, stays. `checkRunnable`
  (every account must be able to execute the machine binary) goes, unless decision 1 is C.
- Running setup again on a host set up before this change also moves the existing instances (decision 3):
  - **A (recommended).** Setup moves each `orbit-runner@<uid>` whose account has its own copy to
    `orbit-runner@<name>`, one at a time, each drained on stop. It lists the accounts without a copy, each with
    the one command that account runs (`orbit register`, or install.sh).
  - **B.** Setup changes no instance. Each account moves on its next `orbit register`. Until then its uid instance
    runs the new template, which fails without a copy.

### 3.8 Root's runner

hostd still refuses uid 0, so a root runner stays a legacy unit (`orbit-runner-root.service`). Decision 4:

- **A (recommended).** Leave it as it is. If it runs `/usr/local/bin/orbit`, its own updates keep hostd's binary
  current as well. Both files are root's, so nothing crosses an account boundary.
- **B.** Move it to `/root/.orbit/bin/orbit`, as root uses on a host that is not set up. That restarts the
  runner, and gains nothing on a host where hostd's update is kept (decision 2 A).

## 4. Security

- Root executes only `/usr/local/bin/orbit`, held to `checkMachineBinary` at setup and before every update: a
  regular file root owns that neither group nor others can write, in directories only root can write, up to `/`.
- An instance runs as its account and executes that account's file, which the account could run anyway. Nothing
  crosses an account boundary.
- hostd decides the instance from SO_PEERCRED plus passwd, and no user-supplied string ever becomes a unit name.
  Escaping is systemd's own, which is reversible.
- hostd only checks that the account's binary exists and is executable. It never executes, reads or writes a file
  in a home.

## 5. Migration and rollout

1. Publish the release.
2. On each set-up host, the admin replaces the machine binary
   (`sudo install -o 0 -g 0 -m 0755 <new> /usr/local/bin/orbit`) and runs setup again. The template is rewritten,
   and instances move as in 3.7.
3. The production host that is set up today: its one account's `orbit-runner@<uid>` becomes
   `orbit-runner@<name>`, running the copy the account already has in `~/.orbit/bin`. The root runner is
   untouched. This step is owner-confirmed.
4. Hosts that are not set up: nothing to do.

Rollback: the old hostd does not know name instances, so the admin does it.
1. Stop each `orbit-runner@<name>` with `systemctl disable --now`.
2. Run setup from the previous release, which writes the old template back.
3. Enable the uid instances the old way.

## 6. Tests and docs

- runner-go unit tests:
  - the template text (`User=%I`, ExecStart);
  - the escaped instance names, including the five above;
  - the verbs on names, and the refusal without a copy;
  - migration from `@<uid>`, `-<user>` and the bare unit;
  - register putting its copy in place;
  - the update verb limited to hostd's binary;
  - no delegation when the runner's directory is writable.
- `scripts/hostd-e2e.sh` (real systemd, never `--privileged`, image unchanged):
  - `orbit-runner@alice` and `orbit-runner@test.user`, each process's exe in its account's home;
  - `kill -9`, unregister;
  - migration of a uid instance by re-running setup;
  - a published release that each runner installs into its own copy, while hostd updates its own binary and
    restarts nothing.
- `scripts/install-sh-e2e.sh`: the set-up scenarios (S1–S7) now expect the account's home and no sudo.
- `docs/self-hosting.md` ("Set up the machine once" through updates) and `docs/runner-troubleshooting.md`.

## 7. Phases

- P1, runner-go: template, escaped names, verbs, refusal without a copy, migration from older units.
- P2, runner-go: register puts the account's copy in place, the update verb is limited to hostd's binary, and
  delegation is gone for writable installs.
- P3, install.sh: set-up hosts install into the account's home, with e2e scenarios.
- P4: hostd-e2e and docs.
- P5: release, then the production host (owner-confirmed).

## 8. Proposed acceptance criteria (the owner's to edit)

1. On a set-up host, two accounts, one with `-` and one with `.` in its name, register without root. Their
   runners are `orbit-runner@<escaped name>.service`, each running as its account from that account's
   `~/.orbit/bin/orbit`.
2. On a host set up before this change, running setup again moves every `orbit-runner@<uid>` whose account has a
   copy to `orbit-runner@<name>`. No account has two runners at any point, and setup lists each account left
   behind with the command that account runs.
3. When a release is published, each runner installs it into its own copy without root. hostd updates its own
   binary and restarts nothing. Root never executes a download or a file an account can write.
4. install.sh on a set-up host installs into the running account's `~/.orbit/bin` without sudo and never writes
   `/usr/local/bin/orbit`.
5. `scripts/hostd-e2e.sh`, `scripts/install-sh-e2e.sh` and the runner-go suite pass.
6. The production host: its account's runner is `orbit-runner@<name>` running that account's own copy, and the
   root runner is unchanged.
