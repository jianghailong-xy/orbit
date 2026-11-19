# `/usr/local/bin/orbit` stays root's on a machine that is not set up

Task 34qRsojmmArC4S8kUkYAQ, in project 34uUvixOgW5SbuNGvkAKA. The coordinator chose option B on 2026-11-11.

## The problem

On a machine set up with `orbit host setup`, `/usr/local/bin/orbit` is already root's alone: setup and hostd's update
refuse anything else (`checkMachineBinary`), and each account's runner runs its own `~/.orbit/bin/orbit`. On a
machine that is not set up, two commands made the binary a link into an account's home:

- `orbit register` (`adoptUserBin`). Under sudo, register is handed to the account (`register_sudo.go`). When the
  binary it ran from sat in root's `/usr/local/bin`, it copied that binary to `~/.orbit/bin/orbit` and ran
  `sudo ln -sf ~/.orbit/bin/orbit /usr/local/bin/orbit`.
- `sudo /usr/local/bin/orbit upgrade` (`migrateLegacyInstall`) did the same as root, for the account whose service ran
  the binary.

The account, and any agent it runs, can replace `~/.orbit/bin/orbit`. After either command, every `sudo orbit …`
on the machine ran that file as root before anything could hand off. Task 34pVVKDohkOa6db1Z4vFF saw this on
Debian 12: after `sudo -i bash -c "orbit register …"`, `/usr/local/bin/orbit` was a link to
`/home/alice/.orbit/bin/orbit`.

## Options

**A. Refuse to run.** At startup, the binary would refuse to go on when it is root and its own resolved path is a
file an account can write. This protects nothing: whoever replaces the file replaces the check with it. A
tampered binary never refuses. Rejected.

**B. A root-owned copy at `/usr/local/bin/orbit` (chosen).** The service runs the account's own copy in
`~/.orbit/bin`, which the runner updates itself. `/usr/local/bin/orbit` is root's regular file, and register and
upgrade never make it a link. This is the layout install.sh leaves since 281157f9e, and the one a set-up machine
has, with hostd as its updater. The cost is that the PATH's `orbit` lags behind the runner's self-updates (see
below).

**C. Remove the link and put nothing there.** `sudo orbit` would no longer find a command on sudo's secure_path.
Older installs have no PATH entry for `~/.orbit/bin`, because the link was their PATH entry, so the account's own
`orbit` would go too. Rejected.

## What register and upgrade do now

- `orbit register` on a binary in root's `/usr/local/bin` copies it to the account's `~/.orbit/bin/orbit` and
  installs the service on that copy. `/usr/local/bin/orbit` is not touched. The copy is written by the account
  itself, so this step needs no sudo.
- `sudo /usr/local/bin/orbit upgrade` on such an install installs the release at `/usr/local/bin/orbit`, which
  stays root's. It then gives each ordinary account whose runner service runs that file its own copy of the new
  release, rewrites the unit or LaunchAgent to name the copy, and restarts it. A copy takes the binary from no one,
  so a binary that several accounts' services run now gets one copy per account. Root's runner, template instances
  and the host broker go on running `/usr/local/bin/orbit`.

## Machines that already have the link

`repairMachineLink` handles the link. It acts only when `/usr/local/bin/orbit` is a symlink in a directory root
owns, and the link resolves to a file that fails `checkMachineBinary` (a file an account can change). It replaces
the link with a root-owned regular file holding what the link led to:

- **As root** (`sudo orbit upgrade`, or register on macOS when nothing is handed off), it does this in-process. It
  writes a temporary file in `/usr/local/bin`, sets its owner to `0:0` and its mode to `0755`, then renames it
  over the link.
- **As the account** (register after the sudo hand-off), it does the same through sudo:
  `sudo install -o 0 -g 0 -m 0755 <target> /usr/local/bin/orbit.new-<pid>`, then
  `sudo mv -f /usr/local/bin/orbit.new-<pid> /usr/local/bin/orbit`. If either step fails, the link stays as it was,
  the temporary file is removed, and register prints the two commands to run by hand. Register itself goes on.

Both forms are atomic: `/usr/local/bin/orbit` is either the old link or the complete root-owned file, never missing
or half written. Running the repair again does nothing, because the path is then a regular file.

After a repair, `sudo orbit upgrade` installs the verified release at root's file rather than into the account's
copy. The account's runner updates its own copy as before. If the download fails, root's file holds what the link
led to, which is exactly what each `sudo orbit …` had been running.

### What the repair cannot undo

The command that repairs the link is itself a `sudo orbit …` call. It runs the account's file as root once, before
it can repair anything: register before its hand-off, upgrade for its whole run. Whatever that file was at that
moment has already run as root, and its bytes are what root's copy starts from (until upgrade's verified release
replaces them). The repair guarantees only that no later `sudo orbit …` runs a file the account can change. If an
account on the machine might already have replaced its copy, don't run the linked binary as root at all. Put a
verified release in place first, then repair the link:

```bash
curl -fsSL https://orbit.example.com/dl/orbit-linux-amd64.gz | gunzip > /tmp/orbit && \
  sudo install -o 0 -g 0 -m 0755 /tmp/orbit /usr/local/bin/orbit.new && sudo mv -f /usr/local/bin/orbit.new /usr/local/bin/orbit
```

## The PATH's `orbit` lags

The runner updates `~/.orbit/bin/orbit`. `/usr/local/bin/orbit` changes only when root runs
`sudo /usr/local/bin/orbit upgrade` (on a set-up machine, hostd follows each release by itself). Until then, an
`orbit` found on `/usr/local/bin` is the older build. No command reports the gap today:

- `orbit status` prints the version of the binary it was invoked as, so through `/usr/local/bin` it shows the older
  one.
- `orbit doctor` doesn't compare the two.

To see both, compare `orbit version` with `~/.orbit/bin/orbit version`. The runner's own version is also on its
page in the web UI. Older commands keep working, because the runner's own copy is what talks to the control plane
for the service. To use the newer one, type `~/.orbit/bin/orbit`, put `~/.orbit/bin` ahead of `/usr/local/bin` on the
account's PATH (install.sh's `~/.local/bin/orbit` launcher does this on Debian), or run the upgrade.

## macOS

macOS takes the same path. `installLaunchd` calls `adoptUserBin` with sudo when it runs at a terminal. On Apple
Silicon, `/usr/local/bin` is root's, so the copy and the repair apply as on Linux, with numeric `-o 0 -g 0` because
macOS has no `root` group name. `migrateLegacyInstall` finds the LaunchAgent of the account that ran sudo. On Intel
Macs with Homebrew, `/usr/local/bin` belongs to the user, `rootOwnedDir` is false, and nothing is copied or
repaired: an account that can write the directory can replace whatever is in it anyway. When register runs on a
Mac without a terminal, it has no sudo, so it leaves the link and prints the commands to replace it.
`go vet` for darwin covers this code, which has no build tags.
