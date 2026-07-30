#!/usr/bin/env bash
# Install the Orbit runner CLI and register this machine:
#   curl -fsSL https://orbitd.io/install.sh | bash
# Extra args go to `orbit register`:  ... | bash -s -- --labels sg --max-concurrent 2
# Set ORBIT_NO_REGISTER=1 to install the binary only.
set -euo pipefail

BASE_URL="${ORBIT_BASE_URL:-https://orbitd.io}"
BIN_DIR="${ORBIT_BIN_DIR:-/usr/local/bin}"
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
trap - EXIT

ver="$("$target" version 2>/dev/null || echo '?')"
echo ""
echo "✓ orbit ${ver} installed to ${target}"

# Hand straight off to `orbit register` so install + connect is one command. `curl … | bash`
# leaves stdin bound to the pipe, so reattach the terminal first — otherwise register's
# prompts (runner name, engine install, sudo for the background service) read EOF and
# silently take defaults. Without a terminal (CI, image build) just print the next step.
if [ -z "${ORBIT_NO_REGISTER:-}" ] && { : < /dev/tty; } 2>/dev/null; then
  exec "$target" register ${1+"$@"} < /dev/tty
fi
echo "Next:  orbit register"
