#!/usr/bin/env bash
# Install the Orbit runner CLI and register this machine:
#   curl -fsSL https://orbitd.io/install.sh | bash
# Extra args go to `orbit register`:  ... | bash -s -- --labels sg --max-concurrent 2
# Set ORBIT_NO_REGISTER=1 to install the binary only.
#
# On a machine set up with `orbit host setup`, hostd and every account's runner run
# /usr/local/bin/orbit, so the binary replaces that file as root, owned by uid 0 and gid 0 with
# mode 0755, through sudo unless already root. Anywhere else it goes to ~/.orbit/bin/orbit of the
# account the runner service runs as (under sudo, the account that invoked it; root included),
# where the runner can replace it when it updates itself, and that account's ~/.bashrc and
# ~/.zshrc put ~/.orbit/bin first on PATH: no sudo, and /usr/local/bin/orbit is left as it is.
# The account writes all of that itself, under sudo too, so root follows no link in its home.
# Set ORBIT_BIN_DIR to install the binary straight into that directory instead; /usr/local/bin
# itself is still written as on a set-up machine.
set -euo pipefail

BASE_URL="${ORBIT_BASE_URL:-https://orbitd.io}"
MACHINE_DIR="/usr/local/bin"
TEMPLATE="/etc/systemd/system/orbit-runner@.service"
NAME="orbit"
PATH_BEGIN="# >>> orbit >>>"
PATH_END="# <<< orbit <<<"

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

# A machine set up with `orbit host setup` has the runner template, and then hostd (as root) and
# every account's orbit-runner@<uid> run /usr/local/bin/orbit: whatever is written there has to be
# root's alone, and ORBIT_BIN_DIR naming /usr/local/bin writes that same file.
machine=""
if [ -n "${ORBIT_BIN_DIR:-}" ]; then
  if [ "${ORBIT_BIN_DIR%/}" = "$MACHINE_DIR" ] || [ "$ORBIT_BIN_DIR" -ef "$MACHINE_DIR" ]; then
    machine=1
  fi
elif [ -e "$TEMPLATE" ]; then
  machine=1
fi

rcs=""
if [ -n "$machine" ]; then
  target="${MACHINE_DIR}/${NAME}"
  [ ! -e "$TEMPLATE" ] || echo "note: hostd and every account's runner on this machine run ${target}, so it is installed there, as root."
  [ "$(id -u)" = "0" ] || echo "Installing ${target} (needs sudo)..."
  # install(1) sets owner, group (numeric: root's group is wheel on macOS) and mode, and puts a new
  # file in place of the old one rather than writing into it: hostd and the runners may be running
  # it, and a link there is replaced, not followed. The directory may not exist yet (e.g.
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
  # The account's interactive shells find it first on PATH: one marked block in each rc file,
  # left alone once it is there, which the account looks for and adds itself, as above. $HOME and
  # $PATH in it are for the rc file to expand.
  for rc in "${home}/.bashrc" "${home}/.zshrc"; do
    # shellcheck disable=SC2016
    as_owner sh -c '{ [ -f "$1" ] && grep -qxF "$2" "$1"; } || { [ ! -s "$1" ] || echo; printf "%s\n" "$2" "$3" "$4"; } >>"$1"' \
      sh "$rc" "$PATH_BEGIN" 'export PATH="$HOME/.orbit/bin:$PATH"' "$PATH_END" </dev/null ||
      { echo "note: could not add ${bin_dir} to PATH in ${rc}" >&2; continue; }
    rcs="${rcs:+${rcs}, }${rc}"
  done
fi
trap - EXIT

# Asked as the account too: under sudo, the binary may be the one in the account's home.
ver="$(as_owner "$target" version </dev/null 2>/dev/null || echo '?')"
echo ""
echo "✓ Orbit ${ver} installed to ${target}"
if [ -n "$rcs" ]; then
  echo "  ${bin_dir} is first on PATH in new terminals (${rcs})."
  echo "  In this terminal, log in again or run:  source ~/.bashrc   (zsh: source ~/.zshrc)"
  echo "  Non-interactive use (ssh host cmd, cron) does not read these files: there, use ${target}."
fi

# Hand straight off to `orbit register` so install + connect is one command. `curl … | bash`
# leaves stdin bound to the pipe, so reattach the terminal first — otherwise register's
# prompts (runner name, sudo for the background service) read EOF and silently take defaults.
# Without a terminal (CI, image build) just print the next step.
if [ -z "${ORBIT_NO_REGISTER:-}" ] && { : < /dev/tty; } 2>/dev/null; then
  ORBIT_INSTALL_PLAN=1 exec "$target" register ${1+"$@"} < /dev/tty
fi
echo "Next:  ${target} register"
