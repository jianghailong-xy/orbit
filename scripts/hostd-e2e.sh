#!/usr/bin/env bash
# End-to-end acceptance for multi-user runners without root (orbit-hostd + orbit-runner@<uid>).
#
# On a real systemd, in a throwaway container that has no sudo at all, root runs
# `orbit host setup` once. From then on two ordinary accounts — one with a dot in its name —
# register, survive a kill -9, take a central update and unregister, none of it as root.
#
#   bash scripts/hostd-e2e.sh
#
# Prints one PASS or FAIL line per assertion (numbered as in the task: 1 setup · 2 accounts and a
# legacy unit · 2b setup refusing a binary an account could change · 3 alice registers · 4 test.user
# registers · 5 kill -9 · 6 update · 6b a binary directory the staff group can write · 7 alice
# unregisters · 8 test.user unregisters past a legacy unit · 9 no sudo throughout). The first FAIL
# prints systemctl status and the journal of the units involved and exits 1; a harness problem (no
# docker, a failed build) exits 2.
#
# It is also what keeps docs/self-hosting.md "Multi-user Linux machines" true: every command that
# section shows is run here, under a "# docs:" comment naming the heading it comes from, with the
# same arguments and the same orbit-runner@<uid> unit names. Root runs the section's sudo commands
# itself, since this machine has no sudo (assertion 9).
#
# Needs docker — 28 or newer, for --security-opt writable-cgroups — and a Go toolchain. Builds from
# this tree: orbit four times (the release setup installs, the one the stub control plane publishes
# as the update, and the two step 6b publishes), the stub control plane
# (scripts/hostd-e2e/stubserver) and the image (scripts/hostd-e2e/Dockerfile). The container is not
# privileged — under --privileged its systemd would apply its sysctl and udev defaults to the host —
# and has no network, so nothing in it can reach a real control plane.
#
# HOSTD_E2E_KEEP=1 leaves the container running afterwards for inspection.

set -uo pipefail # not -e: every check below is explicit, so that a failure can say what failed

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/runner-go"
HERE="$ROOT/scripts/hostd-e2e"
IMAGE="orbit-hostd-e2e:bookworm"
PORT=18080
SERVER="http://127.0.0.1:$PORT"
V1="0.1.900" # installed by `orbit host setup`
V2="0.1.901" # published by the stub as the update
V3="0.1.902" # published while /usr/local/bin is the staff group's too (6b)
V4="0.1.903" # published once it is root's alone again (6b)
PROXY="http://proxy.example.com:3128" # alice's --proxy, which the shared template cannot carry
BIN="/usr/local/bin/orbit"
TEMPLATE="/etc/systemd/system/orbit-runner@.service"
CTR="orbit-hostd-e2e-$$-$RANDOM"
WORK=""
ACCOUNTS=()
SUDO_CHECKS=0

harness_fail() {
  echo "HARNESS ERROR: $*" >&2
  exit 2
}

cleanup() {
  local rc=$?
  if [ -n "${HOSTD_E2E_KEEP:-}" ]; then
    echo "container $CTR left running (HOSTD_E2E_KEEP) — remove it with: docker rm -f $CTR"
  else
    docker rm -f "$CTR" >/dev/null 2>&1
  fi
  case "$WORK" in
    "${TMPDIR:-/tmp}"/orbit-hostd-e2e.*) rm -rf -- "$WORK" ;;
  esac
  exit "$rc"
}

# --- running things in the container ------------------------------------------------------------

cx() { docker exec "$CTR" "$@"; }
# csh LINE — one shell line in the container as root, with in-container.sh's helpers loaded.
csh() { docker exec "$CTR" bash -c ". /opt/orbit-e2e/in-container.sh; $1"; }
# as ACCOUNT LINE — LINE in a login shell of ACCOUNT, the way that user would type it. Stdin is the
# container's own /dev/null: docker hands exec'd commands the daemon's /dev/null, which orbit does
# not recognise as one and would treat as a terminal.
as() { docker exec "$CTR" su - "$1" -c "$2 </dev/null"; }

unit_prop() { cx systemctl show -p "$2" --value "$1"; }
main_pid() { unit_prop "$1" MainPID; }
unit_running() { [ "$(unit_prop "$1" ActiveState)/$(unit_prop "$1" SubState)" = "active/running" ]; }
# restarted UNIT OLDPID — UNIT runs again, under a process other than OLDPID.
restarted() {
  local pid
  pid=$(main_pid "$1")
  unit_running "$1" && [ -n "$pid" ] && [ "$pid" != 0 ] && [ "$pid" != "$2" ]
}
stub_runners() { cx /opt/orbit-e2e/stubserver get "$SERVER/stub/runners"; }
# stub_field NAME COLUMN — one column of the stub's line for runner NAME
# (name id state heartbeats version seconds-since-last-beat).
stub_field() { stub_runners | awk -v n="$1" -v c="$2" '$1 == n { print $c }'; }
beats_since() { [ "$(stub_field "$1" 4)" -gt "$2" ] 2>/dev/null; }
reports_version() { [ "$(stub_field "$1" 5)" = "$2" ] && [ "$(stub_field "$1" 3)" = live ]; }
machine_version_is() { [ "$(cx "$BIN" --version 2>/dev/null)" = "$1" ]; }
# own_journal_has ACCOUNT TEXT — ACCOUNT's own `journalctl -u orbit-runner@$(id -u)`, run as that
# account, shows a line containing TEXT.
own_journal_has() { as "$1" 'journalctl -u orbit-runner@$(id -u)' 2>/dev/null | grep -qF -- "$2"; }
# runner_logged TEXT — one of the two runner instances has logged a line containing TEXT.
runner_logged() {
  local u
  for u in "$UNIT_A" "$UNIT_T"; do
    cx journalctl -u "$u" -o cat --no-pager | grep -qF -- "$1" && return 0
  done
  return 1
}

# publish VERSION — the stub serves VERSION as the latest release. Asset first, manifest last, each
# by rename: what a runner reads is always a whole release.
publish() {
  csh "cp /opt/orbit-e2e/release-$1/orbit-linux-x64.gz /srv/orbit-dl/.asset && mv /srv/orbit-dl/.asset /srv/orbit-dl/orbit-linux-x64.gz &&
    cp /opt/orbit-e2e/release-$1/version.json /srv/orbit-dl/.manifest && mv /srv/orbit-dl/.manifest /srv/orbit-dl/version.json" ||
    harness_fail "publishing $1 failed"
}

# wait_until SECONDS CMD... — polls CMD once a second; fails if it has not succeeded in time.
wait_until() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 1
  done
}

# show OUTPUT — a command's output, indented under the step that ran it.
show() { sed 's/^/    | /' <<<"$1"; }

# --- verdicts ------------------------------------------------------------------------------------

pass() { echo "PASS $1 $2"; }

# fail N WHAT [UNIT...] — the FAIL line, then what the machine looked like, then exit 1.
fail() {
  local n=$1 what=$2
  shift 2
  echo "FAIL $n $what"
  # The units the failure is about, or every unit of the design when it names none.
  [ $# -gt 0 ] || set -- orbit-hostd.socket orbit-hostd.service 'orbit-runner@*'
  echo "----- context: units -----"
  cx systemctl list-units --all --no-pager --plain 'orbit*' 2>&1
  local u
  for u in "$@"; do
    echo "----- systemctl status $u -----"
    cx systemctl status --no-pager --full -n 30 "$u" 2>&1
  done
  echo "----- /etc/systemd/system -----"
  cx ls -la /etc/systemd/system /etc/systemd/system/multi-user.target.wants 2>&1
  echo "----- journal: hostd, runners, stub (last 150 lines) -----"
  cx journalctl --no-pager -n 150 -o short-precise -u orbit-hostd.service -u orbit-hostd.socket \
    -u 'orbit-runner@*' -u 'orbit-runner-*' -u orbit-e2e-stub.service 2>&1
  echo "----- stub: runners -----"
  stub_runners 2>&1
  exit 1
}

# check_no_sudo WHEN — assertion 9, re-checked after every step: sudo is neither installed nor
# on root's or any account's PATH.
check_no_sudo() {
  csh has_sudo && fail 9 "sudo is present in the container ($1)"
  local acct
  for acct in "${ACCOUNTS[@]}"; do
    as "$acct" 'command -v sudo' >/dev/null 2>&1 && fail 9 "sudo resolves on $acct's PATH ($1)"
  done
  SUDO_CHECKS=$((SUDO_CHECKS + 1))
}

# check_user_command N OUTPUT RC WANT — a register/unregister run as a user: exit 0, says WANT, and
# never mentions sudo (the broker path needs none; the legacy fallback is all sudo).
check_user_command() {
  [ "$3" -eq 0 ] || fail "$1" "the command exited $3"
  grep -qF -- "$4" <<<"$2" || fail "$1" "the command did not report: $4"
  if grep -qi sudo <<<"$2"; then
    fail "$1" "the command mentions sudo — it left the broker path for the legacy one"
  fi
}

# check_machine_binary N SHA256 — the machine binary every instance runs is still the machine's:
# a root-owned 0755 regular file holding the release expected, not moved into an account's
# ~/.orbit/bin nor replaced by a link to one, and the runner template is as setup wrote it.
check_machine_binary() {
  local st sha acct
  st=$(cx stat -c '%F %U %a' "$BIN")
  [ "$st" = "regular file root 755" ] ||
    fail "$1" "$BIN is now '$st'; it must stay the machine's root-owned 0755 regular file"
  sha=$(cx sha256sum "$BIN" | cut -d' ' -f1)
  [ "$sha" = "$2" ] || fail "$1" "$BIN has sha256 $sha, want $2"
  for acct in "${ACCOUNTS[@]}"; do
    cx test ! -e "/home/$acct/.orbit/bin/orbit" ||
      fail "$1" "/home/$acct/.orbit/bin/orbit exists: the shared binary was moved into an account"
  done
  [ "$(cx sha256sum "$TEMPLATE" | cut -d' ' -f1)" = "$TEMPLATE_SHA" ] ||
    fail "$1" "$TEMPLATE was rewritten after setup"
}

# check_one_runner N UID UNIT — UID has exactly one runner process, UNIT's main process.
check_one_runner() {
  local pids pid
  pids=$(csh "runner_pids $2")
  pid=$(main_pid "$3")
  [ "$pids" = "$pid" ] ||
    fail "$1" "uid $2 runs orbit runner process(es) [$(tr '\n' ' ' <<<"$pids")], want exactly $3's main process $pid" "$3"
}

# legacy_unit ACCOUNT — the per-user unit the sudo-era `orbit register` wrote (service.go
# renderSystemdUnit), named orbit-runner-<username> with anything unit names disallow as '_'.
legacy_unit() {
  local home="/home/$1"
  cat <<EOF
[Unit]
Description=Orbit runner ($1)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$1
Group=$1
ExecStart=$BIN run
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=180
Environment=HOME=$home
Environment=ORBIT_HOME=$home/.orbit
Environment=PATH=$home/.local/bin:$home/.opencode/bin:$home/.kimi-code/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF
}

# install_legacy_unit ACCOUNT UNIT — write, enable and start it, as that registration left it.
install_legacy_unit() {
  legacy_unit "$1" | docker exec -i "$CTR" tee "/etc/systemd/system/$2" >/dev/null &&
    cx systemctl daemon-reload &&
    cx systemctl enable --now "$2" >/dev/null 2>&1
}

# --- build ---------------------------------------------------------------------------------------

command -v docker >/dev/null || harness_fail "docker is not installed"
command -v go >/dev/null || harness_fail "go is not installed"
docker version >/dev/null 2>&1 || harness_fail "cannot talk to the docker daemon"
[ "$(docker version --format '{{.Server.Arch}}')" = amd64 ] ||
  harness_fail "the docker host is $(docker version --format '{{.Server.Arch}}'); this run builds linux/amd64"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/orbit-hostd-e2e.XXXXXX")" || harness_fail "mktemp failed"
trap cleanup EXIT

BASE_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "==> base $BASE_SHA ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null))"
echo "==> building orbit $V1, $V2, $V3 and $V4 (linux/amd64), the stub control plane and $IMAGE"
for v in "$V1" "$V2" "$V3" "$V4"; do
  # defaultServer is the stub, as a deployment's own download defaults to its PUBLIC_ORIGIN: root's
  # `orbit upgrade` in 6b has no runner config to name a server.
  (cd "$SRC" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags "-s -w -X main.version=$v -X main.sourceSHA=$BASE_SHA -X main.defaultServer=$SERVER" -o "$WORK/orbit-$v" .) ||
    harness_fail "building orbit $v failed"
  mkdir -p "$WORK/release-$v"
  gzip -c -n "$WORK/orbit-$v" >"$WORK/release-$v/orbit-linux-x64.gz" || harness_fail "gzip failed"
  # The manifest exactly as a release publishes it: the asset's sha256 and the write contract.
  (cd "$SRC" && go run ./cmd/release-manifest "$v" ../../contracts/runner-write-protocol.json \
    "$WORK/release-$v/version.json" "$WORK/release-$v/orbit-linux-x64.gz") ||
    harness_fail "writing the $v manifest failed"
done
SHA_V1=$(sha256sum "$WORK/orbit-$V1" | cut -d' ' -f1)
SHA_V2=$(sha256sum "$WORK/orbit-$V2" | cut -d' ' -f1)
SHA_V3=$(sha256sum "$WORK/orbit-$V3" | cut -d' ' -f1)
SHA_V4=$(sha256sum "$WORK/orbit-$V4" | cut -d' ' -f1)
(cd "$HERE/stubserver" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$WORK/stubserver" .) ||
  harness_fail "building the stub control plane failed"
docker build -q -t "$IMAGE" "$HERE" >/dev/null || harness_fail "building $IMAGE failed"

# --- the machine ---------------------------------------------------------------------------------

echo "==> starting $CTR"
docker run -d --name "$CTR" --label orbit-hostd-e2e=1 --network none \
  --cgroupns=private --security-opt writable-cgroups=true \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp "$IMAGE" >/dev/null ||
  harness_fail "cannot start the container (--security-opt writable-cgroups needs Docker 28 or newer)"
# Retried: right after `docker run` systemd may not be listening yet, and systemctl then fails at
# once instead of waiting; once it connects, --wait holds until the boot has finished.
state=""
system_up() {
  state=$(timeout 60 docker exec "$CTR" systemctl is-system-running --wait 2>/dev/null)
  [ "$state" = running ] || [ "$state" = degraded ]
}
wait_until 90 system_up || harness_fail "systemd in the container did not come up (state: '$state')"
[ "$state" = degraded ] && echo "    note: systemd is degraded: $(cx systemctl --failed --no-legend --plain | tr '\n' ';')"
echo "    $(cx systemctl --version | head -1), $(cx sh -c '. /etc/os-release; echo "$PRETTY_NAME"'), docker $(docker version --format '{{.Server.Version}}')"

cx mkdir -p /opt/orbit-e2e /srv/orbit-dl || harness_fail "mkdir in the container failed"
# docs: "Set up the machine once" — the machine's own binary, a regular file root owns and only root
# can write, in directories only root can write all the way up to / (as this image has them already).
docker cp -q "$WORK/orbit-$V1" "$CTR:$BIN" &&
  docker cp -q "$WORK/stubserver" "$CTR:/opt/orbit-e2e/stubserver" &&
  docker cp -q "$HERE/in-container.sh" "$CTR:/opt/orbit-e2e/in-container.sh" &&
  docker cp -q "$WORK/release-$V2" "$CTR:/opt/orbit-e2e/release-$V2" &&
  docker cp -q "$WORK/release-$V3" "$CTR:/opt/orbit-e2e/release-$V3" &&
  docker cp -q "$WORK/release-$V4" "$CTR:/opt/orbit-e2e/release-$V4" &&
  docker cp -q "$WORK/release-$V1/." "$CTR:/srv/orbit-dl/" ||
  harness_fail "copying into the container failed"
cx chown -R root:root "$BIN" /opt/orbit-e2e /srv/orbit-dl && cx chmod 0755 "$BIN" /opt/orbit-e2e/stubserver ||
  harness_fail "chown/chmod in the container failed"

# The stub publishes $V1 — the release setup installs — until step 6 publishes $V2.
cx systemd-run --quiet --unit=orbit-e2e-stub /opt/orbit-e2e/stubserver serve -addr "127.0.0.1:$PORT" -dl /srv/orbit-dl ||
  harness_fail "cannot start the stub control plane"
wait_until 20 cx /opt/orbit-e2e/stubserver get "$SERVER/dl/version.json" >/dev/null 2>&1 ||
  harness_fail "the stub control plane did not come up"
check_no_sudo "before setup"

# --- 1. root sets the machine up, once -----------------------------------------------------------

echo "==> 1. root: orbit host setup --server $SERVER"
# docs: "Set up the machine once" — `sudo orbit host setup --server <PUBLIC_ORIGIN>`.
out=$(cx orbit host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 1 "orbit host setup exited $rc"
sock=$(cx stat -c '%F %a %U' /run/orbit/host.sock 2>&1)
[ "$sock" = "socket 666 root" ] || fail 1 "/run/orbit/host.sock is '$sock', want a root-owned socket with mode 0666" orbit-hostd.socket
for f in "$TEMPLATE" /etc/systemd/system/orbit-hostd.socket /etc/systemd/system/orbit-hostd.service; do
  cx test -f "$f" || fail 1 "$f was not installed"
done
cx grep -qx 'User=%i' "$TEMPLATE" || fail 1 "$TEMPLATE does not run instances as User=%i"
cx grep -qx "ExecStart=$BIN run" "$TEMPLATE" || fail 1 "$TEMPLATE does not run $BIN"
[ "$(unit_prop orbit-hostd.socket ActiveState)" = active ] || fail 1 "orbit-hostd.socket is not active" orbit-hostd.socket
TEMPLATE_SHA=$(cx sha256sum "$TEMPLATE" | cut -d' ' -f1)
# docs: "Security model" — hostd brings up no runner for root: root's own registration is refused and
# taken by the legacy path, which runs a root runner and says so. Root unregisters it again.
out=$(csh "orbit register --server $SERVER --token e2e-enroll-root --name root-e2e --force </dev/null" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 1 "root's orbit register exited $rc"
grep -qxF "note: the machine broker refused \"enable\" (refusing to enable orbit-runner@0.service: the runner must not run as root — it would own every file its agents write and read root's own engine logins. Ask from the unprivileged account the runner should belong to instead.) — falling back to the sudo path." <<<"$out" ||
  fail 1 "hostd did not refuse to bring up a runner for root" orbit-hostd.service
grep -qF "Running as root — agents will have root access on this machine." <<<"$out" ||
  fail 1 "root's registration did not warn that its runner runs as root"
[ "$(unit_prop orbit-runner@0.service UnitFileState)" != enabled ] || fail 1 "orbit-runner@0.service is enabled" orbit-runner@0.service
[ "$(unit_prop orbit-runner-root.service User)" = root ] || fail 1 "the legacy path did not install orbit-runner-root.service" orbit-runner-root.service
out=$(csh "orbit unregister --yes </dev/null" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 1 "root's orbit unregister exited $rc"
[ "$(unit_prop orbit-runner-root.service LoadState)" = not-found ] ||
  fail 1 "orbit-runner-root.service is still there after root unregistered" orbit-runner-root.service
[ -z "$(csh "runner_pids 0")" ] || fail 1 "root still runs a runner after unregistering" orbit-runner-root.service
check_no_sudo "after setup"
pass 1 "orbit host setup (root) exit 0: /run/orbit/host.sock is a root-owned socket, mode 0666; orbit-runner@.service (User=%i, ExecStart=$BIN run), orbit-hostd.socket (active) and orbit-hostd.service installed; root's own orbit register refused by hostd (orbit-runner@0.service not enabled), taken by the legacy path with its root warning, then unregistered"

# --- 2. two accounts, and the unit alice's runner had before the broker existed ------------------

echo "==> 2. accounts alice and test.user; alice's legacy orbit-runner-alice.service"
cx useradd -m -s /bin/bash alice && cx useradd -m -s /bin/bash test.user || fail 2 "useradd failed"
ACCOUNTS=(alice test.user)
UID_A=$(cx id -u alice)
UID_T=$(cx id -u test.user)
UNIT_A="orbit-runner@$UID_A.service"
UNIT_T="orbit-runner@$UID_T.service"
# Before `orbit host setup`, alice registered the sudo way: a credential of hers, and a unit of
# her own that root wrote and started. Registering with --no-service writes the first; the unit is
# written here exactly as installSystemd rendered it.
out=$(as alice "orbit register --server $SERVER --token e2e-enroll-alice-legacy --name alice-legacy --no-service" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 2 "alice's pre-broker registration exited $rc"
install_legacy_unit alice orbit-runner-alice.service || fail 2 "cannot install orbit-runner-alice.service"
wait_until 15 unit_running orbit-runner-alice.service || fail 2 "orbit-runner-alice.service did not start" orbit-runner-alice.service
[ "$(unit_prop orbit-runner-alice.service User)" = alice ] || fail 2 "orbit-runner-alice.service does not run as User=alice"
legacy_pid=$(main_pid orbit-runner-alice.service)
[ "$(csh "euid $legacy_pid")" = "$UID_A" ] || fail 2 "orbit-runner-alice.service's process is not alice's"
# docs: "Set up the machine once" — the same command run without root changes nothing and says what
# to run instead.
out=$(as alice "orbit host setup --server $SERVER" 2>&1)
setup_rc=$?
show "$out"
[ "$setup_rc" -ne 0 ] || fail 2 "orbit host setup run by alice exited 0"
grep -qxF "orbit host: setup writes machine-wide systemd units and must run as root — re-run: sudo orbit host setup --server $SERVER" <<<"$out" ||
  fail 2 "orbit host setup run by alice did not say that it needs root and what to re-run"
[ "$(cx sha256sum "$TEMPLATE" | cut -d' ' -f1)" = "$TEMPLATE_SHA" ] || fail 2 "orbit host setup run by alice rewrote $TEMPLATE"
check_no_sudo "after creating the accounts"
pass 2 "accounts alice (uid $UID_A) and test.user (uid $UID_T) created; legacy /etc/systemd/system/orbit-runner-alice.service (User=alice) enabled and running (pid $legacy_pid, euid $UID_A); alice's own orbit host setup refused (exit $setup_rc, re-run with sudo) and $TEMPLATE unchanged"

# --- 2b. setup refuses a binary an account could change -------------------------------------------

echo "==> 2b. root: orbit host setup through a link into alice's ~/.orbit/bin, then under /usr/local root:staff 2775"
# What setup installs, as step 1 left it: a refused setup must not change a byte of it.
SETUP_FILES=("$TEMPLATE" /etc/systemd/system/orbit-hostd.socket /etc/systemd/system/orbit-hostd.service
  /usr/lib/tmpfiles.d/orbit-hostd.conf /etc/orbit/config.json)
setup_sums() { cx sha256sum "${SETUP_FILES[@]}"; }
sums=$(setup_sums) || harness_fail "cannot read the files setup installed"
# The layout install.sh leaves for an account that runs it: the account's own copy in its
# ~/.orbit/bin, and $BIN a link to that copy.
cx install -d -o alice -g alice /home/alice/.orbit/bin &&
  cx install -o alice -g alice -m 0755 "$BIN" /home/alice/.orbit/bin/orbit &&
  cx ln -sf /home/alice/.orbit/bin/orbit "$BIN" || harness_fail "cannot give alice the installer's layout"
# docs: "Set up the machine once" — setup refuses the file that link leads to, which alice can
# replace, and says how to put a root-owned copy in place.
out=$(cx orbit host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 1 ] || fail 2b "orbit host setup through the link into alice's home exited $rc, want 1"
grep -qxF "orbit host: refusing to set this host up with /home/alice/.orbit/bin/orbit: it belongs to uid $UID_A rather than root." <<<"$out" ||
  fail 2b "orbit host setup did not refuse the binary the link leads to as alice's"
grep -qxF "  sudo install -o root -g root -m 0755 /home/alice/.orbit/bin/orbit $BIN" <<<"$out" &&
  grep -qxF "  sudo $BIN host setup --server $SERVER" <<<"$out" ||
  fail 2b "orbit host setup did not say how to put a root-owned copy in place and set the host up from it"
[ "$(setup_sums)" = "$sums" ] || fail 2b "the refused orbit host setup changed the files setup installs"
cx grep -qx "ExecStart=$BIN run" "$TEMPLATE" && cx grep -qx "ExecStart=$BIN hostd" /etc/systemd/system/orbit-hostd.service ||
  fail 2b "the runner template and the hostd unit no longer run $BIN"
# docs: "Set up the machine once" — the root-owned copy in place of the link, then setup from it.
cx install -o root -g root -m 0755 /home/alice/.orbit/bin/orbit "$BIN" || fail 2b "installing the root-owned copy failed"
[ "$(cx stat -c '%F %U %a' "$BIN")" = "regular file root 755" ] && [ "$(cx sha256sum "$BIN" | cut -d' ' -f1)" = "$SHA_V1" ] ||
  fail 2b "$BIN is not a root-owned 0755 copy of the $V1 build after install"
[ "$(cx stat -c '%F %U %a' /home/alice/.orbit/bin/orbit)" = "regular file alice 755" ] || fail 2b "install changed alice's own copy"
out=$(cx "$BIN" host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 2b "orbit host setup from the root-owned copy exited $rc"
[ "$(setup_sums)" = "$sums" ] || fail 2b "orbit host setup from the root-owned copy did not install what step 1 did"
# Older Debian installs have /usr/local and /usr/local/bin root:staff 2775.
cx chgrp staff /usr/local /usr/local/bin && cx chmod 2775 /usr/local /usr/local/bin ||
  harness_fail "cannot make /usr/local and /usr/local/bin root:staff 2775"
# docs: "Set up the machine once" — refused too, naming every directory the staff group can write.
out=$(cx orbit host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 1 ] || fail 2b "orbit host setup under /usr/local and /usr/local/bin root:staff 2775 exited $rc, want 1"
grep -qxF "orbit host: refusing to set this host up with $BIN: its directory /usr/local/bin is not root's alone (owned by uid 0, mode 0775); /usr/local, a directory above it, is not root's alone (owned by uid 0, mode 0775)." <<<"$out" ||
  fail 2b "orbit host setup did not name both directories the staff group can write"
grep -qxF "  sudo chmod g-w /usr/local/bin /usr/local" <<<"$out" && grep -qxF "  sudo orbit host setup --server $SERVER" <<<"$out" ||
  fail 2b "orbit host setup did not say how to take the group's write access back"
[ "$(setup_sums)" = "$sums" ] || fail 2b "the refused orbit host setup changed the files setup installs"
# docs: "Set up the machine once" — `sudo chmod g-w /usr/local/bin /usr/local`, then setup again.
cx chmod g-w /usr/local/bin /usr/local || fail 2b "chmod g-w /usr/local/bin /usr/local failed"
dirs=$(cx stat -c '%n %U:%G %a' /usr/local/bin /usr/local | paste -sd, -)
out=$(cx orbit host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 2b "orbit host setup with $dirs exited $rc"
[ "$(setup_sums)" = "$sums" ] || fail 2b "orbit host setup after chmod g-w did not install what step 1 did"
# Back to the image's root:root 0755, so that 6b starts from the /usr/local/bin it always had; and
# alice's own copy goes, which check_machine_binary's "no account holds the shared binary" relies on.
cx chgrp root /usr/local /usr/local/bin && cx chmod g-s /usr/local /usr/local/bin &&
  cx rm /home/alice/.orbit/bin/orbit && cx rmdir /home/alice/.orbit/bin ||
  harness_fail "cannot put /usr/local and alice's home back as they were"
check_machine_binary 2b "$SHA_V1"
check_no_sudo "after setup's refusals"
pass 2b "orbit host setup run through $BIN, a link to alice's ~/.orbit/bin/orbit, refused (exit 1: it belongs to uid $UID_A rather than root) with the five files it installs unchanged; install -o root -g root -m 0755 replaced the link with a root-owned copy and setup from it exited 0; under /usr/local and /usr/local/bin root:staff 2775 refused (exit 1, both directories named), then chmod g-w /usr/local/bin /usr/local ($dirs) and setup exited 0; the runner template and hostd unit ran $BIN throughout"

# --- 3. alice registers, without root ------------------------------------------------------------

echo "==> 3. alice: orbit register (enrollment token, non-interactive, --proxy)"
# docs: "Migrating from per-user units" — the account's next registration retires its legacy unit.
# docs: "Known limitations" — and --proxy, which the shared template does not carry.
out=$(as alice "orbit register --server $SERVER --token e2e-enroll-alice --name alice-e2e --force --proxy $PROXY" 2>&1)
rc=$?
show "$out"
check_user_command 3 "$out" "$rc" "Background service started as alice"
grep -qxF "note: --proxy is not carried into $UNIT_A — the machine's shared runner template has no per-user proxy environment." <<<"$out" ||
  fail 3 "the registration did not warn that --proxy is not carried into $UNIT_A"
wait_until 30 unit_running "$UNIT_A" || fail 3 "$UNIT_A is not active" "$UNIT_A" orbit-runner-alice.service
env_a=$(unit_prop "$UNIT_A" Environment)
[ -z "$env_a" ] || fail 3 "$UNIT_A runs with Environment=$env_a; the shared template sets none" "$UNIT_A"
[ "$(unit_prop "$UNIT_A" UnitFileState)" = enabled ] || fail 3 "$UNIT_A is not enabled" "$UNIT_A"
PID_A=$(main_pid "$UNIT_A")
[ "$(csh "euid $PID_A")" = "$UID_A" ] || fail 3 "$UNIT_A's main process $PID_A runs with euid $(csh "euid $PID_A"), want $UID_A" "$UNIT_A"
cx test ! -e /etc/systemd/system/orbit-runner-alice.service || fail 3 "the legacy unit file is still there" orbit-runner-alice.service
cx test ! -e /etc/systemd/system/multi-user.target.wants/orbit-runner-alice.service ||
  fail 3 "the legacy unit is still wanted by multi-user.target"
[ "$(unit_prop orbit-runner-alice.service LoadState)" = not-found ] ||
  fail 3 "orbit-runner-alice.service is still known to systemd" orbit-runner-alice.service
check_one_runner 3 "$UID_A" "$UNIT_A"
check_machine_binary 3 "$SHA_V1"
check_no_sudo "after alice registered"
pass 3 "alice: orbit register exit 0 without root; $UNIT_A enabled and active, main process $PID_A euid $UID_A (alice); legacy orbit-runner-alice.service stopped, its unit file removed, unknown to systemd; alice runs exactly one runner; $BIN still the root-owned machine binary; --proxy reported as not carried, and $UNIT_A runs with no proxy environment"

# --- 4. test.user registers too ------------------------------------------------------------------

echo "==> 4. test.user: orbit register (browser approval, approved by the stub)"
# docs: "Register each account's runner" — `orbit register --server <PUBLIC_ORIGIN> --name <name>`.
out=$(as test.user "orbit register --server $SERVER --name test-user-e2e" 2>&1)
rc=$?
show "$out"
check_user_command 4 "$out" "$rc" "Background service started as test.user"
wait_until 30 unit_running "$UNIT_T" || fail 4 "$UNIT_T is not active" "$UNIT_T"
[ "$(unit_prop "$UNIT_T" UnitFileState)" = enabled ] || fail 4 "$UNIT_T is not enabled" "$UNIT_T"
PID_T=$(main_pid "$UNIT_T")
[ "$(csh "euid $PID_T")" = "$UID_T" ] || fail 4 "$UNIT_T's main process $PID_T runs with euid $(csh "euid $PID_T"), want $UID_T" "$UNIT_T"
unit_running "$UNIT_A" && [ "$(main_pid "$UNIT_A")" = "$PID_A" ] ||
  fail 4 "alice's runner did not stay up untouched while test.user registered" "$UNIT_A"
[ "$(csh "unit_of $PID_A")" = "$UNIT_A" ] && [ "$(csh "unit_of $PID_T")" = "$UNIT_T" ] ||
  fail 4 "the runners do not each live in their own instance's cgroup" "$UNIT_A" "$UNIT_T"
check_one_runner 4 "$UID_T" "$UNIT_T"
# The dotted name needs no escaping because nothing is named after it: no orbit-runner-<name> unit.
named=$(csh 'compgen -G "/etc/systemd/system/orbit-runner-*.service"')
[ -z "$named" ] || fail 4 "username-keyed unit files exist beside the uid instances: $named"
ID_A=$(cx sed -n 's/.*"runnerId": *"\([^"]*\)".*/\1/p' /home/alice/.orbit/config.json)
ID_T=$(cx sed -n 's/.*"runnerId": *"\([^"]*\)".*/\1/p' /home/test.user/.orbit/config.json)
[ -n "$ID_A" ] && [ -n "$ID_T" ] && [ "$ID_A" != "$ID_T" ] ||
  fail 4 "the two accounts do not hold separate runner credentials ('$ID_A', '$ID_T')"
# docs: "Register each account's runner" — the receipt's next step and, right under it, this
# runner's new-session page. The id is the one test.user's config.json holds: the CLI writes a UUID
# in base62, as the docs show, and leaves the stub's ids, which are not UUIDs, as they are.
next_step="    Next     Start a session"$'\n'"             $SERVER/runners/$ID_T/new"
[ "$(grep -xF -A1 -- "    Next     Start a session" <<<"$out")" = "$next_step" ] ||
  fail 4 "the command did not end with the next step the docs show: '    Next     Start a session', then '             $SERVER/runners/$ID_T/new'"
# Independent heartbeats: each runner beats the stub with its own credential (first beat at ~30s).
wait_until 60 beats_since alice-e2e 0 && wait_until 60 beats_since test-user-e2e 0 ||
  fail 4 "the stub did not see both runners heartbeat" "$UNIT_A" "$UNIT_T"
# docs: "Register each account's runner" — the account's own status and log, without root.
out=$(as test.user 'systemctl status orbit-runner@$(id -u)' 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 4 "test.user's systemctl status orbit-runner@\$(id -u) exited $rc" "$UNIT_T"
grep -qF "$UNIT_T - Orbit runner (uid $UID_T)" <<<"$out" && grep -qF "Active: active (running)" <<<"$out" ||
  fail 4 "test.user's systemctl status orbit-runner@\$(id -u) does not show $UNIT_T active (running)" "$UNIT_T"
wait_until 15 own_journal_has test.user "runner \"test-user-e2e\" online -> $SERVER" ||
  fail 4 "test.user's journalctl -u orbit-runner@\$(id -u) does not show its runner coming online" "$UNIT_T"
check_machine_binary 4 "$SHA_V1"
check_no_sudo "after test.user registered"
pass 4 "test.user: orbit register exit 0 without root; $UNIT_T (uid-keyed, no escaping of 'test.user') enabled and active as euid $UID_T beside $UNIT_A — separate processes ($PID_A, $PID_T) in separate cgroups, separate credentials ($ID_A, $ID_T), each heartbeating the control plane on its own; test.user reads its runner's status (active (running)) and log itself"

# --- 5. kill -9 --------------------------------------------------------------------------------

echo "==> 5. kill -9 alice's runner ($PID_A)"
# docs: "Set up the machine once" — the template's Restart=always.
t0=$SECONDS
csh "kill -9 $PID_A" || fail 5 "cannot kill $PID_A" "$UNIT_A"
wait_until 15 restarted "$UNIT_A" "$PID_A" || fail 5 "$UNIT_A was not active again within 15s of kill -9" "$UNIT_A"
took=$((SECONDS - t0))
old_a=$PID_A
PID_A=$(main_pid "$UNIT_A")
[ "$(csh "euid $PID_A")" = "$UID_A" ] || fail 5 "the restarted runner runs with euid $(csh "euid $PID_A"), want $UID_A" "$UNIT_A"
restarts=$(unit_prop "$UNIT_A" NRestarts)
[ "$restarts" -ge 1 ] 2>/dev/null || fail 5 "systemd reports NRestarts=$restarts" "$UNIT_A"
unit_running "$UNIT_T" && [ "$(main_pid "$UNIT_T")" = "$PID_T" ] || fail 5 "test.user's runner was disturbed" "$UNIT_T"
check_no_sudo "after kill -9"
pass 5 "kill -9 of alice's runner (pid $old_a): $UNIT_A active again after ${took}s (Restart=always; new pid $PID_A, euid $UID_A, NRestarts=$restarts); $UNIT_T untouched (pid $PID_T)"

# --- 6. the central update -----------------------------------------------------------------------

echo "==> 6. the stub publishes $V2; the runners delegate the update to hostd"
# docs: "Updates" — hostd installs the release once for the machine and restarts every instance.
# docs: "Security model" — the witness that the download is never executed as root (stubserver/execwatch.go).
cx systemd-run --quiet --unit=orbit-e2e-execwatch /opt/orbit-e2e/stubserver execwatch \
  -prefix "$BIN.new-" -out /var/log/orbit-e2e-execwatch.log || harness_fail "cannot start the exec watcher"
pre_a=$PID_A
pre_t=$PID_T
publish "$V2"
wait_until 150 machine_version_is "$V2" ||
  fail 6 "$BIN --version is still $(cx "$BIN" --version) 150s after $V2 was published" orbit-hostd.service "$UNIT_A" "$UNIT_T"
wait_until 90 restarted "$UNIT_A" "$pre_a" && wait_until 90 restarted "$UNIT_T" "$pre_t" ||
  fail 6 "the runner instances were not restarted onto $V2" orbit-hostd.service "$UNIT_A" "$UNIT_T"
PID_A=$(main_pid "$UNIT_A")
PID_T=$(main_pid "$UNIT_T")
[ "$(csh "euid $PID_A")" = "$UID_A" ] && [ "$(csh "euid $PID_T")" = "$UID_T" ] ||
  fail 6 "a restarted runner runs under the wrong account" "$UNIT_A" "$UNIT_T"
wait_until 60 reports_version alice-e2e "$V2" && wait_until 60 reports_version test-user-e2e "$V2" ||
  fail 6 "the runners do not heartbeat $V2 after the update" "$UNIT_A" "$UNIT_T"
cx systemctl stop orbit-e2e-execwatch.service
check_machine_binary 6 "$SHA_V2"
# docs: "Updates" — what hostd's journal and the asking runner's say.
installed=$(cx journalctl -u orbit-hostd.service -o cat --no-pager | grep -F "installed orbit $V2 at $BIN (verified as uid ")
verifier=$(sed -n 's/.*(verified as uid \([0-9]*\)).*/\1/p' <<<"$installed" | head -1)
[ "$verifier" = "$UID_A" ] || [ "$verifier" = "$UID_T" ] ||
  fail 6 "hostd's journal does not say it verified $V2 as one of the accounts: '$installed'" orbit-hostd.service
delegated=""
for u in "$UNIT_A" "$UNIT_T"; do
  cx journalctl -u "$u" -o cat --no-pager | grep -qF "delegated to the host broker at /run/orbit/host.sock: it is installing orbit $V2" &&
    delegated="$delegated $u"
done
[ -n "$delegated" ] || fail 6 "no runner logged delegating the update to the host broker" "$UNIT_A" "$UNIT_T"
execs=$(cx cat /var/log/orbit-e2e-execwatch.log 2>/dev/null)
show "$execs"
[ -n "$execs" ] || fail 6 "the watcher saw no execution of the download, so it cannot vouch it never ran as root"
grep -vq "uids=$verifier,$verifier,$verifier,$verifier " <<<"$execs" &&
  fail 6 "the download was executed under some uid other than $verifier: $(tr '\n' ' ' <<<"$execs")"
check_no_sudo "after the update"
pass 6 "stub published $V2 → delegated by${delegated} → hostd installed it: $BIN --version = $V2 (root-owned regular file, sha256 of the $V2 build); $UNIT_A (pid $pre_a → $PID_A) and $UNIT_T (pid $pre_t → $PID_T) restarted, active, heartbeating $V2; the download was executed $(wc -l <<<"$execs") time(s), every time as uid $verifier, never as root"

# --- 6b. a binary directory the staff group can write --------------------------------------------

echo "==> 6b. /usr/local/bin made root:staff 2775, as older Debian installs have it; the stub publishes $V3"
# docs: "Known limitations" — hostd replaces the machine's binary only in a directory root alone can
# write, and refuses this one.
cx chgrp staff /usr/local/bin && cx chmod 2775 /usr/local/bin || harness_fail "cannot make /usr/local/bin root:staff 2775"
# hostd runs one update per five minutes and step 6's has just run: the stamp it keeps for that goes,
# standing in for the wait.
cx rm -f /run/orbit/last-update || harness_fail "cannot remove hostd's update stamp"
pre_a=$PID_A
pre_t=$PID_T
publish "$V3"
refusal="orbit $V3 available for /usr/local/bin, which only the host can replace; delegated to the host broker at /run/orbit/host.sock: it declined: refusing to update $BIN: its directory /usr/local/bin is not root's alone (owned by uid 0, mode 0775), and root writes nothing it downloaded where another account can reach"
wait_until 90 runner_logged "$refusal" ||
  fail 6b "no runner logged hostd refusing $V3 for the group-writable /usr/local/bin" orbit-hostd.service "$UNIT_A" "$UNIT_T"
machine_version_is "$V2" || fail 6b "$BIN is now $(cx "$BIN" --version); hostd must leave $V2 in place" orbit-hostd.service
[ "$(main_pid "$UNIT_A")" = "$pre_a" ] && [ "$(main_pid "$UNIT_T")" = "$pre_t" ] ||
  fail 6b "a runner instance restarted although nothing was installed" "$UNIT_A" "$UNIT_T"
# docs: "Known limitations" — one way out: root installs each release, `sudo orbit upgrade`, which
# replaces the shared binary where it is and restarts no instance...
out=$(cx orbit upgrade 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 6b "orbit upgrade (root) exited $rc"
grep -qxF "note: $BIN is run by services of more than one account (/etc/systemd/system/orbit-hostd.service as root, $TEMPLATE as %i), so it stays where it is." <<<"$out" ||
  fail 6b "orbit upgrade (root) did not say that the shared binary stays where it is"
grep -qxF "✓ orbit is now $V3" <<<"$out" || fail 6b "orbit upgrade (root) did not report $V3 installed"
machine_version_is "$V3" || fail 6b "$BIN is $(cx "$BIN" --version) after orbit upgrade, want $V3"
# "stays where it is": still the machine's file, now the $V3 build, moved into no account's home.
check_machine_binary 6b "$SHA_V3"
[ "$(main_pid "$UNIT_A")" = "$pre_a" ] && [ "$(main_pid "$UNIT_T")" = "$pre_t" ] ||
  fail 6b "orbit upgrade restarted a runner instance" "$UNIT_A" "$UNIT_T"
# ...so the instances are restarted onto it: `sudo systemctl restart 'orbit-runner@*'`.
cx systemctl restart 'orbit-runner@*' || fail 6b "systemctl restart 'orbit-runner@*' failed" "$UNIT_A" "$UNIT_T"
wait_until 30 restarted "$UNIT_A" "$pre_a" && wait_until 30 restarted "$UNIT_T" "$pre_t" ||
  fail 6b "the runner instances did not come back after systemctl restart" "$UNIT_A" "$UNIT_T"
wait_until 60 reports_version alice-e2e "$V3" && wait_until 60 reports_version test-user-e2e "$V3" ||
  fail 6b "the runners do not heartbeat $V3 after the restart" "$UNIT_A" "$UNIT_T"
mid_a=$(main_pid "$UNIT_A")
mid_t=$(main_pid "$UNIT_T")
# docs: "Known limitations" — the other way out: the directory made root's alone, `sudo chmod g-w
# /usr/local/bin`, after which hostd installs the next release itself.
cx chmod g-w /usr/local/bin || harness_fail "chmod g-w /usr/local/bin failed"
dir=$(cx stat -c '%U:%G %a' /usr/local/bin)
publish "$V4"
wait_until 150 machine_version_is "$V4" ||
  fail 6b "$BIN --version is still $(cx "$BIN" --version) 150s after $V4 was published, with /usr/local/bin $dir" orbit-hostd.service "$UNIT_A" "$UNIT_T"
wait_until 90 restarted "$UNIT_A" "$mid_a" && wait_until 90 restarted "$UNIT_T" "$mid_t" ||
  fail 6b "the runner instances were not restarted onto $V4" orbit-hostd.service "$UNIT_A" "$UNIT_T"
wait_until 60 reports_version alice-e2e "$V4" && wait_until 60 reports_version test-user-e2e "$V4" ||
  fail 6b "the runners do not heartbeat $V4 after the update" "$UNIT_A" "$UNIT_T"
cx journalctl -u orbit-hostd.service -o cat --no-pager | grep -qF "installed orbit $V4 at $BIN (verified as uid " ||
  fail 6b "hostd's journal does not say it installed $V4" orbit-hostd.service
PID_A=$(main_pid "$UNIT_A")
PID_T=$(main_pid "$UNIT_T")
check_machine_binary 6b "$SHA_V4"
check_no_sudo "after the staff-writable directory"
pass 6b "/usr/local/bin root:staff 2775: hostd refused $V3 (not root's alone, mode 0775) and nothing changed; root's orbit upgrade put $V3 in place and restarted no instance, systemctl restart 'orbit-runner@*' moved both onto it; with /usr/local/bin made root's alone ($dir), hostd installed $V4 itself and restarted both ($mid_a → $PID_A, $mid_t → $PID_T)"

# --- 7. alice unregisters ------------------------------------------------------------------------

echo "==> 7. alice: orbit unregister"
beats_t=$(stub_field test-user-e2e 4)
# docs: "Register each account's runner" — `orbit unregister --yes`.
out=$(as alice "orbit unregister --yes" 2>&1)
rc=$?
show "$out"
check_user_command 7 "$out" "$rc" "removed the $UNIT_A runner service"
[ "$(unit_prop "$UNIT_A" UnitFileState)" = disabled ] || fail 7 "$UNIT_A is $(unit_prop "$UNIT_A" UnitFileState), want disabled" "$UNIT_A"
[ "$(unit_prop "$UNIT_A" ActiveState)" = inactive ] || fail 7 "$UNIT_A is $(unit_prop "$UNIT_A" ActiveState), want inactive" "$UNIT_A"
[ -z "$(csh "runner_pids $UID_A")" ] || fail 7 "alice still runs a runner" "$UNIT_A"
[ "$(stub_field alice-e2e 3)" = deleted ] || fail 7 "alice's runner was not deleted from the control plane"
unit_running "$UNIT_T" && [ "$(main_pid "$UNIT_T")" = "$PID_T" ] || fail 7 "test.user's runner did not stay up untouched" "$UNIT_T"
wait_until 45 beats_since test-user-e2e "$beats_t" || fail 7 "test.user's runner stopped heartbeating" "$UNIT_T"
check_machine_binary 7 "$SHA_V4"
check_no_sudo "after alice unregistered"
pass 7 "alice: orbit unregister exit 0 without root; $UNIT_A disabled and inactive, no runner left for uid $UID_A, alice-e2e deleted from the control plane; $UNIT_T untouched (pid $PID_T, still active and heartbeating)"

# --- 8. test.user unregisters past a legacy unit (T9) --------------------------------------------

echo "==> 8. test.user: legacy orbit-runner-test_user.service, then orbit unregister"
install_legacy_unit test.user orbit-runner-test_user.service || fail 8 "cannot install orbit-runner-test_user.service"
wait_until 15 unit_running orbit-runner-test_user.service || fail 8 "orbit-runner-test_user.service did not start" orbit-runner-test_user.service
[ "$(unit_prop orbit-runner-test_user.service User)" = test.user ] || fail 8 "orbit-runner-test_user.service does not run as User=test.user"
legacy_pid=$(main_pid orbit-runner-test_user.service)
# docs: "Migrating from per-user units" — unregistering takes the account's legacy unit down too.
out=$(as test.user "orbit unregister --yes" 2>&1)
rc=$?
show "$out"
check_user_command 8 "$out" "$rc" "removed the $UNIT_T runner service"
[ "$(unit_prop "$UNIT_T" UnitFileState)" = disabled ] || fail 8 "$UNIT_T is $(unit_prop "$UNIT_T" UnitFileState), want disabled" "$UNIT_T"
[ "$(unit_prop "$UNIT_T" ActiveState)" = inactive ] || fail 8 "$UNIT_T is $(unit_prop "$UNIT_T" ActiveState), want inactive" "$UNIT_T"
cx test ! -e /etc/systemd/system/orbit-runner-test_user.service ||
  fail 8 "the legacy unit file is still there" orbit-runner-test_user.service
cx test ! -e /etc/systemd/system/multi-user.target.wants/orbit-runner-test_user.service ||
  fail 8 "the legacy unit is still wanted by multi-user.target"
[ "$(unit_prop orbit-runner-test_user.service LoadState)" = not-found ] ||
  fail 8 "orbit-runner-test_user.service is still known to systemd" orbit-runner-test_user.service
[ -z "$(csh "runner_pids $UID_T")" ] || fail 8 "test.user still runs a runner" "$UNIT_T" orbit-runner-test_user.service
[ "$(stub_field test-user-e2e 3)" = deleted ] || fail 8 "test.user's runner was not deleted from the control plane"
check_machine_binary 8 "$SHA_V4"
check_no_sudo "after test.user unregistered"
pass 8 "test.user: orbit unregister exit 0 without root; $UNIT_T disabled and inactive; legacy orbit-runner-test_user.service (User=test.user, running as pid $legacy_pid) stopped, its unit file removed and the unit gone from systemd; no runner left for uid $UID_T"

# --- 9. no sudo, throughout ----------------------------------------------------------------------

pass 9 "no sudo anywhere: absent from the image and from root's, alice's and test.user's PATH at all $SUDO_CHECKS checkpoints from before setup to the last unregister, and no register or unregister by alice or test.user fell back to the sudo path"
echo "==> all 11 assertions passed"
