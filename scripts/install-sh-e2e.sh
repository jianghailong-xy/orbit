#!/usr/bin/env bash
# Container tests for the runner installer, src/web/public/install.sh: where it puts the orbit
# binary, whose it is, and what it leaves on PATH, on a machine set up with `orbit host setup` and on
# one that is not.
#
#   scripts/install-sh-e2e.sh [path/to/install.sh]
#
# Runs the given install.sh (by default this tree's src/web/public/install.sh) the way people run it,
# piped from curl into bash, with ORBIT_NO_REGISTER=1 in every scenario but R1. Every scenario gets
# a fresh container of scripts/install-sh-e2e/Dockerfile: Debian 12 with sudo and zsh, alice
# (passwordless sudo), bob (no sudo right), and a stub on 127.0.0.1:8000, reached through
# ORBIT_BASE_URL, that serves install.sh and the release (scripts/install-sh-e2e/orbit-stub, gzipped
# as /dl/orbit-linux-<arch>.gz). The accounts' sudo logs every call, so a run shows whether
# install.sh asked for it.
#
# Set up (the template `orbit host setup` writes, scripts/install-sh-e2e/orbit-runner@.service), each
# run once with no /usr/local/bin/orbit and once with a root-owned file there (hostd's binary, put in
# place by the admin before setup). Every run installs as on a machine that is not set up: the
# account's own ~/.orbit/bin/orbit, a regular file of its own with mode 0755 and the release; its
# ~/.local/bin/orbit, a symlink of its own to that file; both rc files as they were; the closing
# hint; and /usr/local/bin/orbit as it was before (type, owner, group, mode, sha256, or absent):
#   S1  alice (passwordless sudo) runs curl … | bash: no sudo call either
#   S2  bob (no sudo right) runs curl … | bash: no sudo call either
#   S3  bob, with /usr/local/bin writable by bob's group (root:bob 2775): no sudo call either
#   S4  root runs curl … | bash: root's own /root/.orbit/bin/orbit, as N2
#   S5  alice pipes it into sudo (curl … | sudo env … bash): her own copy, all hers, as N3
# Not set up (no template):
#   N1  bob installs: his own ~/.orbit/bin/orbit and ~/.local/bin/orbit, the release, without sudo;
#       no /usr/local/bin/orbit, and his rc files are left as they were
#   N2  root installs: /root/.orbit/bin/orbit and /root/.local/bin/orbit, root's; no
#       /usr/local/bin/orbit, rc files untouched
#   N3  alice installs through sudo (sudo env … bash install.sh): her ~/.orbit/bin/orbit and
#       ~/.local/bin/orbit, all hers; no /usr/local/bin/orbit, and her rc files are left as they were
#   N4  /usr/local/bin/orbit is there already, a root-owned file or a link; alice, alice through
#       sudo, and root install: it is left as it was
#   N5  bob installs with ORBIT_BIN_DIR=/home/bob/bin, a directory of his: the binary there, his, no
#       launcher, no /usr/local/bin/orbit, rc files untouched; its mode is printed, to compare runs
#       of two versions
#   N6  N1, N2 and N3 install a second time: the launcher is still the account's symlink to its own
#       copy, ~/.bashrc and ~/.zshrc are as the first run left them (install.sh edits neither), a
#       shell with ~/.local/bin on PATH finds the account's own copy, and both runs print the
#       closing hint and name the binary by its absolute path
#   N7  alice installs with ORBIT_BIN_DIR=/usr/local/bin/: /usr/local/bin/orbit is a regular file, uid
#       0, gid 0, mode 0755, the release, never one of hers, with no launcher
#   N8  alice's ~/.orbit/bin/orbit is running (a copy of sleep); alice installs through sudo (curl … |
#       sudo env … bash): it is replaced, not written into, by a file of hers with mode 0755
# Not set up, with a link alice planted in her home; she installs through sudo, as in N8:
#   L1  ~/.orbit/bin is a link to /etc/systemd/system, root's
#   L2  ~/.orbit is a link to /etc/systemd/system
#       /etc/systemd/system then keeps its own owner, group and mode, every entry under it keeps its
#       type, owner, group, mode and sha256 (a link, its target), and nothing new appears there; the
#       listing is printed before and after. install.sh either exits 0 with alice's binary in a
#       directory she can write, or fails with a line of its own naming the binary it could not write
# Not set up, at a terminal (script(1)) and without ORBIT_NO_REGISTER, so install.sh ends by handing
# off to `orbit register`:
#   R1  alice planted a file of hers at ~/.orbit/bin/orbit (scripts/install-sh-e2e/planted-orbit,
#       which logs every run and, run as root, leaves /etc/install-sh-e2e-planted), and an agent of
#       hers (keep-planted) puts it back within milliseconds whenever install.sh writes the release
#       over it; she runs curl … | sudo env … bash -s -- --labels sg --max-concurrent 2: root never
#       runs that file, and register is handed off to it as alice, with those arguments,
#       ORBIT_INSTALL_PLAN=1, her HOME and the terminal on stdin
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

# install_at_terminal ACCOUNT LINE — LINE run as install_as runs it, but at a terminal of its own:
# script(1) gives it one, so install.sh finds /dev/tty and ends by handing off to `orbit register`.
# The terminal ends each line with CR LF; OUT has the CRs taken out. Sets OUT, RC and SUDO_CALLS.
install_at_terminal() {
  cx truncate -s 0 "$SUDO_LOG"
  echo "    $1\$ $2    (at a terminal: script -qec … /dev/null)"
  OUT=$(as "$1" "SHELL=/bin/bash script -qec $(printf '%q' "set -o pipefail; $2") /dev/null" 2>&1)
  RC=$?
  OUT=$(tr -d '\r' <<<"$OUT")
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
# launcher_of ACCOUNT — where the account's launcher lives.
launcher_of() { echo "$(home_of "$1")/.local/bin/orbit"; }
# launcher ID ACCOUNT — ~/.local/bin/orbit is a link, the account's, to the account's own copy.
launcher() {
  local link target
  link=$(launcher_of "$2")
  target="$(home_of "$2")/.orbit/bin/orbit"
  expect "$1" "$link type" "$(st %F "$link")" "symbolic link"
  expect "$1" "$link owner" "$(st '%u (%U)' "$link")" "$(uid_of "$2") ($2)"
  expect "$1" "$link target" "$(cx readlink "$link")" "$target"
}
# no_launcher ID ACCOUNT — the account has no ~/.local/bin/orbit.
no_launcher() { expect "$1" "$(launcher_of "$2")" "$(st %F "$(launcher_of "$2")")" absent; }
# rc_sums ACCOUNT — the sha256 of the account's two rc files, or absent for one that is not there.
rc_sums() {
  local home
  home=$(home_of "$1")
  echo "$(sha_of "$home/.bashrc") $(sha_of "$home/.zshrc")"
}
# rcs_kept ID ACCOUNT BEFORE — install.sh left the account's rc files exactly as BEFORE.
rcs_kept() { expect "$1" "sha256 of $(home_of "$2")/.bashrc and .zshrc, as it left them" "$(rc_sums "$2")" "$3"; }
# found_from ACCOUNT SHELL MODE PATH — what `command -v orbit` prints in a new SHELL of ACCOUNT run
# with just PATH in the environment, so what that PATH holds, not a startup file, decides.
found_from() {
  local home
  home=$(home_of "$1")
  docker exec -u "$1" -w "$home" "$CTR" env -i HOME="$home" USER="$1" LOGNAME="$1" PATH="$4" TERM=dumb \
    timeout 30 "$2" "$3" 'command -v orbit' </dev/null 2>/dev/null
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

# closing ID RUN ACCOUNT OUTPUT — the closing words of a home install: the launcher, the line that
# adds ~/.local/bin to PATH when it is not there, non-interactive use (ssh, cron) the absolute path,
# and the Next: line names the binary by that path.
closing() {
  local target link next missing=""
  target="$(home_of "$3")/.orbit/bin/orbit"
  link="$(launcher_of "$3")"
  grep -qF "Launcher: $link -> $target" <<<"$4" || missing="$missing [launcher line]"
  grep -qF 'export PATH="$HOME/.local/bin:$PATH"' <<<"$4" || missing="$missing [PATH line]"
  grep -qF '>> ~/.zshrc' <<<"$4" || missing="$missing [~/.zshrc]"
  grep -qF '>> ~/.bashrc' <<<"$4" || missing="$missing [~/.bashrc]"
  grep -F 'ssh' <<<"$4" | grep -F 'cron' | grep -qF "$target" || missing="$missing [ssh and cron: $target]"
  if [ -z "$missing" ]; then
    pass "$1" "run $2 printed the closing hint: $(grep -F 'cron' <<<"$4" | sed 's/^ *//')"
  else
    fail "$1" "run $2 printed no closing hint, missing:$missing"
  fi
  next=$(grep '^Next:' <<<"$4" | head -n 1)
  expect "$1" "run $2's Next: line" "${next:-nothing}" "Next:  $target register"
}

# again ACCOUNT HOW — N6: install.sh run a second time as the first run was, then the launcher, the
# account's rc files, what shells with ~/.local/bin on PATH find, and the closing words of both runs.
again() {
  local acct=$1 home first=$OUT link link_before rc_before found sh
  home=$(home_of "$acct")
  link="$home/.local/bin/orbit"
  link_before="$(what_is "$link")"
  rc_before="$(rc_sums "$acct")"
  echo ""
  echo "==> N6 $acct installs a second time"
  install_as "$acct" "$2"
  exited N6
  launcher N6 "$acct"
  expect N6 "$link as the first run left it" "$(what_is "$link")" "$link_before"
  expect N6 "sha256 of $home/.bashrc and .zshrc, as the first run left them" "$(rc_sums "$acct")" "$rc_before"
  for sh in bash zsh; do
    found=$(found_from "$acct" "$sh" -c "$home/.local/bin:$PLAIN_PATH")
    expect N6 "orbit in a new non-interactive $sh of $acct, ~/.local/bin on PATH" "${found:-nothing}" "$link"
    found=$(found_from "$acct" "$sh" -ic "$home/.local/bin:$PLAIN_PATH")
    expect N6 "orbit in a new interactive $sh of $acct, ~/.local/bin on PATH" "${found:-nothing}" "$link"
  done
  closing N6 1 "$acct" "$first"
  closing N6 2 "$acct" "$OUT"
}

# listing DIR — DIR, then everything under it, links not followed, a line each: the path, type,
# owner, group and mode, and a regular file's sha256 or a link's target.
listing() {
  cx sh -c 'find "$1" | LC_ALL=C sort | while IFS= read -r p; do
      if [ -L "$p" ]; then what=", -> $(readlink "$p")"
      elif [ -f "$p" ]; then what=", sha256 $(sha256sum <"$p" | cut -d" " -f1)"
      else what=""; fi
      echo "$(stat -c "%n: %F, %U:%G %a" "$p")$what"
    done' sh "$1"
}
# entries LISTING — the lines of a listing below the directory's own; paths LISTING — their paths.
entries() { tail -n +2 <<<"$1" | LC_ALL=C sort; }
paths() { entries "$1" | sed 's/: .*//' | LC_ALL=C sort; }

# kept ID DIR BEFORE — DIR's listing now, printed, is BEFORE: the directory's own owner, group and
# mode, every entry under it as it was, and no entry that was not there.
kept() {
  local now lost gained
  now=$(listing "$2")
  sed 's/^/    after:  /' <<<"$now"
  expect "$1" "$2 itself" "$(head -n 1 <<<"$now")" "$(head -n 1 <<<"$3")"
  lost=$(LC_ALL=C comm -23 <(entries "$3") <(entries "$now"))
  if [ -z "$lost" ]; then
    pass "$1" "the $(paths "$3" | wc -l) entries under $2 are as they were: type, owner, group, mode, sha256 or link target"
  else
    fail "$1" "entries under $2 no longer as they were: $(tr '\n' ';' <<<"$lost" | sed 's/;$//; s/;/; /g')"
  fi
  gained=$(LC_ALL=C comm -13 <(paths "$3") <(paths "$now") | tr '\n' ' ' | sed 's/ $//')
  expect "$1" "new entries under $2" "${gained:-none}" none
}

# machine_state — /usr/local/bin/orbit itself, a link not followed: its type, owner, group and mode,
# and the sha256 of what it holds; "absent, sha256 absent" when there is nothing.
machine_state() { echo "$(st '%F, %u:%g, mode %a' "$BIN"), sha256 $(sha_of "$BIN")"; }

# set_up ID ACCOUNT HOW BIN — on a machine set up with orbit host setup, ACCOUNT runs install.sh
# (HOW as in install_as) with /usr/local/bin/orbit absent or a root-owned file (BIN: absent or
# file). It installs as on a machine not set up, and leaves /usr/local/bin/orbit as it was. A run
# through sudo is a sudo call itself, and root has no sudo to log, so only the accounts' own runs
# are held to no sudo call.
set_up() {
  local id=$1 acct=$2 how=$3 home rc_before bin_before
  home=$(home_of "$acct")
  if [ "$4" = file ]; then
    cx install -o 0 -g 0 -m 0755 /bin/true "$BIN" || harness_fail "cannot put a root-owned file at $BIN"
  fi
  bin_before=$(machine_state)
  echo "    before: $BIN $bin_before"
  rc_before=$(rc_sums "$acct")
  install_as "$acct" "$how"
  exited "$id"
  own_binary "$id" "$acct"
  expect "$id" "$home/.orbit/bin/orbit mode" "$(st %a "$home/.orbit/bin/orbit")" 755
  launcher "$id" "$acct"
  rcs_kept "$id" "$acct" "$rc_before"
  if [ "$acct" != root ] && [ "$how" = pipe ]; then no_sudo "$id" "$acct"; fi
  expect "$id" "$BIN type, owner, group, mode and sha256, as before" "$(machine_state)" "$bin_before"
  closing "$id" 1 "$acct" "$OUT"
}

# planted ID REL SETUP — L1 and L2: on a machine not set up, with a unit of root's added to
# /etc/systemd/system, alice runs SETUP, which makes ~/REL a link to that directory, and then pipes
# install.sh into sudo. The directory is kept as it was, and install.sh either exits 0 with her
# binary in a directory she can write, or fails with a line of its own naming the binary.
planted() {
  local dir=/etc/systemd/system own=/home/alice/.orbit/bin/orbit before where said
  fresh "$1 not set up, alice's ~/$2 a link to $dir (root's); alice runs curl … | sudo env … bash"
  cx sh -c "printf '[Service]\nExecStart=/usr/local/sbin/site-backup\n' >$dir/site-backup.service" ||
    harness_fail "cannot add a unit of root's to $dir"
  as alice "$3" || harness_fail "cannot make alice's ~/$2 a link to $dir"
  echo "    alice planted: $(cx ls -ld "/home/alice/$2")"
  before=$(listing "$dir")
  sed 's/^/    before: /' <<<"$before"
  install_as alice sudo-pipe
  kept "$1" "$dir" "$before"
  if [ "$RC" -eq 0 ]; then
    where=$(cx readlink -e "$own")
    if [ -n "$where" ] && as alice "test -w '$(dirname "$where")'"; then
      pass "$1" "install.sh exit status 0, alice's binary $own is $where, in a directory she can write"
    else
      fail "$1" "install.sh exit status 0, but $own (${where:-absent}) is not in a directory alice can write"
    fi
  else
    said=$(grep -m 1 "^orbit: .*$own" <<<"$OUT")
    if [ -n "$said" ]; then
      pass "$1" "install.sh exit status $RC, and it says why: $said"
    else
      fail "$1" "install.sh exit status $RC, with no line of its own naming $own"
    fi
  fi
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

for bin in absent file; do
  case $bin in
    absent) had="no $BIN" ;;
    file) had="$BIN a root-owned file" ;;
  esac
  fresh "S1 set up, $had; alice runs curl … | bash" setup
  set_up S1 alice pipe "$bin"

  fresh "S2 set up, $had; bob runs curl … | bash" setup
  set_up S2 bob pipe "$bin"

  fresh "S3 set up, $had, /usr/local/bin writable by bob's group (root:bob 2775); bob runs curl … | bash" setup
  { cx chgrp bob /usr/local/bin && cx chmod 2775 /usr/local/bin; } || harness_fail "cannot give /usr/local/bin to bob's group"
  set_up S3 bob pipe "$bin"

  fresh "S4 set up, $had; root runs curl … | bash" setup
  set_up S4 root pipe "$bin"

  fresh "S5 set up, $had; alice runs curl … | sudo env … bash (stdin a pipe, SUDO_USER=alice)" setup
  set_up S5 alice sudo-pipe "$bin"
  expect S5 "/home/alice/.orbit/bin owner" "$(st %U /home/alice/.orbit/bin)" alice
done

# --- not set up: no template --------------------------------------------------------------------

fresh "N1 not set up; bob runs curl … | bash"
rc_before=$(rc_sums bob)
install_as bob pipe
exited N1
own_binary N1 bob
launcher N1 bob
rcs_kept N1 bob "$rc_before"
no_sudo N1 bob
no_machine_binary N1
again bob pipe

fresh "N2 not set up; root runs curl … | bash"
rc_before=$(rc_sums root)
install_as root pipe
exited N2
own_binary N2 root
launcher N2 root
rcs_kept N2 root "$rc_before"
no_machine_binary N2
again root pipe

fresh "N3 not set up; alice runs sudo env … bash install.sh"
rc_before=$(rc_sums alice)
install_as alice sudo-file
exited N3
own_binary N3 alice
expect N3 "/home/alice/.orbit/bin owner" "$(st %U /home/alice/.orbit/bin)" alice
launcher N3 alice
rcs_kept N3 alice "$rc_before"
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
rc_before=$(rc_sums bob)
cx install -d -o bob -g bob /home/bob/bin || harness_fail "cannot create /home/bob/bin"
install_as bob pipe ORBIT_BIN_DIR=/home/bob/bin
exited N5
expect N5 "/home/bob/bin/orbit type" "$(st %F /home/bob/bin/orbit)" "regular file"
expect N5 "/home/bob/bin/orbit owner" "$(st '%u (%U)' /home/bob/bin/orbit)" "$(uid_of bob) (bob)"
expect N5 "/home/bob/bin/orbit sha256" "$(sha_of /home/bob/bin/orbit)" "$SHA"
no_launcher N5 bob
rcs_kept N5 bob "$rc_before"
no_machine_binary N5
no_sudo N5 bob
echo "INFO N5 /home/bob/bin/orbit mode $(st %a /home/bob/bin/orbit), printed to compare runs before and after a change"

fresh "N7 not set up; alice runs curl … | ORBIT_BIN_DIR=/usr/local/bin/ bash, the machine's directory"
rc_before=$(rc_sums alice)
install_as alice pipe ORBIT_BIN_DIR=/usr/local/bin/
exited N7
machine_binary N7
no_launcher N7 alice
rcs_kept N7 alice "$rc_before"

fresh "N8 not set up, alice's ~/.orbit/bin/orbit running (a copy of sleep); alice runs curl … | sudo env … bash"
own=/home/alice/.orbit/bin/orbit
{ cx install -d -o alice -g alice -m 0700 /home/alice/.orbit && cx install -d -o alice -g alice /home/alice/.orbit/bin &&
  cx install -o alice -g alice -m 0755 /bin/sleep "$own" && docker exec -d -u alice "$CTR" "$own" 600; } ||
  harness_fail "cannot start $own"
pid=""
for _ in $(seq 50); do
  pid=$(docker exec -u alice "$CTR" sh -c 'for p in /proc/[0-9]*; do [ "$(readlink "$p/exe")" = "$1" ] && echo "${p#/proc/}"; done; true' sh "$own" | head -n 1)
  [ -n "$pid" ] && break
  sleep 0.1
done
[ -n "$pid" ] || harness_fail "$own did not start"
if out=$(cx cp /opt/install-sh-e2e/orbit-stub "$own" 2>&1); then
  fail N8 "control: writing into the running $own succeeded, so this run cannot tell replacing it from writing into it"
else
  pass N8 "control: writing into the running $own fails: $out"
fi
rc_before=$(rc_sums alice)
install_as alice sudo-pipe
exited N8
own_binary N8 alice
launcher N8 alice
rcs_kept N8 alice "$rc_before"
expect N8 "$own mode" "$(st %a "$own")" 755
expect N8 "the process that was running $own (pid $pid) runs" "$(docker exec -u alice "$CTR" readlink "/proc/$pid/exe" 2>/dev/null || echo nothing)" "$own (deleted)"

# --- not set up: a link planted in alice's home -------------------------------------------------

planted L1 .orbit/bin 'mkdir -m 700 ~/.orbit && ln -s /etc/systemd/system ~/.orbit/bin'
planted L2 .orbit 'ln -s /etc/systemd/system ~/.orbit'

# --- not set up, at a terminal: install.sh hands off to orbit register --------------------------

fresh "R1 not set up, alice's ~/.orbit/bin/orbit a file she planted, put back by an agent of hers whenever it is replaced; alice runs curl … | sudo env … bash -s -- --labels sg --max-concurrent 2 at a terminal"
own=/home/alice/.orbit/bin/orbit
# Every run of the planted file, and every time the agent put it back; and what the planted file
# leaves behind when root runs it.
ran_log=/var/log/install-sh-e2e-planted.log
mark=/etc/install-sh-e2e-planted
as alice 'mkdir -m 700 ~/.orbit && mkdir ~/.orbit/bin && cp /opt/install-sh-e2e/planted-orbit ~/planted-orbit' ||
  harness_fail "cannot give alice the file she plants"
docker exec -d -u alice "$CTR" /opt/install-sh-e2e/keep-planted /home/alice/planted-orbit "$own" "$ran_log" ||
  harness_fail "cannot start alice's agent"
planted_sha=$(sha_of /home/alice/planted-orbit)
for _ in $(seq 50); do
  [ "$(sha_of "$own")" = "$planted_sha" ] && break
  sleep 0.1
done
[ "$(sha_of "$own")" = "$planted_sha" ] || harness_fail "alice's agent did not put her file at $own"
echo "    alice planted: $(st '%n: %F, %U:%G %a' "$own"), sha256 $planted_sha"
install_at_terminal alice "curl -fsSL $BASE/install.sh | sudo env ORBIT_BASE_URL=$BASE bash -s -- --labels sg --max-concurrent 2"
log=$(cx cat "$ran_log")
sed 's/^/    planted log: /' <<<"$log"
exited R1
# The planted file was in place at the hand-off when its log holds a run for register, and that run
# says who ran it, and how; none means install.sh handed off to something else, or not at all.
handed=$(grep -m 1 -F 'args=[register]' <<<"$log" | sed 's/^ran: //')
expect R1 "the run of the planted file install.sh handed off to register" "${handed:-none}" \
  "uid=$(uid_of alice) user=alice args=[register][--labels][sg][--max-concurrent][2] ORBIT_INSTALL_PLAN=1 HOME=/home/alice stdin-tty=yes"
as_root=$(grep '^ran: uid=0 ' <<<"$log" | sed 's/^ran: //' | tr '\n' ';' | sed 's/;$//; s/;/; /g')
expect R1 "runs of the planted file as root" "${as_root:-none}" none
expect R1 "$mark, which the planted file leaves behind when root runs it" "$(st %F "$mark")" absent
expect R1 "$own" "$(st '%F, %U' "$own"), sha256 $(sha_of "$own")" "regular file, alice, sha256 $planted_sha"

drop
echo ""
echo "==> $PASSED passed, $FAILED failed, install.sh: $INSTALL_SH"
[ "$FAILED" -eq 0 ] || exit 1
