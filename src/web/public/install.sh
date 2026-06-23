#!/usr/bin/env bash
# Install the Orbit runner CLI. Copy the exact command (with ORBIT_BASE_URL) from your
# Orbit UI's "Add a runner" page, e.g.:
#   curl -fsSL https://orbit.example.com/install.sh | ORBIT_BASE_URL=https://orbit.example.com bash
set -euo pipefail

# Where to download the binary from — your Orbit server's origin. No domain is baked in;
# the UI's install command sets this to the host you opened it on.
BASE_URL="${ORBIT_BASE_URL:-}"
if [ -z "$BASE_URL" ]; then
  echo "orbit: set ORBIT_BASE_URL to your Orbit server URL (copy the command from your Orbit UI's 'Add a runner' page)" >&2
  exit 1
fi
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
if [ -w "$BIN_DIR" ] || [ "$(id -u)" = "0" ]; then
  mv "$tmp" "$target"
else
  echo "Installing to ${target} (needs sudo)..."
  sudo mv "$tmp" "$target"
fi
trap - EXIT

ver="$("$target" version 2>/dev/null || echo '?')"
echo ""
echo "✓ orbit ${ver} installed to ${target}"
echo "Next:  orbit register"
