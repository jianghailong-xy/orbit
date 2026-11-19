#!/usr/bin/env bash
# Install the Orbit runner CLI and register this machine:
#   curl -fsSL https://orbitd.io/install.sh | bash
# Extra args go to `orbit register`:  ... | bash -s -- --labels sg --max-concurrent 2
# Set ORBIT_NO_REGISTER=1 to install the binary only.
#
# The binary goes to ~/.orbit/bin/orbit of the account the runner service runs as (under sudo, the
# account that invoked it; root included), where the runner can replace it when it updates itself.
# That holds on a machine set up with `orbit host setup` too: each account's runner there runs its
# own copy, and /usr/local/bin/orbit is hostd's alone, which install.sh never writes. A launcher,
# ~/.local/bin/orbit, is a symlink to it. install.sh never edits ~/.bashrc or ~/.zshrc: when
# ~/.local/bin is not on PATH, it prints the line that adds it, for the account to run. The account
# writes all of that itself, under sudo too, so root follows no link in its home, and it runs
# `orbit register` itself, so root never executes a file the account can replace.
# Set ORBIT_BIN_DIR to install the binary straight into that directory instead; naming
# /usr/local/bin puts a file of root's there (uid 0, gid 0, mode 0755), through sudo unless already
# root, or nothing.
set -euo pipefail

BASE_URL="${ORBIT_BASE_URL:-https://orbitd.io}"
MACHINE_DIR="/usr/local/bin"
NAME="orbit"

case "$(uname -s)" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "orbit: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "orbit: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

asset="orbit-${os}-${arch}"
url="${BASE_URL}/dl/${asset}.gz"
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.gz"' EXIT

# The plan comes before anything changes on the machine: what is installed, what
# registration does, and that a missing coding engine is installed on demand.
if [ -z "${ORBIT_NO_REGISTER:-}" ] && { : < /dev/tty; } 2>/dev/null; then
  cat <<'EOF'
Orbit runner setup
  Installs Orbit, adds this machine to your account, keeps it running
  in the background, and automatically installs an engine when work
  needs one.

EOF
fi

echo "Downloading Orbit for ${os}-${arch}..."
if ! curl -fsSL "$url" -o "$tmp.gz"; then
  echo "orbit: download failed ($url)" >&2
  exit 1
fi
gzip -dc "$tmp.gz" > "$tmp"
chmod +x "$tmp"

# as_root runs one command as root: directly when we already are, through sudo otherwise.
as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; else sudo "$@"; fi
}

# The account the runner service will run as: us, under sudo the account that invoked it, or
# root itself, each with its own home.
if [ "$(id -u)" != "0" ]; then
  owner="$(id -un)"
  home="${HOME:-}"
elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  owner="$SUDO_USER"
  case "$owner" in
    *[!A-Za-z0-9._@-]*) echo "orbit: cannot install for SUDO_USER=${owner}; set ORBIT_BIN_DIR" >&2; exit 1 ;;
  esac
  home="$(eval echo "~${owner}")"
else
  owner="root"
  home="$(eval echo "~root")"
fi

# as_owner runs one command as that account: directly when we are it, through sudo otherwise, so
# that what it writes in its home is its own, wherever a link there leads.
as_owner() {
  if [ "$(id -un)" = "$owner" ]; then "$@"; else sudo -u "$owner" -- "$@"; fi
}

# ORBIT_BIN_DIR naming /usr/local/bin writes /usr/local/bin/orbit, which root may run (hostd does,
# on a machine set up with `orbit host setup`): whatever is written there has to be root's alone.
machine=""
if [ -n "${ORBIT_BIN_DIR:-}" ]; then
  if [ "${ORBIT_BIN_DIR%/}" = "$MACHINE_DIR" ] || [ "$ORBIT_BIN_DIR" -ef "$MACHINE_DIR" ]; then
    machine=1
  fi
fi

launcher=""
local_bin=""
path_hint=""
if [ -n "$machine" ]; then
  target="${MACHINE_DIR}/${NAME}"
  [ "$(id -u)" = "0" ] || echo "Installing ${target} (needs sudo)..."
  # install(1) sets owner, group (numeric: root's group is wheel on macOS) and mode, and puts a new
  # file in place of the old one rather than writing into it: hostd may be running it, and a link
  # there is replaced, not followed. The directory may not exist yet (e.g.
  # /usr/local/bin on a fresh Apple Silicon Mac).
  if ! { { [ -d "$MACHINE_DIR" ] || as_root mkdir -p "$MACHINE_DIR"; } && as_root install -o 0 -g 0 -m 0755 "$tmp" "$target"; }; then
    echo "orbit: installing ${target} needs root; re-run as root or with sudo" >&2
    exit 1
  fi
  rm -f "$tmp"
elif [ -n "${ORBIT_BIN_DIR:-}" ]; then
  BIN_DIR="$ORBIT_BIN_DIR"
  target="${BIN_DIR}/${NAME}"
  # BIN_DIR may not exist yet, so create it before moving. A missing dir isn't writable, hence
  # falls to the sudo branch.
  if [ -w "$BIN_DIR" ] || [ "$(id -u)" = "0" ]; then
    mkdir -p "$BIN_DIR"
    mv "$tmp" "$target"
  else
    echo "Installing to ${target} (needs sudo)..."
    sudo mkdir -p "$BIN_DIR"
    sudo mv "$tmp" "$target"
  fi
else
  if [ ! -d "$home" ]; then
    echo "orbit: cannot find the home directory of ${owner}; set ORBIT_BIN_DIR" >&2
    exit 1
  fi
  bin_dir="${home}/.orbit/bin"
  target="${bin_dir}/${NAME}"
  # The account does everything in its home itself, through as_owner: under sudo, nothing running
  # as root creates, moves, chmods, chowns or reads anything there, so a link the account put there
  # leads root nowhere, and one leading where the account cannot write fails the install. ~/.orbit
  # also holds the runner's credential, hence private. The binary comes in on stdin (the temp file
  # is root's then) under a new name, which then replaces the old one rather than writing into it:
  # a runner may be running it.
  # shellcheck disable=SC2016
  if ! as_owner sh -c 'set -e
      [ -d "$1" ] || mkdir -m 700 "$1"
      mkdir -p "$2"
      new=$(mktemp "$2/.orbit.XXXXXX")
      cat >"$new" && chmod 0755 "$new" && mv -f "$new" "$3" || { rm -f "$new"; exit 1; }' \
      sh "${home}/.orbit" "$bin_dir" "$target" <"$tmp"; then
    echo "orbit: ${owner} cannot write ${target} (see above); a link at ${home}/.orbit or ${bin_dir} has to lead to a directory ${owner} can write" >&2
    exit 1
  fi
  rm -f "$tmp"
  # A launcher in ~/.local/bin, the conventional user bin directory, is how PATH finds orbit. The
  # account makes it itself, under sudo too. install.sh does not edit the account's rc files; if
  # this shell's PATH does not hold ~/.local/bin, the closing words give the line that adds it.
  local_bin="${home}/.local/bin"
  # shellcheck disable=SC2016
  if as_owner sh -c 'set -e; mkdir -p "$1"; ln -sfn "$2" "$1/orbit"' sh "$local_bin" "$target" </dev/null; then
    launcher="${local_bin}/${NAME}"
    case ":${PATH}:" in
      *":${local_bin}:"*) ;;
      *) path_hint=1 ;;
    esac
  else
    echo "note: could not create ${local_bin}/${NAME}; use ${target} directly" >&2
  fi
fi
trap - EXIT

# Asked as the account too: under sudo, the binary may be the one in the account's home.
ver="$(as_owner "$target" version </dev/null 2>/dev/null || echo '?')"
echo ""
echo "✓ Orbit ${ver} installed to ${target}"
if [ -n "$launcher" ]; then
  echo "  Launcher: ${launcher} -> ${target}"
  if [ -n "$path_hint" ]; then
    # shellcheck disable=SC2016
    cat <<EOF
  ${local_bin} is not on PATH. Add it in your shell startup file:
    echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.zshrc && source ~/.zshrc    # zsh
    echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.bashrc && source ~/.bashrc  # bash
EOF
  else
    echo "  ${local_bin} is on PATH: new terminals find orbit there."
  fi
  echo "  Non-interactive use (ssh host cmd, cron): ${target}."
fi

# Hand straight off to `orbit register` so install + connect is one command. `curl … | bash`
# leaves stdin bound to the pipe, so reattach the terminal first — otherwise register's
# prompts (runner name, sudo for the background service) read EOF and silently take defaults.
# Under sudo, register runs as the account, never as root: the binary may be the one in the
# account's home, which the account can replace at any moment. It asks for sudo itself for the
# background service, as when the account runs install.sh, and -H gives it the account's home,
# where its credential goes.
# Without a terminal (CI, image build) just print the next step.
if [ -z "${ORBIT_NO_REGISTER:-}" ] && { : < /dev/tty; } 2>/dev/null; then
  if [ "$(id -un)" = "$owner" ]; then
    ORBIT_INSTALL_PLAN=1 exec "$target" register ${1+"$@"} < /dev/tty
  fi
  exec sudo -H -u "$owner" -- env ORBIT_INSTALL_PLAN=1 "$target" register ${1+"$@"} < /dev/tty
fi
echo "Next:  ${target} register"
