#!/usr/bin/env bash
# Container tests for the runner installer, src/web/public/install.sh: where it puts the orbit
# binary, whose it is, and what it leaves on PATH, on a machine set up with `orbit host setup` and on
# one that is not.
#
#   scripts/install-sh-e2e.sh [path/to/install.sh]
#
# Runs the given install.sh (by default this tree's src/web/public/install.sh) the way people run it,
# piped from curl into bash, always with ORBIT_NO_REGISTER=1. Every scenario gets a fresh container
# of scripts/install-sh-e2e/Dockerfile: Debian 12 with sudo and zsh, alice (passwordless sudo), bob
# (no sudo right), and a stub on 127.0.0.1:8000, reached through ORBIT_BASE_URL, that serves
# install.sh and the release (scripts/install-sh-e2e/orbit-stub, gzipped as
# /dl/orbit-linux-<arch>.gz). The accounts' sudo logs every call, so a run shows whether install.sh
# asked for it.
#
# Set up (the template `orbit host setup` writes, scripts/install-sh-e2e/orbit-runner@.service):
#   S1  alice installs: /usr/local/bin/orbit is a regular file, uid 0, gid 0, mode 0755, the release,
#       and alice can neither write nor replace it
#   S2  as S1, with /usr/local/bin writable by alice's group (only writing the file is checked:
#       replacing it is then up to the directory, which orbit host setup refuses)
#   S3  bob installs, /usr/local/bin writable by bob's group: fails, says root is needed, and leaves
#       no /usr/local/bin/orbit of bob's
#   S4  root installs: a regular file, uid 0, gid 0, mode 0755, the release
#   S5  alice pipes it into sudo (curl … | sudo env … bash): as S4
#   S6  /usr/local/bin/orbit is a link to alice's own copy; alice installs: the link is replaced by
#       root's file, and alice's copy is left as it was
#   S7  /usr/local/bin/orbit is running; alice installs: it is replaced, not written into
# Not set up (no template):
#   N1  bob installs: his own ~/.orbit/bin/orbit, the release, without sudo; no /usr/local/bin/orbit
#   N2  root installs: /root/.orbit/bin/orbit, root's; no /usr/local/bin/orbit
#   N3  alice installs through sudo (sudo env … bash install.sh): her ~/.orbit/bin/orbit and rc files,
#       all hers; no /usr/local/bin/orbit
#   N4  /usr/local/bin/orbit is there already, a root-owned file or a link; alice, alice through
#       sudo, and root install: it is left as it was
#   N5  bob installs with ORBIT_BIN_DIR=/home/bob/bin, a directory of his: the binary there, his, no
#       PATH block, no /usr/local/bin/orbit; its mode is printed, to compare runs of two versions
#   N6  N1, N2 and N3 install a second time: ~/.bashrc and ~/.zshrc hold the PATH block once, as the
#       first run left them, and are the account's; new interactive bash and zsh find the account's
#       own copy; both runs print the closing hint and name the binary by its absolute path
#   N7  alice installs with ORBIT_BIN_DIR=/usr/local/bin/: that is the machine's file all the same,
#       written as on a set-up machine (as S1), with no PATH block
#
# Prints one PASS or FAIL line per assertion and carries on after a FAIL, then a summary. Exits 0 when
# every assertion passed, 1 when one failed, and 2 on a harness problem (no docker, a failed build).
# Needs docker. The containers run without --privileged, without systemd and without a network.

# shellcheck disable=SC2016,SC2001 # single-quoted scripts run in the container, which expands them
set -uo pipefail # not -e: every check is explicit, so that a failure says what failed and the run goes on

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERE="$ROOT/scripts/install-sh-e2e"
INSTALL_SH="${1:-$ROOT/src/web/public/install.sh}"
IMAGE="orbit-install-sh-e2e:bookworm"
BASE="http://127.0.0.1:8000"
ENVS="ORBIT_NO_REGISTER=1 ORBIT_BASE_URL=$BASE"
BIN="/usr/local/bin/orbit"
TEMPLATE="/etc/systemd/system/orbit-runner@.service"
BLOCK="# >>> orbit >>>" # the line install.sh's PATH block in ~/.bashrc and ~/.zshrc opens with
SUDO_LOG="/var/log/install-sh-e2e-sudo.log"
PLAIN_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
CTR=""
RUNS=0
PASSED=0
FAILED=0

harness_fail() {
  echo "HARNESS ERROR: $*" >&2
  exit 2
}

drop() {
  [ -z "$CTR" ] || docker rm -f "$CTR" >/dev/null 2>&1
  CTR=""
}
trap drop EXIT

# --- verdicts ------------------------------------------------------------------------------------

pass() {
  PASSED=$((PASSED + 1))
  echo "PASS $1 $2"
}
fail() {
  FAILED=$((FAILED + 1))
  echo "FAIL $1 $2"
}
# expect ID WHAT GOT WANT — passes when GOT is WANT.
expect() {
  if [ "$3" = "$4" ]; then pass "$1" "$2: $3"; else fail "$1" "$2: $3, want $4"; fi
}

# --- the container -------------------------------------------------------------------------------

cx() { docker exec "$CTR" "$@"; }
home_of() { if [ "$1" = root ]; then echo /root; else echo "/home/$1"; fi; }
uid_of() { cx id -u "$1"; }

# fresh TITLE [setup] — a new container for the next scenario; with "setup", the runner template
# orbit host setup writes is in place.
fresh() {
  drop
  RUNS=$((RUNS + 1))
  CTR="orbit-install-sh-e2e-$$-$RUNS"
  echo ""
  echo "==> $1"
  docker run -d --network none --hostname localhost --name "$CTR" "$IMAGE" >/dev/null ||
    harness_fail "cannot start a container of $IMAGE"
  docker exec -i "$CTR" sh -c 'cat >/srv/stub/install.sh' <"$INSTALL_SH" ||
    harness_fail "cannot copy $INSTALL_SH into the container"
  if [ "${2:-}" = setup ]; then
    sed -n '/^\[Unit\]$/,$p' "$HERE/orbit-runner@.service" | docker exec -i "$CTR" sh -c "cat >'$TEMPLATE'" ||
      harness_fail "cannot put $TEMPLATE in place"
    echo "    $TEMPLATE in place, sha256 $(cx sha256sum "$TEMPLATE" | cut -d' ' -f1)"
  fi
  for _ in $(seq 100); do
    cx curl -fsS -o /dev/null "$BASE/install.sh" 2>/dev/null && return 0
    sleep 0.1
  done
  harness_fail "the stub does not answer on $BASE"
}

# as ACCOUNT LINE — LINE in bash as ACCOUNT, in its home, with nothing in the environment but HOME,
# USER, LOGNAME and PATH. An account's PATH finds the logging sudo first; root has no use for one.
as() {
  local home path="/opt/install-sh-e2e/shim:$PLAIN_PATH"
  home=$(home_of "$1")
  [ "$1" != root ] || path="$PLAIN_PATH"
  docker exec -u "$1" -w "$home" "$CTR" env -i HOME="$home" USER="$1" LOGNAME="$1" PATH="$path" bash -c "$2" </dev/null
}

# install_as ACCOUNT HOW [VAR=VALUE] — runs install.sh as ACCOUNT and shows what it printed. HOW is
# pipe (curl … | bash), sudo-pipe (curl … | sudo env … bash) or sudo-file (sudo env … bash
# install.sh, downloaded first). Sets OUT, RC and SUDO_CALLS, the sudo the account ran meanwhile.
install_as() {
  local line
  case "$2" in
    pipe) line="curl -fsSL $BASE/install.sh | env $ENVS${3:+ $3} bash" ;;
    sudo-pipe) line="curl -fsSL $BASE/install.sh | sudo env $ENVS bash" ;;
    sudo-file) line="curl -fsSL -o install.sh $BASE/install.sh && sudo env $ENVS bash install.sh" ;;
  esac
  cx truncate -s 0 "$SUDO_LOG"
  echo "    $1\$ $line"
  OUT=$(as "$1" "set -o pipefail; $line" 2>&1)
  RC=$?
  SUDO_CALLS=$(cx cat "$SUDO_LOG")
  sed 's/^/    | /' <<<"$OUT"
  echo "    (exit $RC)"
  [ -z "$SUDO_CALLS" ] || sed 's/^/    sudo log: /' <<<"$SUDO_CALLS"
}

# st FORMAT PATH — stat(1) of PATH itself, a link not followed; "absent" when there is nothing.
st() { cx stat -c "$1" "$2" 2>/dev/null || echo absent; }
# sha_of PATH — the sha256 of what PATH holds or leads to; "absent" when there is nothing.
sha_of() { cx sh -c 'if [ -e "$1" ]; then sha256sum <"$1" | cut -d" " -f1; else echo absent; fi' sh "$1"; }
# what_is PATH — a link's target, then the mode and content of what PATH holds or leads to.
what_is() {
  cx sh -c 'if [ -L "$1" ]; then printf -- "-> %s, " "$(readlink "$1")"; fi
    if [ -e "$1" ]; then printf "mode %s, sha256 %s" "$(stat -L -c %a "$1")" "$(sha256sum <"$1" | cut -d" " -f1)"; else printf absent; fi' sh "$1"
}
# blocks ACCOUNT RC — how many lines of the account's RC file open install.sh's PATH block.
blocks() {
  cx sh -c 'if [ -e "$1" ]; then grep -cxF -- "$2" "$1"; else echo 0; fi' sh "$(home_of "$1")/$2" "$BLOCK"
}
# found_by ACCOUNT SHELL — what `command -v orbit` prints in a new interactive SHELL of ACCOUNT,
# started with nothing but HOME, USER and a PATH that holds no ~/.orbit/bin: only the account's own
# rc files can put it there.
found_by() {
  local home
  home=$(home_of "$1")
  docker exec -u "$1" -w "$home" "$CTR" env -i HOME="$home" USER="$1" LOGNAME="$1" PATH="$PLAIN_PATH" TERM=dumb \
    timeout 30 "$2" -ic 'command -v orbit' </dev/null 2>/dev/null
}

# --- the checks ----------------------------------------------------------------------------------

exited() { expect "$1" "install.sh exit status" "$RC" 0; }

# machine_binary ID — /usr/local/bin/orbit is root's alone and holds the release. Whose it is comes
# before its mode, so a binary left to the account that ran install.sh fails on its owner first.
machine_binary() {
  expect "$1" "$BIN type" "$(st %F "$BIN")" "regular file"
  expect "$1" "$BIN owner" "$(st '%u (%U)' "$BIN")" "0 (root)"
  expect "$1" "$BIN group" "$(st '%g (%G)' "$BIN")" "0 (root)"
  expect "$1" "$BIN mode" "$(st %a "$BIN")" "755"
  expect "$1" "$BIN sha256" "$(sha_of "$BIN")" "$SHA"
}

no_machine_binary() { expect "$1" "$BIN" "$(st %F "$BIN")" "absent"; }

# own_binary ID ACCOUNT — the account's own copy: ~/.orbit/bin/orbit, a regular file of its own that
# holds the release, under a ~/.orbit only the account can enter.
own_binary() {
  local home
  home=$(home_of "$2")
  expect "$1" "$home/.orbit/bin/orbit type" "$(st %F "$home/.orbit/bin/orbit")" "regular file"
  expect "$1" "$home/.orbit/bin/orbit owner" "$(st '%u (%U)' "$home/.orbit/bin/orbit")" "$(uid_of "$2") ($2)"
  expect "$1" "$home/.orbit/bin/orbit sha256" "$(sha_of "$home/.orbit/bin/orbit")" "$SHA"
  expect "$1" "$home/.orbit owner and mode" "$(st '%U %a' "$home/.orbit")" "$2 700"
}

# no_sudo ID ACCOUNT — the run of install.sh as ACCOUNT ran no sudo.
no_sudo() {
  local calls
  calls=$(printf '%s' "$SUDO_CALLS" | tr '\n' ';' | sed 's/;/; /g')
  expect "$1" "sudo run by $2" "${calls:-none}" "none"
}

# cannot ID ACCOUNT WHAT LINE — LINE, run as ACCOUNT, fails.
cannot() {
  local out
  if out=$(as "$2" "$4" 2>&1); then
    fail "$1" "$2 can $3: \`$4\` succeeded"
  else
    pass "$1" "$2 cannot $3: $(tail -n 1 <<<"$out")"
  fi
}

# closing ID RUN ACCOUNT OUTPUT — the closing words of a home install: this terminal needs a new login
# or `source ~/.bashrc` / `source ~/.zshrc`, non-interactive use (ssh, cron) the absolute path, and
# the Next: line names the binary by that path.
closing() {
  local target next missing=""
  target="$(home_of "$3")/.orbit/bin/orbit"
  grep -qiE 'log ?in' <<<"$4" || missing="$missing [a new login]"
  grep -qF 'source ~/.bashrc' <<<"$4" || missing="$missing [source ~/.bashrc]"
  grep -qF 'source ~/.zshrc' <<<"$4" || missing="$missing [source ~/.zshrc]"
  grep -F 'ssh' <<<"$4" | grep -F 'cron' | grep -qF "$target" || missing="$missing [ssh and cron: $target]"
  if [ -z "$missing" ]; then
    pass "$1" "run $2 printed the closing hint: $(grep -F 'cron' <<<"$4" | sed 's/^ *//')"
  else
    fail "$1" "run $2 printed no closing hint, missing:$missing"
  fi
  next=$(grep '^Next:' <<<"$4" | head -n 1)
  expect "$1" "run $2's Next: line" "${next:-nothing}" "Next:  $target register"
}

# again ACCOUNT HOW — N6: install.sh run a second time as the first run was, then the PATH block in
# the account's rc files, what new interactive shells find, and the closing words of both runs.
again() {
  local acct=$1 home first=$OUT rc sums found sh
  home=$(home_of "$acct")
  sums="$(sha_of "$home/.bashrc") $(sha_of "$home/.zshrc")"
  echo ""
  echo "==> N6 $acct installs a second time"
  install_as "$acct" "$2"
  exited N6
  for rc in .bashrc .zshrc; do
    expect N6 "$home/$rc PATH blocks" "$(blocks "$acct" "$rc")" 1
    expect N6 "$home/$rc owner" "$(st '%U:%G' "$home/$rc")" "$acct:$(cx id -gn "$acct")"
  done
  expect N6 "sha256 of $home/.bashrc and .zshrc, as the first run left them" \
    "$(sha_of "$home/.bashrc") $(sha_of "$home/.zshrc")" "$sums"
  for sh in bash zsh; do
    found=$(found_by "$acct" "$sh")
    expect N6 "orbit in a new interactive $sh of $acct" "${found:-nothing}" "$home/.orbit/bin/orbit"
  done
  closing N6 1 "$acct" "$first"
  closing N6 2 "$acct" "$OUT"
}

# --- build ---------------------------------------------------------------------------------------

[ -f "$INSTALL_SH" ] || harness_fail "no such file: $INSTALL_SH"
command -v docker >/dev/null || harness_fail "docker is not installed"
docker version >/dev/null 2>&1 || harness_fail "cannot talk to the docker daemon"

echo "==> install.sh under test: $INSTALL_SH, sha256 $(sha256sum "$INSTALL_SH" | cut -d' ' -f1)"
echo "==> harness from $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'); docker $(docker version --format '{{.Server.Version}} {{.Server.Arch}}')"
build=$(docker build -t "$IMAGE" "$HERE" 2>&1) || {
  echo "$build" >&2
  harness_fail "building $IMAGE from $HERE failed"
}
SHA=$(sha256sum "$HERE/orbit-stub" | cut -d' ' -f1)
served=$(docker run --rm --network none "$IMAGE" sh -c 'gzip -dc /srv/stub/dl/orbit-linux-*.gz | sha256sum | cut -d" " -f1')
[ "$served" = "$SHA" ] || harness_fail "the stub serves a release with sha256 $served, not orbit-stub's $SHA"
echo "==> image $IMAGE; the release is orbit-stub, sha256 $SHA"
echo "    alice: passwordless sudo; bob: no sudo right"

# --- set up: the runner template is in place ----------------------------------------------------

fresh "S1 set up; alice runs curl … | bash" setup
install_as alice pipe
exited S1
machine_binary S1
cannot S1 alice "write $BIN" "echo tampered >>$BIN"
cannot S1 alice "rename another file over $BIN" 'f=$(mktemp) && mv -f "$f" '"$BIN"
cannot S1 alice "replace $BIN with a link" "ln -sf /bin/sh $BIN"
cannot S1 alice "remove $BIN" "rm -f $BIN"

fresh "S2 set up, /usr/local/bin writable by alice's group (root:alice 2775); alice runs curl … | bash" setup
{ cx chgrp alice /usr/local/bin && cx chmod 2775 /usr/local/bin; } || harness_fail "cannot give /usr/local/bin to alice's group"
install_as alice pipe
exited S2
machine_binary S2
cannot S2 alice "write $BIN" "echo tampered >>$BIN"
echo "    note: S2 does not check replacing $BIN: a group that can write /usr/local/bin can rename and remove anything in it, whoever owns it, and orbit host setup refuses such a directory"

fresh "S3 set up, /usr/local/bin writable by bob's group (root:bob 2775); bob runs curl … | bash" setup
{ cx chgrp bob /usr/local/bin && cx chmod 2775 /usr/local/bin; } || harness_fail "cannot give /usr/local/bin to bob's group"
install_as bob pipe
if [ "$RC" -ne 0 ]; then pass S3 "install.sh exit status: $RC, not 0"; else fail S3 "install.sh exit status: 0, want a failure"; fi
said=$(grep -i -m 1 'needs root' <<<"$OUT")
if [ -n "$said" ]; then pass S3 "the output says root is needed: $said"; else fail S3 "the output does not say that root is needed"; fi
owner=$(st '%u (%U)' "$BIN")
if [ "${owner%% *}" != "$(uid_of bob)" ]; then pass S3 "$BIN is not bob's: $owner"; else fail S3 "$BIN is bob's: $owner"; fi

fresh "S4 set up; root runs curl … | bash" setup
install_as root pipe
exited S4
machine_binary S4

fresh "S5 set up; alice runs curl … | sudo env … bash (stdin a pipe, SUDO_USER=alice)" setup
install_as alice sudo-pipe
exited S5
machine_binary S5

fresh "S6 set up, $BIN a link to alice's own ~/.orbit/bin/orbit (the earlier single-account layout); alice runs curl … | bash" setup
own=/home/alice/.orbit/bin/orbit
{ cx install -d -o alice -g alice -m 0700 /home/alice/.orbit && cx install -d -o alice -g alice /home/alice/.orbit/bin &&
  cx install -o alice -g alice -m 0755 /bin/true "$own" && cx ln -s "$own" "$BIN"; } || harness_fail "cannot lay out S6"
own_before="$(st '%F %U %a' "$own"), sha256 $(sha_of "$own")"
install_as alice pipe
exited S6
machine_binary S6
expect S6 "$own, where the link led" "$(st '%F %U %a' "$own"), sha256 $(sha_of "$own")" "$own_before"

fresh "S7 set up, $BIN running (a copy of sleep); alice runs curl … | bash" setup
{ cx install -m 0755 /bin/sleep "$BIN" && docker exec -d "$CTR" "$BIN" 600; } || harness_fail "cannot start $BIN"
pid=""
for _ in $(seq 50); do
  pid=$(cx sh -c 'for p in /proc/[0-9]*; do [ "$(readlink "$p/exe")" = "$1" ] && echo "${p#/proc/}"; done; true' sh "$BIN" | head -n 1)
  [ -n "$pid" ] && break
  sleep 0.1
done
[ -n "$pid" ] || harness_fail "$BIN did not start"
if out=$(cx cp /opt/install-sh-e2e/orbit-stub "$BIN" 2>&1); then
  fail S7 "control: writing into the running $BIN succeeded, so this run cannot tell replacing it from writing into it"
else
  pass S7 "control: writing into the running $BIN fails: $out"
fi
install_as alice pipe
exited S7
machine_binary S7
expect S7 "the process that was running $BIN (pid $pid) runs" "$(cx readlink "/proc/$pid/exe" 2>/dev/null || echo nothing)" "$BIN (deleted)"

# --- not set up: no template --------------------------------------------------------------------

fresh "N1 not set up; bob runs curl … | bash"
install_as bob pipe
exited N1
own_binary N1 bob
no_sudo N1 bob
no_machine_binary N1
again bob pipe

fresh "N2 not set up; root runs curl … | bash"
install_as root pipe
exited N2
own_binary N2 root
no_machine_binary N2
again root pipe

fresh "N3 not set up; alice runs sudo env … bash install.sh"
install_as alice sudo-file
exited N3
own_binary N3 alice
expect N3 "/home/alice/.orbit/bin owner" "$(st %U /home/alice/.orbit/bin)" alice
for rc in .bashrc .zshrc; do
  expect N3 "/home/alice/$rc owner" "$(st '%U:%G' "/home/alice/$rc")" "alice:alice"
done
no_machine_binary N3
again alice sudo-file

for kind in file link; do
  for who in alice "alice through sudo" root; do
    fresh "N4 not set up, $BIN already there as a root-owned $kind; $who installs"
    case $kind in
      file) cx install -m 0755 /bin/true "$BIN" ;;
      link) cx sh -c "mkdir -p /opt/legacy && install -m 0755 /bin/true /opt/legacy/orbit && ln -s /opt/legacy/orbit $BIN" ;;
    esac || harness_fail "cannot put a $kind at $BIN"
    type_before=$(st %F "$BIN")
    owner_before=$(st '%u:%g' "$BIN")
    what_before=$(what_is "$BIN")
    case $who in
      alice) install_as alice pipe ;;
      root) install_as root pipe ;;
      *) install_as alice sudo-pipe ;;
    esac
    exited N4
    expect N4 "$BIN type" "$(st %F "$BIN")" "$type_before"
    expect N4 "$BIN owner" "$(st '%u:%g' "$BIN")" "$owner_before"
    expect N4 "$BIN target and content" "$(what_is "$BIN")" "$what_before"
  done
done

fresh "N5 not set up; bob runs curl … | ORBIT_BIN_DIR=/home/bob/bin bash, a directory of his"
cx install -d -o bob -g bob /home/bob/bin || harness_fail "cannot create /home/bob/bin"
install_as bob pipe ORBIT_BIN_DIR=/home/bob/bin
exited N5
expect N5 "/home/bob/bin/orbit type" "$(st %F /home/bob/bin/orbit)" "regular file"
expect N5 "/home/bob/bin/orbit owner" "$(st '%u (%U)' /home/bob/bin/orbit)" "$(uid_of bob) (bob)"
expect N5 "/home/bob/bin/orbit sha256" "$(sha_of /home/bob/bin/orbit)" "$SHA"
for rc in .bashrc .zshrc; do
  expect N5 "/home/bob/$rc PATH blocks" "$(blocks bob "$rc")" 0
done
no_machine_binary N5
no_sudo N5 bob
echo "INFO N5 /home/bob/bin/orbit mode $(st %a /home/bob/bin/orbit), printed to compare runs before and after a change"

fresh "N7 not set up; alice runs curl … | ORBIT_BIN_DIR=/usr/local/bin/ bash, the machine's directory"
install_as alice pipe ORBIT_BIN_DIR=/usr/local/bin/
exited N7
machine_binary N7
for rc in .bashrc .zshrc; do
  expect N7 "/home/alice/$rc PATH blocks" "$(blocks alice "$rc")" 0
done

drop
echo ""
echo "==> $PASSED passed, $FAILED failed, install.sh: $INSTALL_SH"
[ "$FAILED" -eq 0 ] || exit 1
