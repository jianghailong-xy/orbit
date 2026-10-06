#!/usr/bin/env bash
# Install the Orbit runner CLI and register this machine:
#   curl -fsSL https://orbitd.io/install.sh | bash
# Extra args go to `orbit register`:  ... | bash -s -- --labels sg --max-concurrent 2
# Set ORBIT_NO_REGISTER=1 to install the binary only.
#
# The binary goes to ~/.orbit/bin/orbit of the account the runner service runs as (under
# sudo, the account that invoked it), where the runner can replace it when it updates
# itself; /usr/local/bin/orbit becomes a symlink to it, the only step that needs sudo.
# Set ORBIT_BIN_DIR to install the binary straight into that directory instead.
set -euo pipefail

BASE_URL="${ORBIT_BASE_URL:-https://orbitd.io}"
LINK_DIR="/usr/local/bin"
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

echo "Downloading ${asset}..."
if ! curl -fSL "$url" -o "$tmp.gz"; then
  echo "orbit: download failed ($url)" >&2
  exit 1
fi
gzip -dc "$tmp.gz" > "$tmp"
chmod +x "$tmp"

# as_root runs one command as root: directly when we already are, through sudo otherwise.
as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; else sudo "$@"; fi
}

# The account the runner service will run as: us, or under sudo the account that invoked it.
# Root itself keeps the machine-wide /usr/local/bin, which a root service can update in place.
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
  home=""
fi

# Another account's runner unit that runs the shared /usr/local/bin/orbit (a host set up with
# `orbit host setup`, or several users' runners) keeps the binary where it is: moving it into
# one home would take it away from the others.
shared=""
for unit in /etc/systemd/system/orbit-*.service; do
  if [ -f "$unit" ] && grep -q "^ExecStart=${LINK_DIR}/${NAME} " "$unit" && ! grep -qx "User=${owner}" "$unit"; then
    shared="$unit"
  fi
done

link=""
if [ -n "${ORBIT_BIN_DIR:-}" ] || [ "$owner" = "root" ] || [ -n "$shared" ]; then
  [ -z "$shared" ] || echo "note: ${shared} runs ${LINK_DIR}/${NAME} for another account, so it stays a shared binary."
  BIN_DIR="${ORBIT_BIN_DIR:-$LINK_DIR}"
  target="${BIN_DIR}/${NAME}"
  # BIN_DIR may not exist yet (e.g. /usr/local/bin is absent on a fresh Apple Silicon Mac),
  # so create it before moving. A missing dir isn't writable, hence falls to the sudo branch.
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
  # ~/.orbit also holds the runner's credential, hence private.
  [ -d "${home}/.orbit" ] || mkdir -m 700 "${home}/.orbit"
  mkdir -p "$bin_dir"
  mv "$tmp" "$target"
  if [ "$(id -u)" = "0" ]; then
    chown "${owner}:$(id -gn "$owner")" "${home}/.orbit" "$bin_dir" "$target"
  fi
  link="${LINK_DIR}/${NAME}"
fi
trap - EXIT

cmd="$NAME"
if [ -n "$link" ]; then
  [ "$(id -u)" = "0" ] || echo "Linking ${link} -> ${target} (needs sudo)..."
  if ! { as_root mkdir -p "$LINK_DIR" && as_root ln -sf "$target" "$link"; }; then
    echo "orbit: could not link ${link}; run ${target} directly" >&2
    link=""
    cmd="$target"
  fi
fi

ver="$("$target" version 2>/dev/null || echo '?')"
echo ""
echo "✓ orbit ${ver} installed to ${target}"
[ -z "$link" ] || echo "  ${link} -> ${target}"

# Hand straight off to `orbit register` so install + connect is one command. `curl … | bash`
# leaves stdin bound to the pipe, so reattach the terminal first — otherwise register's
# prompts (runner name, engine install, sudo for the background service) read EOF and
# silently take defaults. Without a terminal (CI, image build) just print the next step.
if [ -z "${ORBIT_NO_REGISTER:-}" ] && { : < /dev/tty; } 2>/dev/null; then
  exec "$target" register ${1+"$@"} < /dev/tty
fi
echo "Next:  ${cmd} register"
