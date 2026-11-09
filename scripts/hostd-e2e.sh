#!/usr/bin/env bash
# End-to-end acceptance for multi-user runners without root (orbit-hostd + orbit-runner@<user>).
#
# On a real systemd, in a throwaway container that has no sudo at all, root installs orbit with
# src/web/public/install.sh, which puts it in root's own home, sees `orbit host setup` refuse that
# copy, puts the machine's copy in place and runs setup from it, once. From then on three ordinary
# accounts — one with a dot in its name, one with a dash, which systemd escapes — register, which
# puts each account's own copy of orbit in place (the dashed one installs it first with install.sh,
# as itself), survive a kill -9, each update its own copy and unregister, none of it as root; hostd's
# own binary follows each release. Each account's runner is the instance orbit-runner@<user name, as
# systemd-escape prints it>, running that account's own ~/.orbit/bin/orbit. Then, in a second
# container from the same image, a host set up by the previous release (orbit built from
# 64bfd1673, whose runners are orbit-runner@<uid> on the machine's binary) is moved by putting this
# tree's binary in place and running setup again.
#
#   bash scripts/hostd-e2e.sh
#
# Prints one PASS or FAIL line per assertion:
#    0 setup refusing root's own copy, which is not the machine's
#    1 setup
#    2 accounts and a legacy unit
#    3 setup refusing a binary an account could change
#    4 alice registers, past a legacy unit that first refuses to stop
#    5 test.user registers
#    6 test-user installs with install.sh and registers (orbit-runner@test\x2duser)
#    7 kill -9 of alice's and test-user's runners
#    8 a published release: each runner updates its own copy (exe, version), hostd its own binary
#      (the file orbit-hostd.service names), no runner restarted, the download never run as root
#    9 hostd refusing a binary directory the staff group can write, then the next release
#   10 alice unregisters
#   11 test.user unregisters past a legacy unit
#   12 test-user unregisters
#   13 the move: a host set up by the previous release, setup run again, one runner per account at
#      every sample, the account it left listed with its command, which then moves it too
#   14 no sudo throughout
# The first FAIL prints systemctl status and the journal of the units involved and exits 1; a
# harness problem (no docker, a failed build) exits 2.
#
# It is also what keeps docs/self-hosting.md "Multi-user Linux machines" and section G of
# docs/runner-troubleshooting.md ("A machine set up with `orbit host setup`") true: every command
# they show is run here, under a "# docs:" comment naming the heading it comes from, with the same
# arguments and the same orbit-runner@<user> unit names. Root runs the section's sudo commands
# itself, since this machine has no sudo (assertion 14).
#
# Needs docker — 28 or newer, for --security-opt writable-cgroups — a Go toolchain, and this
# repository's history back to 64bfd1673. Builds orbit five times (the release root installs and sets
# the machine up from, the three the stub control plane publishes as updates, and 64bfd1673's), the
# stub control plane (scripts/hostd-e2e/stubserver) and the image (scripts/hostd-e2e/Dockerfile).
# The containers are not privileged — under --privileged their systemd would apply its sysctl and
# udev defaults to the host — and have no network, so nothing in them can reach a real control plane.
#
# HOSTD_E2E_KEEP=1 leaves the containers running afterwards for inspection.

set -uo pipefail # not -e: every check below is explicit, so that a failure can say what failed

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/runner-go"
HERE="$ROOT/scripts/hostd-e2e"
IMAGE="orbit-hostd-e2e:bookworm"
PORT=18080
SERVER="http://127.0.0.1:$PORT"
V1="0.1.900" # installed by `orbit host setup`
V2="0.1.901" # published by the stub as the update
V3="0.1.902" # published while /usr/local/bin is root:staff 2775
V4="0.1.903" # published once /usr/local/bin is root's alone again
# The previous release's layout (13): orbit as main was when this layout was planned, which writes
# the uid template (orbit-runner@<uid>, User=%i, ExecStart=/usr/local/bin/orbit run).
OLD_REV="64bfd1673"
V0="0.1.899"
PROXY="http://proxy.example.com:3128" # alice's --proxy, which the shared template cannot carry
BIN="/usr/local/bin/orbit"
HOME_COPY="/root/.orbit/bin/orbit" # root's own copy, where install.sh puts it (step 0)
TEMPLATE="/etc/systemd/system/orbit-runner@.service"
# The template's ExecStart: each instance runs its account's own copy, $HOME left for the shell.
EXEC_START="ExecStart=/bin/sh -c 'exec \"\$HOME/.orbit/bin/orbit\" run'"
# The five files `orbit host setup` installs.
SETUP_FILES=("$TEMPLATE" /etc/systemd/system/orbit-hostd.socket /etc/systemd/system/orbit-hostd.service
  /usr/lib/tmpfiles.d/orbit-hostd.conf /etc/orbit/config.json)
CTR=""
CTRS=() # every container started, for cleanup
WORK=""
ACCOUNTS=()
SUDO_CHECKS=0

harness_fail() {
  echo "HARNESS ERROR: $*" >&2
  exit 2
}

cleanup() {
  local rc=$?
  if [ ${#CTRS[@]} -gt 0 ]; then
    if [ -n "${HOSTD_E2E_KEEP:-}" ]; then
      echo "containers ${CTRS[*]} left running (HOSTD_E2E_KEEP) — remove them with: docker rm -f ${CTRS[*]}"
    else
      docker rm -f "${CTRS[@]}" >/dev/null 2>&1
    fi
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
# own_copy_is ACCOUNT SHA256 — ACCOUNT's own ~/.orbit/bin/orbit is a regular file of that account's
# holding the build with SHA256.
own_copy_is() {
  [ "$(cx stat -c '%F %U' "/home/$1/.orbit/bin/orbit")" = "regular file $1" ] &&
    [ "$(cx sha256sum "/home/$1/.orbit/bin/orbit" | cut -d' ' -f1)" = "$2" ]
}
# own_journal_has ACCOUNT TEXT — ACCOUNT's own `journalctl -u "orbit-runner@$(systemd-escape "$(id -un)")"`,
# run as that account, shows a line containing TEXT.
own_journal_has() { as "$1" 'journalctl -u "orbit-runner@$(systemd-escape "$(id -un)")"' 2>/dev/null | grep -qF -- "$2"; }
# runner_logged TEXT — one of the three runner instances has logged a line containing TEXT.
runner_logged() {
  local u
  for u in "$UNIT_A" "$UNIT_T" "$UNIT_D"; do
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

# check_no_sudo WHEN — assertion 14, re-checked after every step: sudo is neither installed nor
# on root's or any account's PATH.
check_no_sudo() {
  csh has_sudo && fail 14 "sudo is present in the container ($1)"
  local acct
  for acct in "${ACCOUNTS[@]}"; do
    as "$acct" 'command -v sudo' >/dev/null 2>&1 && fail 14 "sudo resolves on $acct's PATH ($1)"
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

# check_machine_binary N SHA256 — the machine binary hostd runs is still the machine's: a
# root-owned 0755 regular file holding the release expected, not replaced by a link into an
# account's ~/.orbit/bin, and the runner template is as setup wrote it.
check_machine_binary() {
  local st sha
  st=$(cx stat -c '%F %U %a' "$BIN")
  [ "$st" = "regular file root 755" ] ||
    fail "$1" "$BIN is now '$st'; it must stay the machine's root-owned 0755 regular file"
  sha=$(cx sha256sum "$BIN" | cut -d' ' -f1)
  [ "$sha" = "$2" ] || fail "$1" "$BIN has sha256 $sha, want $2"
  [ "$(cx sha256sum "$TEMPLATE" | cut -d' ' -f1)" = "$TEMPLATE_SHA" ] ||
    fail "$1" "$TEMPLATE was rewritten after setup"
}

# check_own_runner N ACCOUNT UID UNIT — UNIT's main process runs as ACCOUNT (euid UID) from
# ACCOUNT's own ~/.orbit/bin/orbit, as /proc/<pid>/exe names it.
check_own_runner() {
  local pid
  pid=$(main_pid "$4")
  [ "$(csh "euid $pid")" = "$3" ] || fail "$1" "$4's main process $pid runs with euid $(csh "euid $pid"), want $3" "$4"
  [ "$(csh "exe $pid")" = "/home/$2/.orbit/bin/orbit" ] ||
    fail "$1" "$4's main process $pid runs $(csh "exe $pid"), want $2's own /home/$2/.orbit/bin/orbit" "$4"
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
echo "==> building orbit $V1, $V2, $V3 and $V4 (linux/amd64), orbit $V0 from $OLD_REV, the stub control plane and $IMAGE"
for v in "$V1" "$V2" "$V3" "$V4"; do
  # defaultServer is the stub, as a deployment's own download defaults to its PUBLIC_ORIGIN: root's
  # `orbit upgrade` in 8 has no runner config to name a server.
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
# The previous release, from its own tree: runner-go as it was at $OLD_REV, built the same way.
git -C "$ROOT" cat-file -e "$OLD_REV^{commit}" 2>/dev/null ||
  harness_fail "commit $OLD_REV is not in this clone (git fetch --unshallow, or fetch it)"
mkdir -p "$WORK/old" && git -C "$ROOT" archive "$OLD_REV" src/runner-go | tar -x -C "$WORK/old" ||
  harness_fail "cannot check out src/runner-go at $OLD_REV"
(cd "$WORK/old/src/runner-go" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -ldflags "-s -w -X main.version=$V0 -X main.sourceSHA=$OLD_REV -X main.defaultServer=$SERVER" -o "$WORK/orbit-$V0" .) ||
  harness_fail "building orbit $V0 from $OLD_REV failed"
SHA_V0=$(sha256sum "$WORK/orbit-$V0" | cut -d' ' -f1)
(cd "$HERE/stubserver" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$WORK/stubserver" .) ||
  harness_fail "building the stub control plane failed"
docker build -q -t "$IMAGE" "$HERE" >/dev/null || harness_fail "building $IMAGE failed"

# --- the machine ---------------------------------------------------------------------------------

# start_machine — a new container from $IMAGE, as CTR, with systemd up, the stub control plane's
# binary and in-container.sh in /opt/orbit-e2e, and an empty /srv/orbit-dl for it to serve.
start_machine() {
  CTR="orbit-hostd-e2e-$$-$RANDOM"
  echo "==> starting $CTR"
  docker run -d --name "$CTR" --label orbit-hostd-e2e=1 --network none \
    --cgroupns=private --security-opt writable-cgroups=true \
    --tmpfs /run --tmpfs /run/lock --tmpfs /tmp "$IMAGE" >/dev/null ||
    harness_fail "cannot start the container (--security-opt writable-cgroups needs Docker 28 or newer)"
  CTRS+=("$CTR")
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
  docker cp -q "$WORK/stubserver" "$CTR:/opt/orbit-e2e/stubserver" &&
    docker cp -q "$HERE/in-container.sh" "$CTR:/opt/orbit-e2e/in-container.sh" ||
    harness_fail "copying into the container failed"
  cx chown -R root:root /opt/orbit-e2e && cx chmod 0755 /opt/orbit-e2e/stubserver ||
    harness_fail "chown/chmod in the container failed"
}

# start_stub — the stub control plane, serving /srv/orbit-dl as its /dl.
start_stub() {
  cx systemd-run --quiet --unit=orbit-e2e-stub /opt/orbit-e2e/stubserver serve -addr "127.0.0.1:$PORT" -dl /srv/orbit-dl ||
    harness_fail "cannot start the stub control plane"
  wait_until 20 cx /opt/orbit-e2e/stubserver get "$SERVER/stub/runners" >/dev/null 2>&1 ||
    harness_fail "the stub control plane did not come up"
}

start_machine
docker cp -q "$WORK/release-$V2" "$CTR:/opt/orbit-e2e/release-$V2" &&
  docker cp -q "$WORK/release-$V3" "$CTR:/opt/orbit-e2e/release-$V3" &&
  docker cp -q "$WORK/release-$V4" "$CTR:/opt/orbit-e2e/release-$V4" &&
  docker cp -q "$WORK/release-$V1/." "$CTR:/srv/orbit-dl/" ||
  harness_fail "copying into the container failed"
cx chown -R root:root /opt/orbit-e2e /srv/orbit-dl && cx chmod 0755 /opt/orbit-e2e/stubserver ||
  harness_fail "chown/chmod in the container failed"

# The stub publishes $V1 — the release install.sh downloads in steps 0 and 6 — until step 8
# publishes $V2.
start_stub
wait_until 20 cx /opt/orbit-e2e/stubserver get "$SERVER/dl/version.json" >/dev/null 2>&1 ||
  harness_fail "the stub control plane does not serve $V1"
check_no_sudo "before setup"

# --- 0. root installs orbit the default way, and setup refuses that copy -------------------------

echo "==> 0. root: install.sh the default way (ORBIT_NO_REGISTER=1), then $HOME_COPY host setup --server $SERVER"
# install.sh downloads with `curl -fsSL URL -o FILE`, and this image has no curl: for that one run, a
# stand-in first on its PATH fetches URL with the stub's own client.
docker exec -i "$CTR" sh -c 'mkdir -p /opt/orbit-e2e/curl && cat >/opt/orbit-e2e/curl/curl && chmod 0755 /opt/orbit-e2e/curl/curl' <<'EOF' || harness_fail "cannot put the curl stand-in in place"
#!/bin/sh
[ "$#" -eq 4 ] && [ "$1" = -fsSL ] && [ "$3" = -o ] || { echo "curl stand-in: unexpected call: curl $*" >&2; exit 2; }
exec /opt/orbit-e2e/stubserver get "$2" >"$4"
EOF
# docs: "Set up the machine once" — install.sh, run by root the default way (`curl … | bash`), installs
# into root's own home and puts no machine's copy in place.
out=$(docker exec -i "$CTR" env ORBIT_NO_REGISTER=1 ORBIT_BASE_URL="$SERVER" \
  PATH="/opt/orbit-e2e/curl:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" bash <"$ROOT/src/web/public/install.sh" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 0 "install.sh run by root exited $rc"
grep -qxF "✓ Orbit $V1 installed to $HOME_COPY" <<<"$out" || fail 0 "install.sh did not report orbit $V1 installed to $HOME_COPY"
[ "$(cx stat -c '%F %U' "$HOME_COPY")" = "regular file root" ] && [ "$(cx sha256sum "$HOME_COPY" | cut -d' ' -f1)" = "$SHA_V1" ] ||
  fail 0 "$HOME_COPY is not a regular file of root's holding the $V1 release"
cx test ! -e "$BIN" && cx test ! -L "$BIN" || fail 0 "install.sh left something at $BIN on a machine that is not set up"
levels=$(cx stat -c '%n %a' /root /root/.orbit "$HOME_COPY" | paste -sd, -)
# docs: "Set up the machine once" — setup refuses root's copy, which is not the one binary the host
# broker runs, and says how to put the machine's copy in place.
out=$(cx "$HOME_COPY" host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 1 ] || fail 0 "orbit host setup from $HOME_COPY exited $rc, want 1"
grep -qxF "orbit host: refusing to set this host up with $HOME_COPY: the host broker runs only $BIN." <<<"$out" ||
  fail 0 "orbit host setup did not refuse $HOME_COPY as not the binary the host broker runs"
grep -qxF "  sudo install -o 0 -g 0 -m 0755 $HOME_COPY $BIN" <<<"$out" && grep -qxF "  sudo $BIN host setup --server $SERVER" <<<"$out" ||
  fail 0 "orbit host setup did not say how to put the machine's copy in place and set the host up from it"
for f in "${SETUP_FILES[@]}"; do
  cx test ! -e "$f" || fail 0 "the refused orbit host setup wrote $f"
done
cx test ! -e /run/orbit || fail 0 "the refused orbit host setup created /run/orbit"
cx systemctl is-enabled --quiet orbit-hostd.socket 2>/dev/null &&
  fail 0 "orbit-hostd.socket is enabled after the refused orbit host setup" orbit-hostd.socket
check_no_sudo "after root's install"
pass 0 "root: install.sh (ORBIT_NO_REGISTER=1, ORBIT_BASE_URL=$SERVER) exit 0, the real file is $HOME_COPY (root's, the $V1 release; $levels), nothing at $BIN; orbit host setup from it refused (exit 1: the host broker runs only $BIN), giving install -o 0 -g 0 -m 0755 $HOME_COPY $BIN, then setup from $BIN; none of the five files setup installs written, no /run/orbit, orbit-hostd.socket not enabled"

# --- 1. root sets the machine up, once -----------------------------------------------------------

echo "==> 1. root: the machine's copy of ~/.orbit/bin/orbit at $BIN, then $BIN host setup --server $SERVER"
# docs: "Set up the machine once" — the machine's copy first: a regular file root owns and only root
# can write, in directories only root can write all the way up to / (as this image has them already).
csh 'install -o 0 -g 0 -m 0755 ~/.orbit/bin/orbit /usr/local/bin/orbit' || fail 1 "putting the machine's copy in place failed"
[ "$(cx stat -c '%F %u %g %a' "$BIN")" = "regular file 0 0 755" ] && [ "$(cx sha256sum "$BIN" | cut -d' ' -f1)" = "$SHA_V1" ] ||
  fail 1 "$BIN is not a regular file of uid 0 and gid 0, mode 0755, holding the $V1 release"
# docs: "Set up the machine once" — `sudo /usr/local/bin/orbit host setup --server <PUBLIC_ORIGIN>`.
out=$(cx "$BIN" host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 1 "orbit host setup exited $rc"
sock=$(cx stat -c '%F %a %U' /run/orbit/host.sock 2>&1)
[ "$sock" = "socket 666 root" ] || fail 1 "/run/orbit/host.sock is '$sock', want a root-owned socket with mode 0666" orbit-hostd.socket
for f in "$TEMPLATE" /etc/systemd/system/orbit-hostd.socket /etc/systemd/system/orbit-hostd.service; do
  cx test -f "$f" || fail 1 "$f was not installed"
done
cx grep -qx 'User=%I' "$TEMPLATE" || fail 1 "$TEMPLATE does not run instances as User=%I"
cx grep -qxF "$EXEC_START" "$TEMPLATE" || fail 1 "$TEMPLATE does not run each account's own ~/.orbit/bin/orbit ($EXEC_START)"
cx grep -qxF "ExecStart=$BIN hostd" /etc/systemd/system/orbit-hostd.service || fail 1 "orbit-hostd.service does not run $BIN"
[ "$(unit_prop orbit-hostd.socket ActiveState)" = active ] || fail 1 "orbit-hostd.socket is not active" orbit-hostd.socket
TEMPLATE_SHA=$(cx sha256sum "$TEMPLATE" | cut -d' ' -f1)
# docs: "Security model" — hostd brings up no runner for root: root's own registration is refused and
# taken by the legacy path, which runs a root runner and says so. Root unregisters it again.
out=$(csh "orbit register --server $SERVER --token e2e-enroll-root --name root-e2e --force </dev/null" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 1 "root's orbit register exited $rc"
grep -qxF "note: the machine broker refused \"enable\" (refusing to enable orbit-runner@root.service: the runner must not run as root — it would own every file its agents write and read root's own engine logins. Ask from the unprivileged account the runner should belong to instead.) — falling back to the sudo path." <<<"$out" ||
  fail 1 "hostd did not refuse to bring up a runner for root" orbit-hostd.service
grep -qF "Running as root — agents will have root access on this machine." <<<"$out" ||
  fail 1 "root's registration did not warn that its runner runs as root"
[ "$(unit_prop orbit-runner@root.service UnitFileState)" != enabled ] || fail 1 "orbit-runner@root.service is enabled" orbit-runner@root.service
[ "$(unit_prop orbit-runner-root.service User)" = root ] || fail 1 "the legacy path did not install orbit-runner-root.service" orbit-runner-root.service
out=$(csh "orbit unregister --yes </dev/null" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 1 "root's orbit unregister exited $rc"
[ "$(unit_prop orbit-runner-root.service LoadState)" = not-found ] ||
  fail 1 "orbit-runner-root.service is still there after root unregistered" orbit-runner-root.service
[ -z "$(csh "runner_pids 0")" ] || fail 1 "root still runs a runner after unregistering" orbit-runner-root.service
check_no_sudo "after setup"
pass 1 "install -o 0 -g 0 -m 0755 ~/.orbit/bin/orbit $BIN (root) made $BIN a regular file of uid 0 and gid 0, mode 0755, the $V1 release; $BIN host setup (root) exit 0: /run/orbit/host.sock is a root-owned socket, mode 0666; orbit-runner@.service (User=%I, $EXEC_START), orbit-hostd.socket (active) and orbit-hostd.service (ExecStart=$BIN hostd) installed; root's own orbit register refused by hostd (orbit-runner@root.service not enabled), taken by the legacy path with its root warning, then unregistered"

# --- 2. two accounts, and the unit alice's runner had before the broker existed ------------------

echo "==> 2. accounts alice and test.user; alice's legacy orbit-runner-alice.service"
cx useradd -m -s /bin/bash alice && cx useradd -m -s /bin/bash test.user || fail 2 "useradd failed"
ACCOUNTS=(alice test.user)
UID_A=$(cx id -u alice)
UID_T=$(cx id -u test.user)
# Each account's instance, named by systemd's own escaping of its user name.
UNIT_A="orbit-runner@$(cx systemd-escape alice).service"
UNIT_T="orbit-runner@$(cx systemd-escape test.user).service"
[ "$UNIT_A" = orbit-runner@alice.service ] && [ "$UNIT_T" = orbit-runner@test.user.service ] ||
  fail 2 "systemd-escape names the instances $UNIT_A and $UNIT_T"
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
# to run instead; typed as a bare `orbit`, which sudo would look up only on its secure_path, the line
# to re-run names the binary by its path.
out=$(as alice "orbit host setup --server $SERVER" 2>&1)
setup_rc=$?
show "$out"
[ "$setup_rc" -ne 0 ] || fail 2 "orbit host setup run by alice exited 0"
grep -qxF "orbit host: setup writes machine-wide systemd units and must run as root — re-run: sudo $BIN host setup --server $SERVER" <<<"$out" ||
  fail 2 "orbit host setup run by alice did not say that it needs root and what to re-run"
[ "$(cx sha256sum "$TEMPLATE" | cut -d' ' -f1)" = "$TEMPLATE_SHA" ] || fail 2 "orbit host setup run by alice rewrote $TEMPLATE"
check_no_sudo "after creating the accounts"
pass 2 "accounts alice (uid $UID_A, instance $UNIT_A) and test.user (uid $UID_T, instance $UNIT_T) created; legacy /etc/systemd/system/orbit-runner-alice.service (User=alice) enabled and running (pid $legacy_pid, euid $UID_A); alice's own orbit host setup refused (exit $setup_rc, re-run with sudo) and $TEMPLATE unchanged"

# --- 3. setup refuses a binary an account could change -------------------------------------------

echo "==> 3. root: orbit host setup through a link into alice's ~/.orbit/bin, then under /usr/local root:staff 2775"
# What setup installs, as step 1 left it: a refused setup must not change a byte of it.
setup_sums() { cx sha256sum "${SETUP_FILES[@]}"; }
sums=$(setup_sums) || harness_fail "cannot read the files setup installed"
# The layout earlier releases of install.sh left for an account that ran them: the account's own copy
# in its ~/.orbit/bin, and $BIN a link to that copy.
cx install -d -o alice -g alice /home/alice/.orbit/bin &&
  cx install -o alice -g alice -m 0755 "$BIN" /home/alice/.orbit/bin/orbit &&
  cx ln -sf /home/alice/.orbit/bin/orbit "$BIN" || harness_fail "cannot give alice the installer's layout"
# docs: "Set up the machine once" — setup refuses the file that link leads to, which alice can
# replace, and says how to put a root-owned copy in place.
out=$(cx orbit host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 1 ] || fail 3 "orbit host setup through the link into alice's home exited $rc, want 1"
grep -qxF "orbit host: refusing to set this host up with /home/alice/.orbit/bin/orbit: it belongs to uid $UID_A rather than root." <<<"$out" ||
  fail 3 "orbit host setup did not refuse the binary the link leads to as alice's"
grep -qxF "  sudo install -o 0 -g 0 -m 0755 /home/alice/.orbit/bin/orbit $BIN" <<<"$out" &&
  grep -qxF "  sudo $BIN host setup --server $SERVER" <<<"$out" ||
  fail 3 "orbit host setup did not say how to put a root-owned copy in place and set the host up from it"
[ "$(setup_sums)" = "$sums" ] || fail 3 "the refused orbit host setup changed the files setup installs"
cx grep -qxF "$EXEC_START" "$TEMPLATE" && cx grep -qxF "ExecStart=$BIN hostd" /etc/systemd/system/orbit-hostd.service ||
  fail 3 "the runner template no longer runs each account's own copy, or the hostd unit no longer runs $BIN"
# docs: "Set up the machine once" — the root-owned copy in place of the link, then setup from it.
cx install -o 0 -g 0 -m 0755 /home/alice/.orbit/bin/orbit "$BIN" || fail 3 "installing the root-owned copy failed"
[ "$(cx stat -c '%F %U %a' "$BIN")" = "regular file root 755" ] && [ "$(cx sha256sum "$BIN" | cut -d' ' -f1)" = "$SHA_V1" ] ||
  fail 3 "$BIN is not a root-owned 0755 copy of the $V1 build after install"
[ "$(cx stat -c '%F %U %a' /home/alice/.orbit/bin/orbit)" = "regular file alice 755" ] || fail 3 "install changed alice's own copy"
out=$(cx "$BIN" host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 3 "orbit host setup from the root-owned copy exited $rc"
[ "$(setup_sums)" = "$sums" ] || fail 3 "orbit host setup from the root-owned copy did not install what step 1 did"
# Older Debian installs have /usr/local and /usr/local/bin root:staff 2775.
cx chgrp staff /usr/local /usr/local/bin && cx chmod 2775 /usr/local /usr/local/bin ||
  harness_fail "cannot make /usr/local and /usr/local/bin root:staff 2775"
# docs: "Set up the machine once" — refused too, naming every directory the staff group can write.
out=$(cx orbit host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 1 ] || fail 3 "orbit host setup under /usr/local and /usr/local/bin root:staff 2775 exited $rc, want 1"
grep -qxF "orbit host: refusing to set this host up with $BIN: its directory /usr/local/bin is not root's alone (owned by uid 0, mode 0775); /usr/local, a directory above it, is not root's alone (owned by uid 0, mode 0775)." <<<"$out" ||
  fail 3 "orbit host setup did not name both directories the staff group can write"
grep -qxF "  sudo chmod g-w /usr/local/bin /usr/local" <<<"$out" && grep -qxF "  sudo $BIN host setup --server $SERVER" <<<"$out" ||
  fail 3 "orbit host setup did not say how to take the group's write access back"
[ "$(setup_sums)" = "$sums" ] || fail 3 "the refused orbit host setup changed the files setup installs"
# docs: "Set up the machine once" — `sudo chmod g-w /usr/local/bin /usr/local`, then setup again:
# `sudo /usr/local/bin/orbit host setup --server <PUBLIC_ORIGIN>`.
cx chmod g-w /usr/local/bin /usr/local || fail 3 "chmod g-w /usr/local/bin /usr/local failed"
dirs=$(cx stat -c '%n %U:%G %a' /usr/local/bin /usr/local | paste -sd, -)
out=$(cx "$BIN" host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 3 "orbit host setup with $dirs exited $rc"
[ "$(setup_sums)" = "$sums" ] || fail 3 "orbit host setup after chmod g-w did not install what step 1 did"
# Back to the image's root:root 0755. alice's copy was only the installer's layout: setup left it
# as it was, and it goes now, so that her registration in step 4 puts her own copy in place.
cx chgrp root /usr/local /usr/local/bin && cx chmod g-s /usr/local /usr/local/bin ||
  harness_fail "cannot put /usr/local back as it was"
check_machine_binary 3 "$SHA_V1"
own_copy_is alice "$SHA_V1" || fail 3 "alice's own /home/alice/.orbit/bin/orbit is not her regular file of the $V1 build"
cx rm -rf /home/alice/.orbit/bin || harness_fail "cannot remove alice's ~/.orbit/bin"
check_no_sudo "after setup's refusals"
pass 3 "orbit host setup run through $BIN, a link to alice's ~/.orbit/bin/orbit, refused (exit 1: it belongs to uid $UID_A rather than root) with the five files it installs unchanged; install -o 0 -g 0 -m 0755 replaced the link with a root-owned copy and setup from it exited 0; under /usr/local and /usr/local/bin root:staff 2775 refused (exit 1, both directories named), then chmod g-w /usr/local/bin /usr/local ($dirs) and setup exited 0; the runner template ran each account's own copy and the hostd unit $BIN throughout; alice's own copy stayed hers, and was then removed for her registration to put in place"

# --- 4. alice registers, without root ------------------------------------------------------------

echo "==> 4. alice: orbit register past a legacy unit that refuses to stop, then once it can (enrollment token, non-interactive, --proxy)"
# What V1 showed by hand: an older unit of the account that will not stop. hostd refuses to enable
# the instance beside it, register stops at that refusal with hostd's message and no sudo fallback,
# and alice keeps exactly one runner — the old one — at every sample.
REFUSE_DIR=/etc/systemd/system/orbit-runner-alice.service.d
cx mkdir -p "$REFUSE_DIR" &&
  printf '[Unit]\nRefuseManualStop=yes\n' | docker exec -i "$CTR" tee "$REFUSE_DIR/refuse-stop.conf" >/dev/null &&
  cx systemctl daemon-reload || harness_fail "cannot make orbit-runner-alice.service refuse to stop"
[ "$(unit_prop orbit-runner-alice.service RefuseManualStop)" = yes ] && unit_running orbit-runner-alice.service &&
  [ "$(main_pid orbit-runner-alice.service)" = "$legacy_pid" ] ||
  fail 4 "orbit-runner-alice.service is not running pid $legacy_pid with RefuseManualStop=yes" orbit-runner-alice.service
cx systemctl stop orbit-runner-alice.service >/dev/null 2>&1 &&
  fail 4 "systemctl stop of orbit-runner-alice.service succeeded despite RefuseManualStop=yes" orbit-runner-alice.service
one_old_runner() {
  local pids
  pids=$(csh "runner_pids $UID_A")
  [ "$pids" = "$legacy_pid" ] ||
    fail 4 "sample $1: uid $UID_A runs orbit runner process(es) [$(tr '\n' ' ' <<<"$pids")], want exactly orbit-runner-alice.service's $legacy_pid" orbit-runner-alice.service "$UNIT_A"
}
as alice "orbit register --server $SERVER --token e2e-enroll-alice-blocked --name alice-blocked --force" >"$WORK/blocked.out" 2>&1 &
reg=$!
samples=0
while kill -0 "$reg" 2>/dev/null; do
  samples=$((samples + 1))
  one_old_runner "$samples"
done
wait "$reg"
rc=$?
out=$(cat "$WORK/blocked.out")
show "$out"
# And for a few seconds after: Restart= or a late start must not bring a second one up.
for _ in 1 2 3 4 5; do
  samples=$((samples + 1))
  one_old_runner "$samples"
  sleep 1
done
[ "$rc" -eq 1 ] || fail 4 "orbit register past the unit that refuses to stop exited $rc, want 1" orbit-runner-alice.service "$UNIT_A"
grep -qF "✗ Could not start the background service: refusing to enable $UNIT_A: alice's older runner orbit-runner-alice.service could not be stopped: systemctl stop orbit-runner-alice.service failed: exit status " <<<"$out" &&
  grep -qF "Operation refused" <<<"$out" &&
  grep -qxF "It is still alice's runner, so $UNIT_A was neither enabled nor started. Once it can be stopped, run \`orbit register\` again." <<<"$out" ||
  fail 4 "orbit register did not stop with hostd's refusal naming orbit-runner-alice.service and systemd's answer" orbit-runner-alice.service
grep -qi sudo <<<"$out" && fail 4 "orbit register past the unit that refuses to stop mentions sudo — it left the broker path for the legacy one"
unit_running orbit-runner-alice.service && [ "$(main_pid orbit-runner-alice.service)" = "$legacy_pid" ] &&
  [ "$(unit_prop orbit-runner-alice.service UnitFileState)" = enabled ] && cx test -e /etc/systemd/system/orbit-runner-alice.service ||
  fail 4 "orbit-runner-alice.service is not still running pid $legacy_pid, enabled, with its unit file in place" orbit-runner-alice.service
[ "$(unit_prop "$UNIT_A" ActiveState)" = inactive ] && [ "$(unit_prop "$UNIT_A" UnitFileState)" = disabled ] ||
  fail 4 "$UNIT_A is $(unit_prop "$UNIT_A" ActiveState) and $(unit_prop "$UNIT_A" UnitFileState); hostd must neither enable nor start it" "$UNIT_A"
# docs: "Register each account's runner" — the refusal's `systemctl status orbit-runner-alice.service`,
# run by alice: the older unit is still her running runner.
out=$(as alice "systemctl status orbit-runner-alice.service" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] && grep -qF "orbit-runner-alice.service - Orbit runner (alice)" <<<"$out" &&
  grep -qF "Active: active (running)" <<<"$out" && grep -qF "Main PID: $legacy_pid " <<<"$out" ||
  fail 4 "alice's systemctl status orbit-runner-alice.service does not show it active (running) as pid $legacy_pid" orbit-runner-alice.service
# docs: "Register each account's runner" (and runner-troubleshooting.md G) — `systemctl status
# orbit-hostd.service`, where to look whether the broker is still carrying a request out: it shows
# the broker's unit and whether it is running (it exits after 30 quiet seconds, status then 3).
out=$(as alice "systemctl status orbit-hostd.service" 2>&1)
rc=$?
show "$out"
{ [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ]; } && grep -qF "orbit-hostd.service - Orbit host broker" <<<"$out" &&
  grep -qF "Loaded: loaded (/etc/systemd/system/orbit-hostd.service;" <<<"$out" && grep -qE "Active: (active|inactive)" <<<"$out" ||
  fail 4 "alice's systemctl status orbit-hostd.service exited $rc without showing the broker's unit and its state" orbit-hostd.service
check_no_sudo "after alice's refused registration"
blocked_samples=$samples
# docs: "Migrating from per-user units" — the unit can stop again, and the next registration retires it.
cx rm -rf "$REFUSE_DIR" && cx systemctl daemon-reload || harness_fail "cannot let orbit-runner-alice.service stop again"
[ "$(unit_prop orbit-runner-alice.service RefuseManualStop)" = no ] || fail 4 "orbit-runner-alice.service still refuses to stop" orbit-runner-alice.service
# docs: "Migrating from per-user units" — the account's next registration retires its legacy unit.
# docs: "Register each account's runner" (and runner-troubleshooting.md G) — once the old unit can
# stop, the account runs its `orbit register` command again, with the flags it registers with.
# docs: "Known limitations" — and --proxy, which the shared template does not carry.
out=$(as alice "orbit register --server $SERVER --token e2e-enroll-alice --name alice-e2e --force --proxy $PROXY" 2>&1)
rc=$?
show "$out"
check_user_command 4 "$out" "$rc" "Background service started as alice"
# Register put alice's own copy in place, as alice, before it asked hostd: the build she ran it from.
grep -qxF "    ✓ Put this account's own copy of orbit at /home/alice/.orbit/bin/orbit, which its runner runs and updates." <<<"$out" ||
  fail 4 "orbit register did not say it put alice's own copy in place"
own_copy_is alice "$SHA_V1" && [ "$(cx stat -c '%U %a' /home/alice/.orbit/bin/orbit)" = "alice 755" ] ||
  fail 4 "/home/alice/.orbit/bin/orbit is not alice's regular file of the $V1 build, mode 0755"
grep -qxF "note: --proxy is not carried into $UNIT_A — the machine's shared runner template has no per-user proxy environment." <<<"$out" ||
  fail 4 "the registration did not warn that --proxy is not carried into $UNIT_A"
wait_until 30 unit_running "$UNIT_A" || fail 4 "$UNIT_A is not active" "$UNIT_A" orbit-runner-alice.service
env_a=$(unit_prop "$UNIT_A" Environment)
[ -z "$env_a" ] || fail 4 "$UNIT_A runs with Environment=$env_a; the shared template sets none" "$UNIT_A"
[ "$(unit_prop "$UNIT_A" UnitFileState)" = enabled ] || fail 4 "$UNIT_A is not enabled" "$UNIT_A"
# The unit as systemd rendered it: User= the account, and $HOME left for the shell to expand.
[ "$(unit_prop "$UNIT_A" User)" = alice ] || fail 4 "$UNIT_A runs as User=$(unit_prop "$UNIT_A" User), want alice" "$UNIT_A"
exec_a=$(unit_prop "$UNIT_A" ExecStart)
grep -qF 'argv[]=/bin/sh -c exec "$HOME/.orbit/bin/orbit" run ;' <<<"$exec_a" ||
  fail 4 "$UNIT_A's ExecStart is '$exec_a', want /bin/sh -c with \$HOME left for the shell" "$UNIT_A"
PID_A=$(main_pid "$UNIT_A")
check_own_runner 4 alice "$UID_A" "$UNIT_A"
cx test ! -e /etc/systemd/system/orbit-runner-alice.service || fail 4 "the legacy unit file is still there" orbit-runner-alice.service
cx test ! -e /etc/systemd/system/multi-user.target.wants/orbit-runner-alice.service ||
  fail 4 "the legacy unit is still wanted by multi-user.target"
[ "$(unit_prop orbit-runner-alice.service LoadState)" = not-found ] ||
  fail 4 "orbit-runner-alice.service is still known to systemd" orbit-runner-alice.service
check_one_runner 4 "$UID_A" "$UNIT_A"
check_machine_binary 4 "$SHA_V1"
check_no_sudo "after alice registered"
pass 4 "alice: with orbit-runner-alice.service refusing to stop (RefuseManualStop=yes), orbit register exit 1 with hostd's refusal naming it and systemd's answer, no sudo fallback, $UNIT_A neither enabled nor started, the legacy unit still running pid $legacy_pid, enabled, its file in place, and exactly that one runner for uid $UID_A at all $blocked_samples samples; once it could stop, orbit register exit 0 without root, having put alice's own copy at /home/alice/.orbit/bin/orbit (alice's, mode 0755, the $V1 build); $UNIT_A enabled and active (User=alice, ExecStart argv /bin/sh -c exec \"\$HOME/.orbit/bin/orbit\" run), main process $PID_A euid $UID_A (alice), exe /home/alice/.orbit/bin/orbit; legacy orbit-runner-alice.service stopped, its unit file removed, unknown to systemd; alice runs exactly one runner; $BIN still the root-owned machine binary; --proxy reported as not carried, and $UNIT_A runs with no proxy environment"

# --- 5. test.user registers too ------------------------------------------------------------------

echo "==> 5. test.user: orbit register with no copy of its own yet (browser approval, approved by the stub)"
cx test ! -e /home/test.user/.orbit || fail 5 "test.user already has a ~/.orbit"
# docs: "Register each account's runner" — `orbit register --server <PUBLIC_ORIGIN> --name <name>`.
out=$(as test.user "orbit register --server $SERVER --name test-user-e2e" 2>&1)
rc=$?
show "$out"
check_user_command 5 "$out" "$rc" "Background service started as test.user"
# Register put test.user's own copy in place, as test.user, under a ~/.orbit made 0700, as install.sh does.
grep -qxF "    ✓ Put this account's own copy of orbit at /home/test.user/.orbit/bin/orbit, which its runner runs and updates." <<<"$out" ||
  fail 5 "orbit register did not say it put test.user's own copy in place"
own_copy_is test.user "$SHA_V1" && [ "$(cx stat -c '%U %a' /home/test.user/.orbit/bin/orbit)" = "test.user 755" ] ||
  fail 5 "/home/test.user/.orbit/bin/orbit is not test.user's regular file of the $V1 build, mode 0755"
[ "$(cx stat -c '%U %a' /home/test.user/.orbit)" = "test.user 700" ] || fail 5 "/home/test.user/.orbit is not test.user's, mode 0700"
wait_until 30 unit_running "$UNIT_T" || fail 5 "$UNIT_T is not active" "$UNIT_T"
[ "$(unit_prop "$UNIT_T" UnitFileState)" = enabled ] || fail 5 "$UNIT_T is not enabled" "$UNIT_T"
PID_T=$(main_pid "$UNIT_T")
check_own_runner 5 test.user "$UID_T" "$UNIT_T"
unit_running "$UNIT_A" && [ "$(main_pid "$UNIT_A")" = "$PID_A" ] ||
  fail 5 "alice's runner did not stay up untouched while test.user registered" "$UNIT_A"
[ "$(csh "unit_of $PID_A")" = "$UNIT_A" ] && [ "$(csh "unit_of $PID_T")" = "$UNIT_T" ] ||
  fail 5 "the runners do not each live in their own instance's cgroup" "$UNIT_A" "$UNIT_T"
check_one_runner 5 "$UID_T" "$UNIT_T"
# The dotted name needs no escaping in systemd's own rule, and no sudo-era orbit-runner-<name> unit
# exists beside the instances.
named=$(csh 'compgen -G "/etc/systemd/system/orbit-runner-*.service"')
[ -z "$named" ] || fail 5 "orbit-runner-<user> unit files exist beside the instances: $named"
ID_A=$(cx sed -n 's/.*"runnerId": *"\([^"]*\)".*/\1/p' /home/alice/.orbit/config.json)
ID_T=$(cx sed -n 's/.*"runnerId": *"\([^"]*\)".*/\1/p' /home/test.user/.orbit/config.json)
[ -n "$ID_A" ] && [ -n "$ID_T" ] && [ "$ID_A" != "$ID_T" ] ||
  fail 5 "the two accounts do not hold separate runner credentials ('$ID_A', '$ID_T')"
# docs: "Register each account's runner" — the receipt's next step and, right under it, this
# runner's new-session page. The id is the one test.user's config.json holds: the CLI writes a UUID
# in base62, as the docs show, and leaves the stub's ids, which are not UUIDs, as they are.
next_step="    Next     Start a session"$'\n'"             $SERVER/runners/$ID_T/new"
[ "$(grep -xF -A1 -- "    Next     Start a session" <<<"$out")" = "$next_step" ] ||
  fail 5 "the command did not end with the next step the docs show: '    Next     Start a session', then '             $SERVER/runners/$ID_T/new'"
# Independent heartbeats: each runner beats the stub with its own credential (first beat at ~30s).
wait_until 60 beats_since alice-e2e 0 && wait_until 60 beats_since test-user-e2e 0 ||
  fail 5 "the stub did not see both runners heartbeat" "$UNIT_A" "$UNIT_T"
# A runner beats only over the runner link: each beat the stub counted came over its link.
for n in alice-e2e test-user-e2e; do
  line=$(stub_runners | awk -v n="$n" '$1 == n')
  awk '$7 > 0 && $7 == $4 { ok = 1 } END { exit !ok }' <<<"$line" ||
    fail 5 "$n's heartbeats did not all come over the stub's runner link (stub: $line)" "$UNIT_A" "$UNIT_T"
done
# docs: "Register each account's runner" — the account's own status and log, without root.
out=$(as test.user 'systemctl status "orbit-runner@$(systemd-escape "$(id -un)")"' 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 5 "test.user's systemctl status \"orbit-runner@\$(systemd-escape \"\$(id -un)\")\" exited $rc" "$UNIT_T"
grep -qF "$UNIT_T - Orbit runner (test.user)" <<<"$out" && grep -qF "Active: active (running)" <<<"$out" ||
  fail 5 "test.user's systemctl status \"orbit-runner@\$(systemd-escape \"\$(id -un)\")\" does not show $UNIT_T active (running)" "$UNIT_T"
wait_until 15 own_journal_has test.user "runner \"test-user-e2e\" online -> $SERVER" ||
  fail 5 "test.user's journalctl -u \"orbit-runner@\$(systemd-escape \"\$(id -un)\")\" does not show its runner coming online" "$UNIT_T"
# docs: "Register each account's runner" — `orbit status`, from the receipt's last line: the
# account's runner, its server, and online.
out=$(as test.user "orbit status" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] && grep -qxF "runner:  test-user-e2e ($ID_T)" <<<"$out" && grep -qxF "server:  $SERVER" <<<"$out" &&
  grep -qF "status:  online (last heartbeat " <<<"$out" ||
  fail 5 "test.user's orbit status exited $rc without showing test-user-e2e ($ID_T) on $SERVER, online" "$UNIT_T"
check_machine_binary 5 "$SHA_V1"
check_no_sudo "after test.user registered"
pass 5 "test.user: orbit register exit 0 without root, having put test.user's own copy at /home/test.user/.orbit/bin/orbit (test.user's, mode 0755, the $V1 build, under a ~/.orbit of mode 0700); $UNIT_T (named by systemd-escape, which leaves 'test.user' as it is) enabled and active as euid $UID_T from /home/test.user/.orbit/bin/orbit beside $UNIT_A — separate processes ($PID_A, $PID_T) in separate cgroups, separate credentials ($ID_A, $ID_T), each heartbeating the control plane on its own, every beat over the runner link; test.user reads its runner's status (active (running)) and log itself"

# --- 6. test-user, whose name systemd escapes, installs with install.sh and registers ------------

echo "==> 6. account test-user: install.sh as itself (ORBIT_NO_REGISTER=1), then orbit register through its ~/.local/bin/orbit launcher"
cx useradd -m -s /bin/bash test-user || fail 6 "useradd test-user failed"
ACCOUNTS+=(test-user)
UID_D=$(cx id -u test-user)
# systemd's own escaping: `-` would come back as `/` from %I, so it becomes \x2d.
UNIT_D="orbit-runner@$(cx systemd-escape test-user).service"
[ "$UNIT_D" = 'orbit-runner@test\x2duser.service' ] ||
  fail 6 "the container's systemd-escape names test-user's instance $UNIT_D, want orbit-runner@test\\x2duser.service"
[ "$(cx systemd-escape --unescape 'test\x2duser')" = test-user ] || fail 6 "systemd-escape --unescape does not give test-user back"
# docs: "Register each account's runner" — on a machine that is set up, an account installs with
# install.sh as itself, the way it does on one that is not: into its own ~/.orbit/bin/orbit, with
# the ~/.local/bin/orbit launcher, and no sudo. The curl stand-in from step 0 is on its PATH.
out=$(docker exec -i "$CTR" su - test-user -c "env ORBIT_NO_REGISTER=1 ORBIT_BASE_URL=$SERVER PATH=/opt/orbit-e2e/curl:\$PATH bash" \
  <"$ROOT/src/web/public/install.sh" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 6 "install.sh run by test-user exited $rc"
grep -qi sudo <<<"$out" && fail 6 "install.sh run by test-user mentions sudo"
grep -qxF "✓ Orbit $V1 installed to /home/test-user/.orbit/bin/orbit" <<<"$out" &&
  grep -qxF "  Launcher: /home/test-user/.local/bin/orbit -> /home/test-user/.orbit/bin/orbit" <<<"$out" ||
  fail 6 "install.sh did not report $V1 installed to /home/test-user/.orbit/bin/orbit with its ~/.local/bin/orbit launcher"
own_copy_is test-user "$SHA_V1" || fail 6 "/home/test-user/.orbit/bin/orbit is not test-user's regular file of the $V1 build"
[ "$(cx stat -c '%F %U' /home/test-user/.local/bin/orbit)" = "symbolic link test-user" ] &&
  [ "$(cx readlink /home/test-user/.local/bin/orbit)" = /home/test-user/.orbit/bin/orbit ] ||
  fail 6 "/home/test-user/.local/bin/orbit is not test-user's link to /home/test-user/.orbit/bin/orbit"
check_machine_binary 6 "$SHA_V1"
copy_inode=$(cx stat -c %i /home/test-user/.orbit/bin/orbit)
# docs: "Register each account's runner" (and runner-troubleshooting.md G) — which orbit a shell
# finds: a login shell finds the launcher, since Debian's ~/.profile puts ~/.local/bin first once it
# exists.
found=$(as test-user 'command -v orbit' 2>&1)
[ "$found" = /home/test-user/.local/bin/orbit ] || fail 6 "a login shell of test-user finds orbit at '$found', want its launcher /home/test-user/.local/bin/orbit"
# docs: "Register each account's runner" (and runner-troubleshooting.md G) — register from the
# account's own copy by typing its launcher's path, ~/.local/bin/orbit.
out=$(as test-user "~/.local/bin/orbit register --server $SERVER --token e2e-enroll-dash --name dash-user-e2e" 2>&1)
rc=$?
show "$out"
check_user_command 6 "$out" "$rc" "Background service started as test-user"
# Register ran from the account's own copy, through the launcher, so it had nothing to put in place.
grep -qF "Put this account's own copy" <<<"$out" && fail 6 "orbit register run from test-user's own copy copied it again"
own_copy_is test-user "$SHA_V1" && [ "$(cx stat -c %i /home/test-user/.orbit/bin/orbit)" = "$copy_inode" ] ||
  fail 6 "orbit register replaced /home/test-user/.orbit/bin/orbit although it ran from it"
wait_until 30 unit_running "$UNIT_D" || fail 6 "$UNIT_D is not active" "$UNIT_D"
[ "$(unit_prop "$UNIT_D" UnitFileState)" = enabled ] || fail 6 "$UNIT_D is not enabled" "$UNIT_D"
[ "$(unit_prop "$UNIT_D" User)" = test-user ] || fail 6 "$UNIT_D runs as User=$(unit_prop "$UNIT_D" User), want test-user" "$UNIT_D"
PID_D=$(main_pid "$UNIT_D")
check_own_runner 6 test-user "$UID_D" "$UNIT_D"
[ "$(csh "unit_of $PID_D")" = "$UNIT_D" ] || fail 6 "test-user's runner $PID_D lives in $(csh "unit_of $PID_D")'s cgroup, want $UNIT_D" "$UNIT_D"
check_one_runner 6 "$UID_D" "$UNIT_D"
unit_running "$UNIT_A" && [ "$(main_pid "$UNIT_A")" = "$PID_A" ] && unit_running "$UNIT_T" && [ "$(main_pid "$UNIT_T")" = "$PID_T" ] ||
  fail 6 "alice's or test.user's runner did not stay up untouched while test-user registered" "$UNIT_A" "$UNIT_T"
[ -z "$(csh 'compgen -G "/etc/systemd/system/orbit-runner-*.service"')" ] || fail 6 "an orbit-runner-<user> unit file exists beside the instances"
wait_until 60 beats_since dash-user-e2e 0 || fail 6 "the stub did not see test-user's runner heartbeat" "$UNIT_D"
# docs: "Register each account's runner" — the same status command, whose systemd-escape gives the
# account's own instance name.
out=$(as test-user 'systemctl status "orbit-runner@$(systemd-escape "$(id -un)")"' 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] && grep -qF "$UNIT_D - Orbit runner (test-user)" <<<"$out" && grep -qF "Active: active (running)" <<<"$out" ||
  fail 6 "test-user's systemctl status \"orbit-runner@\$(systemd-escape \"\$(id -un)\")\" does not show $UNIT_D active (running)" "$UNIT_D"
check_no_sudo "after test-user registered"
pass 6 "test-user: install.sh run as itself exit 0, no sudo: /home/test-user/.orbit/bin/orbit (test-user's, the $V1 build) with the launcher /home/test-user/.local/bin/orbit -> it, $BIN unchanged; a login shell finds orbit at the launcher; orbit register exit 0 without root, nothing copied (it ran from that copy); $UNIT_D — the container's systemd-escape of test-user — enabled and active (User=test-user), main process $PID_D euid $UID_D, exe /home/test-user/.orbit/bin/orbit, in its own cgroup, one runner for uid $UID_D, heartbeating; $UNIT_A and $UNIT_T untouched; test-user reads its own status under the escaped name"

# --- 7. kill -9 --------------------------------------------------------------------------------

echo "==> 7. kill -9 alice's runner ($PID_A), then test-user's ($PID_D)"
# kill9 N ACCOUNT UID UNIT PID — kill -9 PID, UNIT's main process, and see systemd bring UNIT back
# on ACCOUNT's own copy; sets took, restarts and the new pid in new_pid.
kill9() {
  local t0=$SECONDS
  csh "kill -9 $5" || fail "$1" "cannot kill $5" "$4"
  wait_until 15 restarted "$4" "$5" || fail "$1" "$4 was not active again within 15s of kill -9" "$4"
  took=$((SECONDS - t0))
  new_pid=$(main_pid "$4")
  check_own_runner "$1" "$2" "$3" "$4"
  check_one_runner "$1" "$3" "$4"
  restarts=$(unit_prop "$4" NRestarts)
  [ "$restarts" -ge 1 ] 2>/dev/null || fail "$1" "systemd reports NRestarts=$restarts for $4" "$4"
}
# docs: "Set up the machine once" — the template's Restart=always.
old_a=$PID_A
kill9 7 alice "$UID_A" "$UNIT_A" "$PID_A"
PID_A=$new_pid took_a=$took restarts_a=$restarts
unit_running "$UNIT_T" && [ "$(main_pid "$UNIT_T")" = "$PID_T" ] && [ "$(main_pid "$UNIT_D")" = "$PID_D" ] ||
  fail 7 "test.user's or test-user's runner was disturbed" "$UNIT_T" "$UNIT_D"
old_d=$PID_D
kill9 7 test-user "$UID_D" "$UNIT_D" "$PID_D"
PID_D=$new_pid
[ "$(main_pid "$UNIT_A")" = "$PID_A" ] && [ "$(main_pid "$UNIT_T")" = "$PID_T" ] || fail 7 "alice's or test.user's runner was disturbed" "$UNIT_A" "$UNIT_T"
check_no_sudo "after kill -9"
pass 7 "kill -9 of alice's runner (pid $old_a): $UNIT_A active again after ${took_a}s (Restart=always; new pid $PID_A, euid $UID_A, exe /home/alice/.orbit/bin/orbit, NRestarts=$restarts_a); kill -9 of test-user's (pid $old_d): $UNIT_D active again after ${took}s (new pid $PID_D, euid $UID_D, exe /home/test-user/.orbit/bin/orbit, NRestarts=$restarts); one runner per account; the others untouched (test.user pid $PID_T)"

# --- 8. each runner updates its own copy, and hostd its own binary --------------------------------

echo "==> 8. the stub publishes $V2; each runner installs it into its own copy, then asks hostd, which updates its own binary"
# each_runner CMD... — CMD... ACCOUNT UID UNIT STUB-NAME for each of the three accounts' runners.
each_runner() {
  "$@" alice "$UID_A" "$UNIT_A" alice-e2e &&
    "$@" test.user "$UID_T" "$UNIT_T" test-user-e2e &&
    "$@" test-user "$UID_D" "$UNIT_D" dash-user-e2e
}
copy_is() { own_copy_is "$2" "$1"; }                   # copy_is SHA256 ACCOUNT ...
beats_version() { reports_version "$5" "$1"; }          # beats_version VERSION ACCOUNT UID UNIT NAME
check_runner() { check_own_runner "$1" "$2" "$3" "$4" && check_one_runner "$1" "$3" "$4"; }
# runs_version N VERSION ACCOUNT UID UNIT NAME — UNIT's main process runs ACCOUNT's own copy, as
# euid UID, and that file, run as ACCOUNT, is VERSION; adds a line to exes.
runs_version() {
  local pid exe v
  check_runner "$1" "$3" "$4" "$5"
  pid=$(main_pid "$5")
  exe=$(csh "exe $pid")
  v=$(as "$3" "$exe --version" 2>&1)
  [ "$v" = "$2" ] || fail "$1" "$5's main process $pid runs $exe, which is '$v', want $2" "$5"
  exes="$exes; $5 pid $pid euid $4 exe $exe $v"
}
# invocations — each instance's InvocationID, which systemd renews whenever it starts the unit, and
# its NRestarts, which counts the starts Restart= made: what a restart by hostd would change, and a
# runner re-executing into its own update does not.
invocations() {
  local u
  for u in "$UNIT_A" "$UNIT_T" "$UNIT_D"; do
    printf '%s/%s ' "$(unit_prop "$u" InvocationID)" "$(unit_prop "$u" NRestarts)"
  done
}
# watch_execs LOG — start the witness that the download hostd fetches is never executed as root.
watch_execs() {
  cx systemd-run --quiet --unit=orbit-e2e-execwatch /opt/orbit-e2e/stubserver execwatch \
    -prefix "$BIN.new-" -out "$1" || harness_fail "cannot start the exec watcher"
}
# check_execs N LOG — every execution of hostd's download the watcher saw ran as one non-root uid,
# the account hostd verified as (set as verifier), one of the three; and it saw at least one.
check_execs() {
  cx systemctl stop orbit-e2e-execwatch.service
  execs=$(cx cat "$2" 2>/dev/null)
  show "$execs"
  [ -n "$execs" ] || fail "$1" "the watcher saw no execution of the download, so it cannot vouch it never ran as root"
  case " $UID_A $UID_T $UID_D " in
    *" $verifier "*) ;;
    *) fail "$1" "hostd verified the download as uid '$verifier', none of the accounts' ($UID_A $UID_T $UID_D)" orbit-hostd.service ;;
  esac
  grep -vq "uids=$verifier,$verifier,$verifier,$verifier " <<<"$execs" &&
    fail "$1" "the download was executed under some uid other than $verifier: $(tr '\n' ' ' <<<"$execs")"
}
# hostd_installed VERSION — hostd's journal records installing VERSION into its own binary.
hostd_installed() { cx journalctl -u orbit-hostd.service -o cat --no-pager | grep -qF "installed orbit $1 at $BIN (verified as uid "; }
# asked_hostd UNIT VERSION — how many times UNIT logged asking hostd after installing VERSION.
asked_hostd() { cx journalctl -u "$1" -o cat --no-pager | grep -cF "installed orbit $2 into this runner's own copy; asked the host broker at /run/orbit/host.sock to update its own binary: "; }
# hostd's own binary is the file orbit-hostd.service names, and no other.
HOSTD_BIN=$(cx sed -n 's/^ExecStart=\(.*\) hostd$/\1/p' /etc/systemd/system/orbit-hostd.service)
[ "$HOSTD_BIN" = "$BIN" ] || fail 8 "orbit-hostd.service names '$HOSTD_BIN' as hostd's binary, want $BIN" orbit-hostd.service
# check_hostd_binary N VERSION SHA256 — that file, root's regular file, is VERSION's build.
check_hostd_binary() {
  check_machine_binary "$1" "$3"
  [ "$(cx "$HOSTD_BIN" --version 2>&1)" = "$2" ] || fail "$1" "$HOSTD_BIN --version is '$(cx "$HOSTD_BIN" --version 2>&1)', want $2" orbit-hostd.service
}

# docs: "Security model" — the witness that the download is never executed as root (stubserver/execwatch.go).
watch_execs /var/log/orbit-e2e-execwatch-v2.log
before=$(invocations)
publish "$V2"
wait_until 150 each_runner copy_is "$SHA_V2" ||
  fail 8 "the accounts' own copies are not the $V2 build 150s after it was published" "$UNIT_A" "$UNIT_T" "$UNIT_D"
wait_until 60 each_runner beats_version "$V2" ||
  fail 8 "the runners do not heartbeat $V2 after the update" "$UNIT_A" "$UNIT_T" "$UNIT_D"
# docs: "Updates" — the broker installs the release into its own binary, checked as every install is.
wait_until 150 machine_version_is "$V2" && wait_until 30 hostd_installed "$V2" ||
  fail 8 "$BIN --version is still $(cx "$BIN" --version) 150s after $V2 was published" orbit-hostd.service "$UNIT_A" "$UNIT_T" "$UNIT_D"
# A roll would come right after the install line: give it the room it would take.
sleep 5
installed=$(cx journalctl -u orbit-hostd.service -o cat --no-pager | grep -F "installed orbit $V2 at $BIN (verified as uid ")
show "$installed"
[ "$(wc -l <<<"$installed")" = 1 ] || fail 8 "hostd installed $V2 more than once" orbit-hostd.service
verifier=$(sed -n 's/.*(verified as uid \([0-9]*\)).*/\1/p' <<<"$installed" | head -1)
grep -qF "installed orbit $V2 at $BIN (verified as uid $verifier); no runner restarted: each runs its account's own copy" <<<"$installed" ||
  fail 8 "hostd's journal does not say it restarted no runner: '$installed'" orbit-hostd.service
check_execs 8 /var/log/orbit-e2e-execwatch-v2.log
# hostd restarted no runner: systemd started no instance again.
[ "$(invocations)" = "$before" ] ||
  fail 8 "a runner instance was restarted by systemd (InvocationID/NRestarts $before → $(invocations))" "$UNIT_A" "$UNIT_T" "$UNIT_D"
cx journalctl -u orbit-hostd.service -o cat --no-pager | grep -qF "restarting this machine's runners" &&
  fail 8 "hostd's journal records restarting the runners" orbit-hostd.service
# Each runner asked hostd once, after its own install, and none delegated its own update.
accepted=""
for u in "$UNIT_A" "$UNIT_T" "$UNIT_D"; do
  [ "$(asked_hostd "$u" "$V2")" = 1 ] || fail 8 "$u asked hostd $(asked_hostd "$u" "$V2") times after installing $V2, want once" "$u"
  cx journalctl -u "$u" -o cat --no-pager | grep -qF "delegated to the host broker" &&
    fail 8 "$u delegated its own update to the host broker" "$u"
  cx journalctl -u "$u" -o cat --no-pager | grep -qF "to update its own binary: it is installing orbit $V2 as its own binary" &&
    accepted="$accepted $u"
done
[ -n "$accepted" ] || fail 8 "no runner logged hostd accepting $V2 for its own binary" "$UNIT_A" "$UNIT_T" "$UNIT_D"
exes=""
each_runner runs_version 8 "$V2"
exes_v2=${exes#; }
check_hostd_binary 8 "$V2" "$SHA_V2"
PID_A=$(main_pid "$UNIT_A")
PID_T=$(main_pid "$UNIT_T")
PID_D=$(main_pid "$UNIT_D")
# docs: "Updates" — root installs a release into hostd's binary with
# `sudo /usr/local/bin/orbit upgrade`, which replaces it where it is and restarts no runner...
out=$(cx "$BIN" upgrade 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 8 "orbit upgrade (root) exited $rc"
grep -qxF "✓ orbit is now $V2" <<<"$out" || fail 8 "orbit upgrade (root) did not report $V2 installed"
grep -qF "stays where it is" <<<"$out" && fail 8 "orbit upgrade (root) still reads $BIN as shared with the runners"
check_hostd_binary 8 "$V2" "$SHA_V2"
[ "$(main_pid "$UNIT_A")" = "$PID_A" ] && [ "$(main_pid "$UNIT_T")" = "$PID_T" ] && [ "$(main_pid "$UNIT_D")" = "$PID_D" ] &&
  [ "$(invocations)" = "$before" ] || fail 8 "orbit upgrade restarted a runner instance" "$UNIT_A" "$UNIT_T" "$UNIT_D"
each_runner copy_is "$SHA_V2" || fail 8 "orbit upgrade changed an account's own copy"
# ...and `systemctl restart 'orbit-runner@*'` brings each runner back, on its own copy still.
cx systemctl restart 'orbit-runner@*' || fail 8 "systemctl restart 'orbit-runner@*' failed" "$UNIT_A" "$UNIT_T" "$UNIT_D"
wait_until 30 restarted "$UNIT_A" "$PID_A" && wait_until 30 restarted "$UNIT_T" "$PID_T" && wait_until 30 restarted "$UNIT_D" "$PID_D" ||
  fail 8 "the runner instances did not come back after systemctl restart" "$UNIT_A" "$UNIT_T" "$UNIT_D"
# The glob reaches every instance systemd has loaded: neither root's nor an account's older
# orbit-runner@<uid> may be one it starts.
[ -z "$(csh "runner_pids 0")" ] && [ "$(unit_prop orbit-runner@root.service ActiveState)" = inactive ] ||
  fail 8 "systemctl restart 'orbit-runner@*' left a runner running as root" orbit-runner@root.service
exes=""
each_runner runs_version 8 "$V2"
wait_until 60 each_runner beats_version "$V2" ||
  fail 8 "the runners do not heartbeat $V2 after the restart" "$UNIT_A" "$UNIT_T" "$UNIT_D"
pre="$PID_A $PID_T $PID_D"
PID_A=$(main_pid "$UNIT_A")
PID_T=$(main_pid "$UNIT_T")
PID_D=$(main_pid "$UNIT_D")
check_no_sudo "after the update"
pass 8 "stub published $V2 → each runner installed it into its own copy (each its account's regular file, the $V2 build) and runs it, one runner per account, heartbeating $V2: $exes_v2; then each asked hostd once (accepted for${accepted}), none delegated its own update, and hostd installed $V2 once into its own binary, $HOSTD_BIN as orbit-hostd.service names it (verified as uid $verifier; root-owned 0755 regular file, sha256 of the $V2 build, --version $V2), and restarted no runner (InvocationIDs and NRestarts unchanged, journal: no runner restarted); the download was executed $(wc -l <<<"$execs") time(s), every time as uid $verifier, never as root; root's orbit upgrade then reinstalled $V2 into $HOSTD_BIN and restarted no runner, and systemctl restart 'orbit-runner@*' brought all three back ($pre → $PID_A $PID_T $PID_D) on their own copies, one runner per account and none as root"

# --- 9. a binary directory the staff group can write --------------------------------------------

echo "==> 9. /usr/local/bin made root:staff 2775, as older Debian installs have it; the stub publishes $V3, then $V4"
# docs: "Updates" — hostd replaces its binary only in a directory root alone can write, and refuses
# this one.
cx chgrp staff /usr/local/bin && cx chmod 2775 /usr/local/bin || harness_fail "cannot make /usr/local/bin root:staff 2775"
# hostd runs one update per five minutes and step 8's has just run: the stamp it keeps for that goes,
# standing in for the wait.
cx rm -f /run/orbit/last-update || harness_fail "cannot remove hostd's update stamp"
publish "$V3"
wait_until 150 each_runner copy_is "$SHA_V3" ||
  fail 9 "the accounts' own copies are not the $V3 build 150s after it was published" "$UNIT_A" "$UNIT_T" "$UNIT_D"
refusal="installed orbit $V3 into this runner's own copy; asked the host broker at /run/orbit/host.sock to update its own binary: it declined: refusing to update $BIN: its directory /usr/local/bin is not root's alone (owned by uid 0, mode 0775), and root writes nothing it downloaded where another account can reach"
wait_until 90 runner_logged "$refusal" ||
  fail 9 "no runner logged hostd refusing $V3 for the group-writable /usr/local/bin" orbit-hostd.service "$UNIT_A" "$UNIT_T" "$UNIT_D"
wait_until 60 each_runner beats_version "$V3" ||
  fail 9 "the runners do not heartbeat $V3 after their own update" "$UNIT_A" "$UNIT_T" "$UNIT_D"
machine_version_is "$V2" || fail 9 "$BIN is now $(cx "$BIN" --version); hostd must leave $V2 in place" orbit-hostd.service
[ "$(cx sha256sum "$BIN" | cut -d' ' -f1)" = "$SHA_V2" ] || fail 9 "$BIN changed although hostd refused to update it"
before=$(invocations)
exes=""
each_runner runs_version 9 "$V3"
exes_v3=${exes#; }
# docs: "Updates" — the way out: the directory made root's alone, `sudo chmod g-w /usr/local/bin`,
# after which hostd installs the next release itself.
cx chmod g-w /usr/local/bin || harness_fail "chmod g-w /usr/local/bin failed"
dir=$(cx stat -c '%U:%G %a' /usr/local/bin)
watch_execs /var/log/orbit-e2e-execwatch-v4.log
publish "$V4"
wait_until 150 each_runner copy_is "$SHA_V4" ||
  fail 9 "the accounts' own copies are not the $V4 build 150s after it was published" "$UNIT_A" "$UNIT_T" "$UNIT_D"
wait_until 150 machine_version_is "$V4" && wait_until 30 hostd_installed "$V4" ||
  fail 9 "$BIN --version is still $(cx "$BIN" --version) 150s after $V4 was published, with /usr/local/bin $dir" orbit-hostd.service "$UNIT_A" "$UNIT_T" "$UNIT_D"
sleep 5
installed=$(cx journalctl -u orbit-hostd.service -o cat --no-pager | grep -F "installed orbit $V4 at $BIN (verified as uid ")
show "$installed"
verifier=$(sed -n 's/.*(verified as uid \([0-9]*\)).*/\1/p' <<<"$installed" | head -1)
grep -qF "; no runner restarted: each runs its account's own copy" <<<"$installed" ||
  fail 9 "hostd's journal does not say it installed $V4 and restarted no runner: '$installed'" orbit-hostd.service
check_execs 9 /var/log/orbit-e2e-execwatch-v4.log
[ "$(invocations)" = "$before" ] ||
  fail 9 "a runner instance was restarted by systemd (InvocationID/NRestarts $before → $(invocations))" "$UNIT_A" "$UNIT_T" "$UNIT_D"
wait_until 60 each_runner beats_version "$V4" ||
  fail 9 "the runners do not heartbeat $V4 after the update" "$UNIT_A" "$UNIT_T" "$UNIT_D"
check_hostd_binary 9 "$V4" "$SHA_V4"
exes=""
each_runner runs_version 9 "$V4"
exes_v4=${exes#; }
# Back to the image's root:root 0755.
cx chgrp root /usr/local/bin && cx chmod g-s /usr/local/bin || harness_fail "cannot put /usr/local/bin back as it was"
PID_A=$(main_pid "$UNIT_A")
PID_T=$(main_pid "$UNIT_T")
PID_D=$(main_pid "$UNIT_D")
check_no_sudo "after the staff-writable directory"
pass 9 "/usr/local/bin root:staff 2775: each runner installed $V3 into its own copy and runs it ($exes_v3), and hostd refused its own update (not root's alone, mode 0775), leaving $BIN the $V2 build; with the directory made root's alone by chmod g-w ($dir), the runners installed $V4 into their own copies ($exes_v4) and hostd installed $V4 into $HOSTD_BIN itself (verified as uid $verifier, the download executed $(wc -l <<<"$execs") time(s), never as root; root's regular file, --version $V4) and restarted no runner (InvocationIDs and NRestarts unchanged)"

# --- 10. alice unregisters ------------------------------------------------------------------------

echo "==> 10. alice: orbit unregister"
beats_t=$(stub_field test-user-e2e 4)
# docs: "Register each account's runner" — `orbit unregister`, as the receipt names it, without
# --yes: with no terminal to ask on, it prints `aborted` and changes nothing.
out=$(as alice "orbit unregister" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] && grep -qxF "aborted" <<<"$out" && unit_running "$UNIT_A" && [ "$(main_pid "$UNIT_A")" = "$PID_A" ] &&
  [ "$(stub_field alice-e2e 3)" = live ] && cx test -e /home/alice/.orbit/config.json ||
  fail 10 "alice's orbit unregister without --yes exited $rc and did not abort leaving $UNIT_A (pid $PID_A), alice-e2e and her config as they were" "$UNIT_A"
# docs: "Register each account's runner" — `orbit unregister --yes`.
out=$(as alice "orbit unregister --yes" 2>&1)
rc=$?
show "$out"
check_user_command 10 "$out" "$rc" "removed the $UNIT_A runner service"
[ "$(unit_prop "$UNIT_A" UnitFileState)" = disabled ] || fail 10 "$UNIT_A is $(unit_prop "$UNIT_A" UnitFileState), want disabled" "$UNIT_A"
[ "$(unit_prop "$UNIT_A" ActiveState)" = inactive ] || fail 10 "$UNIT_A is $(unit_prop "$UNIT_A" ActiveState), want inactive" "$UNIT_A"
[ -z "$(csh "runner_pids $UID_A")" ] || fail 10 "alice still runs a runner" "$UNIT_A"
[ "$(stub_field alice-e2e 3)" = deleted ] || fail 10 "alice's runner was not deleted from the control plane"
unit_running "$UNIT_T" && [ "$(main_pid "$UNIT_T")" = "$PID_T" ] && unit_running "$UNIT_D" && [ "$(main_pid "$UNIT_D")" = "$PID_D" ] ||
  fail 10 "test.user's or test-user's runner did not stay up untouched" "$UNIT_T" "$UNIT_D"
wait_until 45 beats_since test-user-e2e "$beats_t" || fail 10 "test.user's runner stopped heartbeating" "$UNIT_T"
check_machine_binary 10 "$SHA_V4"
check_no_sudo "after alice unregistered"
pass 10 "alice: orbit unregister exit 0 without root; $UNIT_A disabled and inactive, no runner left for uid $UID_A, alice-e2e deleted from the control plane; $UNIT_T (pid $PID_T, still active and heartbeating) and $UNIT_D (pid $PID_D) untouched"

# --- 11. test.user unregisters past a legacy unit (T9) --------------------------------------------

echo "==> 11. test.user: legacy orbit-runner-test_user.service, then orbit unregister"
install_legacy_unit test.user orbit-runner-test_user.service || fail 11 "cannot install orbit-runner-test_user.service"
wait_until 15 unit_running orbit-runner-test_user.service || fail 11 "orbit-runner-test_user.service did not start" orbit-runner-test_user.service
[ "$(unit_prop orbit-runner-test_user.service User)" = test.user ] || fail 11 "orbit-runner-test_user.service does not run as User=test.user"
legacy_pid=$(main_pid orbit-runner-test_user.service)
# docs: "Migrating from per-user units" — unregistering takes the account's legacy unit down too.
out=$(as test.user "orbit unregister --yes" 2>&1)
rc=$?
show "$out"
check_user_command 11 "$out" "$rc" "removed the $UNIT_T runner service"
[ "$(unit_prop "$UNIT_T" UnitFileState)" = disabled ] || fail 11 "$UNIT_T is $(unit_prop "$UNIT_T" UnitFileState), want disabled" "$UNIT_T"
[ "$(unit_prop "$UNIT_T" ActiveState)" = inactive ] || fail 11 "$UNIT_T is $(unit_prop "$UNIT_T" ActiveState), want inactive" "$UNIT_T"
cx test ! -e /etc/systemd/system/orbit-runner-test_user.service ||
  fail 11 "the legacy unit file is still there" orbit-runner-test_user.service
cx test ! -e /etc/systemd/system/multi-user.target.wants/orbit-runner-test_user.service ||
  fail 11 "the legacy unit is still wanted by multi-user.target"
[ "$(unit_prop orbit-runner-test_user.service LoadState)" = not-found ] ||
  fail 11 "orbit-runner-test_user.service is still known to systemd" orbit-runner-test_user.service
[ -z "$(csh "runner_pids $UID_T")" ] || fail 11 "test.user still runs a runner" "$UNIT_T" orbit-runner-test_user.service
[ "$(stub_field test-user-e2e 3)" = deleted ] || fail 11 "test.user's runner was not deleted from the control plane"
check_machine_binary 11 "$SHA_V4"
check_no_sudo "after test.user unregistered"
pass 11 "test.user: orbit unregister exit 0 without root; $UNIT_T disabled and inactive; legacy orbit-runner-test_user.service (User=test.user, running as pid $legacy_pid) stopped, its unit file removed and the unit gone from systemd; no runner left for uid $UID_T"

# --- 12. test-user unregisters -------------------------------------------------------------------

echo "==> 12. test-user: orbit unregister"
# docs: "Register each account's runner" — `orbit unregister --yes`, here under the escaped name.
out=$(as test-user "orbit unregister --yes" 2>&1)
rc=$?
show "$out"
check_user_command 12 "$out" "$rc" "removed the $UNIT_D runner service"
[ "$(unit_prop "$UNIT_D" UnitFileState)" = disabled ] || fail 12 "$UNIT_D is $(unit_prop "$UNIT_D" UnitFileState), want disabled" "$UNIT_D"
[ "$(unit_prop "$UNIT_D" ActiveState)" = inactive ] || fail 12 "$UNIT_D is $(unit_prop "$UNIT_D" ActiveState), want inactive" "$UNIT_D"
cx test ! -e "/etc/systemd/system/multi-user.target.wants/$UNIT_D" || fail 12 "$UNIT_D is still wanted by multi-user.target"
[ -z "$(csh "runner_pids $UID_D")" ] || fail 12 "test-user still runs a runner" "$UNIT_D"
[ "$(stub_field dash-user-e2e 3)" = deleted ] || fail 12 "test-user's runner was not deleted from the control plane"
own_copy_is test-user "$SHA_V4" || fail 12 "orbit unregister changed test-user's own copy"
[ -z "$(csh 'runner_pids_all')" ] || fail 12 "a runner is still running on the machine: $(csh 'runner_pids_all' | tr '\n' ' ')"
check_machine_binary 12 "$SHA_V4"
check_no_sudo "after test-user unregistered"
pass 12 "test-user: orbit unregister exit 0 without root; $UNIT_D disabled and inactive, no longer wanted by multi-user.target, no runner left for uid $UID_D, dash-user-e2e deleted from the control plane, its own copy left as it was; no runner left on the machine"

# --- 13. the move: a host set up by the previous release, setup run again -----------------------

echo "==> 13. a second machine set up by orbit $V0 ($OLD_REV): test-user on orbit-runner@<uid> with its own copy, test.user on orbit-runner@<uid> without one; then $V1 in place of $BIN and setup again"
[ -n "${HOSTD_E2E_KEEP:-}" ] || docker rm -f "$CTR" >/dev/null 2>&1
start_machine
docker cp -q "$WORK/orbit-$V0" "$CTR:/opt/orbit-e2e/orbit-$V0" && docker cp -q "$WORK/orbit-$V1" "$CTR:/opt/orbit-e2e/orbit-$V1" &&
  cx chown root:root "/opt/orbit-e2e/orbit-$V0" "/opt/orbit-e2e/orbit-$V1" &&
  cx chmod 0755 "/opt/orbit-e2e/orbit-$V0" "/opt/orbit-e2e/orbit-$V1" || harness_fail "copying the two builds into the container failed"
# /srv/orbit-dl stays empty: no release is published here, so no runner is asked to update itself
# and no broker to update its binary while runners move.
start_stub
ACCOUNTS=()
check_no_sudo "on the second machine"
# The previous release, set up as its docs said: its binary at $BIN, then its setup.
cx install -o 0 -g 0 -m 0755 "/opt/orbit-e2e/orbit-$V0" "$BIN" || fail 13 "installing orbit $V0 at $BIN failed"
out=$(cx "$BIN" host setup --server "$SERVER" 2>&1)
rc=$?
show "$out"
[ "$rc" -eq 0 ] || fail 13 "orbit $V0's host setup exited $rc"
grep -qxF "  Runners: orbit-runner@<uid>.service, one instance per Linux user" <<<"$out" ||
  fail 13 "orbit $V0's host setup does not report runners named by uid"
cx grep -qx 'User=%i' "$TEMPLATE" && cx grep -qxF "ExecStart=$BIN run" "$TEMPLATE" ||
  fail 13 "orbit $V0 did not write the uid template (User=%i, ExecStart=$BIN run)"
old_template=$(cx grep -E '^(User|ExecStart)=' "$TEMPLATE" | paste -sd' ' -)
cx useradd -m -s /bin/bash test-user && cx useradd -m -s /bin/bash test.user || fail 13 "useradd failed"
ACCOUNTS=(test-user test.user)
UID_D=$(cx id -u test-user)
UID_T=$(cx id -u test.user)
OLD_D="orbit-runner@$UID_D.service"
OLD_T="orbit-runner@$UID_T.service"
UNIT_D="orbit-runner@$(cx systemd-escape test-user).service"
UNIT_T="orbit-runner@$(cx systemd-escape test.user).service"
[ "$UNIT_D" = 'orbit-runner@test\x2duser.service' ] && [ "$UNIT_T" = orbit-runner@test.user.service ] ||
  fail 13 "systemd-escape names the instances $UNIT_D and $UNIT_T"
# test-user has its own copy, as an earlier install.sh left it: the $V1 build, its own file.
cx install -d -o test-user -g test-user -m 0700 /home/test-user/.orbit &&
  cx install -d -o test-user -g test-user -m 0755 /home/test-user/.orbit/bin &&
  cx install -o test-user -g test-user -m 0755 "/opt/orbit-e2e/orbit-$V1" /home/test-user/.orbit/bin/orbit ||
  harness_fail "cannot give test-user its own copy"
# Each account registered with the previous release, through its broker: orbit-runner@<uid>.
for acct in test-user test.user; do
  out=$(as "$acct" "orbit register --server $SERVER --token e2e-enroll-move-$acct --name move-$acct-e2e --force" 2>&1)
  rc=$?
  show "$out"
  check_user_command 13 "$out" "$rc" "Background service started as $acct"
done
wait_until 30 unit_running "$OLD_D" && wait_until 30 unit_running "$OLD_T" || fail 13 "the uid instances are not active" "$OLD_D" "$OLD_T"
for u in "$OLD_D" "$OLD_T"; do
  pid=$(main_pid "$u")
  [ "$(csh "exe $pid")" = "$BIN" ] || fail 13 "$u's main process $pid runs $(csh "exe $pid"), want $BIN, the previous layout's shared binary" "$u"
  [ "$(unit_prop "$u" UnitFileState)" = enabled ] || fail 13 "$u is not enabled" "$u"
done
[ "$(csh "euid $(main_pid "$OLD_D")")" = "$UID_D" ] && [ "$(csh "euid $(main_pid "$OLD_T")")" = "$UID_T" ] ||
  fail 13 "the uid instances do not run as their accounts" "$OLD_D" "$OLD_T"
check_one_runner 13 "$UID_D" "$OLD_D"
check_one_runner 13 "$UID_T" "$OLD_T"
OLDPID_D=$(main_pid "$OLD_D")
OLDPID_T=$(main_pid "$OLD_T")
# The broker exits after 30 quiet seconds, as on any machine set up a while ago.
hostd_idle() { [ "$(unit_prop orbit-hostd.service ActiveState)" = inactive ]; }
wait_until 90 hostd_idle || fail 13 "the previous release's broker did not exit when idle" orbit-hostd.service
check_no_sudo "on the previous release's layout"

# move_sample N — sample N of both accounts: never two runner processes, never two live runner
# units (the uid instance and the name instance) for one account. Counts, per account, the samples
# with one runner and with none.
MV_ACCT=(test-user test.user)
MV_ONE=(0 0)
MV_NONE=(0 0)
MV_LOG="$WORK/move-samples.log"
move_sample() {
  local i uid old new out pids units
  for i in 0 1; do
    if [ "$i" = 0 ]; then uid=$UID_D old=$OLD_D new=$UNIT_D; else uid=$UID_T old=$OLD_T new=$UNIT_T; fi
    out=$(csh "account_runners $uid '$old' '$new'")
    echo "$MV_PHASE sample $1 ${MV_ACCT[i]}: $out" >>"$MV_LOG"
    pids=${out#pids=}
    pids=${pids%% units=*}
    units=${out##* units=}
    case "$pids" in *,*) fail 13 "sample $1: ${MV_ACCT[i]} (uid $uid) runs two runner processes [$pids]" "$old" "$new" ;; esac
    case "$units" in *,*) fail 13 "sample $1: ${MV_ACCT[i]} has two live runner units [$units]" "$old" "$new" ;; esac
    if [ -n "$pids" ]; then MV_ONE[i]=$((MV_ONE[i] + 1)); else MV_NONE[i]=$((MV_NONE[i] + 1)); fi
  done
}
# sample_while PID — move_sample once a second while PID runs, then five more; sets samples.
sample_while() {
  samples=0
  while kill -0 "$1" 2>/dev/null; do
    samples=$((samples + 1))
    move_sample "$samples"
    sleep 1
  done
  for _ in 1 2 3 4 5; do
    samples=$((samples + 1))
    move_sample "$samples"
    sleep 1
  done
}

MV_PHASE=before
move_sample 0
[ "${MV_ONE[*]}" = "1 1" ] || fail 13 "before the move, the accounts do not have one runner each: $(cat "$MV_LOG")"
# Root's own copy of the new release, where install.sh puts it (step 0 ran it).
cx install -d -m 0700 /root/.orbit /root/.orbit/bin && docker cp -q "$WORK/orbit-$V1" "$CTR:$HOME_COPY" &&
  cx chown root:root "$HOME_COPY" && cx chmod 0755 "$HOME_COPY" || harness_fail "cannot give root its copy of $V1"
# docs: "Moving a machine set up by an earlier release" — the new release in place of hostd's
# binary, with the command "Set up the machine once" gives.
csh 'install -o 0 -g 0 -m 0755 ~/.orbit/bin/orbit /usr/local/bin/orbit' || fail 13 "putting $V1 at $BIN failed"
[ "$(cx stat -c '%F %U %a' "$BIN")" = "regular file root 755" ] && [ "$(cx sha256sum "$BIN" | cut -d' ' -f1)" = "$SHA_V1" ] ||
  fail 13 "$BIN is not root's 0755 regular file of the $V1 build"
# docs: "Moving a machine set up by an earlier release" — setup again:
# `sudo /usr/local/bin/orbit host setup --server <PUBLIC_ORIGIN>`, sampled every second.
MV_PHASE=setup
cx "$BIN" host setup --server "$SERVER" >"$WORK/move-setup.out" 2>&1 &
job=$!
sample_while "$job"
wait "$job"
rc=$?
setup_samples=$samples
out=$(cat "$WORK/move-setup.out")
show "$out"
[ "$rc" -eq 0 ] || fail 13 "orbit host setup run again exited $rc"
cx grep -qx 'User=%I' "$TEMPLATE" && cx grep -qxF "$EXEC_START" "$TEMPLATE" ||
  fail 13 "setup run again did not write the template that runs each account's own copy"
[ "$(cx sha256sum "$TEMPLATE" | cut -d' ' -f1)" = "$TEMPLATE_SHA" ] || fail 13 "the template setup wrote here differs from the first machine's"
grep -qxF "  Moved to instances named after their accounts:" <<<"$out" &&
  grep -qxF "    $OLD_D → $UNIT_D (test-user)" <<<"$out" ||
  fail 13 "setup did not report moving $OLD_D to $UNIT_D"
grep -qxF "  Left on their orbit-runner@<uid> instance (1):" <<<"$out" &&
  grep -qxF "    test.user ($OLD_T): /home/test.user/.orbit/bin/orbit is missing or test.user cannot execute it." <<<"$out" &&
  grep -qxF "      test.user runs:  /usr/local/bin/orbit register" <<<"$out" ||
  fail 13 "setup did not list test.user as left, with the command it runs"
grep -qxF "  An instance left keeps its current process. At its next restart it runs its account's own" <<<"$out" ||
  fail 13 "setup did not say what becomes of an instance it left"
# test-user is on its name instance, running its own copy; its uid instance is down and disabled.
unit_running "$UNIT_D" && [ "$(unit_prop "$UNIT_D" UnitFileState)" = enabled ] || fail 13 "$UNIT_D is not enabled and running" "$UNIT_D" "$OLD_D"
[ "$(unit_prop "$OLD_D" ActiveState)" = inactive ] && [ "$(unit_prop "$OLD_D" UnitFileState)" = disabled ] ||
  fail 13 "$OLD_D is $(unit_prop "$OLD_D" ActiveState) and $(unit_prop "$OLD_D" UnitFileState), want inactive and disabled" "$OLD_D"
check_own_runner 13 test-user "$UID_D" "$UNIT_D"
check_one_runner 13 "$UID_D" "$UNIT_D"
moved_pid=$(main_pid "$UNIT_D")
# test.user's uid instance keeps its process, the previous release's image, until it registers.
[ "$(main_pid "$OLD_T")" = "$OLDPID_T" ] && unit_running "$OLD_T" ||
  fail 13 "test.user's $OLD_T is no longer the process $OLDPID_T it ran before setup" "$OLD_T"
left_exe=$(csh "exe $OLDPID_T")
[ "$left_exe" = "$BIN (deleted)" ] || fail 13 "test.user's left runner runs '$left_exe', want the replaced $BIN (deleted)" "$OLD_T"
check_one_runner 13 "$UID_T" "$OLD_T"
setup_one=("${MV_ONE[@]}")
setup_none=("${MV_NONE[@]}")
[ "${setup_none[1]}" = 0 ] || fail 13 "test.user, which setup left, had no runner at ${setup_none[1]} sample(s) of setup" "$OLD_T"
check_no_sudo "after setup moved test-user"
# docs: "Moving a machine set up by an earlier release" — the account setup left runs the command it
# was given, which puts its own copy in place and moves its runner, sampled every second.
MV_ONE=(0 0)
MV_NONE=(0 0)
MV_PHASE=register
as test.user "/usr/local/bin/orbit register" >"$WORK/move-register.out" 2>&1 &
job=$!
sample_while "$job"
wait "$job"
rc=$?
register_samples=$samples
out=$(cat "$WORK/move-register.out")
show "$out"
check_user_command 13 "$out" "$rc" "Background service started as test.user"
grep -qxF "    ✓ Put this account's own copy of orbit at /home/test.user/.orbit/bin/orbit, which its runner runs and updates." <<<"$out" ||
  fail 13 "test.user's orbit register did not say it put its own copy in place"
own_copy_is test.user "$SHA_V1" || fail 13 "/home/test.user/.orbit/bin/orbit is not test.user's regular file of the $V1 build"
wait_until 30 unit_running "$UNIT_T" && [ "$(unit_prop "$UNIT_T" UnitFileState)" = enabled ] || fail 13 "$UNIT_T is not enabled and running" "$UNIT_T" "$OLD_T"
[ "$(unit_prop "$OLD_T" ActiveState)" = inactive ] && [ "$(unit_prop "$OLD_T" UnitFileState)" = disabled ] ||
  fail 13 "$OLD_T is $(unit_prop "$OLD_T" ActiveState) and $(unit_prop "$OLD_T" UnitFileState), want inactive and disabled" "$OLD_T"
check_own_runner 13 test.user "$UID_T" "$UNIT_T"
check_one_runner 13 "$UID_T" "$UNIT_T"
check_own_runner 13 test-user "$UID_D" "$UNIT_D"
[ "$(main_pid "$UNIT_D")" = "$moved_pid" ] || fail 13 "test-user's runner was disturbed by test.user's registration" "$UNIT_D"
[ "${MV_NONE[0]}" = 0 ] || fail 13 "test-user had no runner at ${MV_NONE[0]} sample(s) of test.user's registration" "$UNIT_D"
[ -z "$(csh 'compgen -G "/etc/systemd/system/*.wants/orbit-runner@[0-9]*.service"')" ] ||
  fail 13 "an orbit-runner@<uid> instance is still enabled: $(csh 'compgen -G "/etc/systemd/system/*.wants/orbit-runner@[0-9]*.service"')"
check_machine_binary 13 "$SHA_V1"
show "$(cat "$MV_LOG")"
check_no_sudo "after test.user moved"
pass 13 "a machine set up by orbit $V0 ($OLD_REV: $old_template), test-user on $OLD_D and test.user on $OLD_T, both running $BIN; $V1 put at $BIN with install -o 0 -g 0 -m 0755 ~/.orbit/bin/orbit $BIN and setup run again: template rewritten (User=%I, $EXEC_START); test-user, which had its own copy, moved $OLD_D → $UNIT_D (now inactive and disabled → enabled and active, pid $moved_pid euid $UID_D exe /home/test-user/.orbit/bin/orbit); test.user, without one, listed as left with 'test.user runs:  /usr/local/bin/orbit register', its runner left as it was (pid $OLDPID_T, still the replaced $BIN image); then test.user ran /usr/local/bin/orbit register without root, which put its own copy in place and brought it onto $UNIT_T (euid $UID_T, exe /home/test.user/.orbit/bin/orbit), $OLD_T inactive and disabled, no orbit-runner@<uid> left enabled; sampled once a second, $setup_samples samples through setup and $register_samples through the registration: never two runner processes or two live runner units for an account — during setup test-user had one runner at ${setup_one[0]} and none at ${setup_none[0]} (its drain-then-start handover), test.user one at all ${setup_one[1]}; during the registration test.user one at ${MV_ONE[1]} and none at ${MV_NONE[1]}, test-user one at all ${MV_ONE[0]}"

# --- 14. no sudo, throughout ----------------------------------------------------------------------

pass 14 "no sudo anywhere: absent from both machines' image and from root's, alice's, test.user's and test-user's PATH at all $SUDO_CHECKS checkpoints, from before setup to the end of the move, and no register or unregister by an account fell back to the sudo path"
echo "==> all 15 assertions passed"
