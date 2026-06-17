#!/usr/bin/env bash
# Install the Orbit runner CLI:  curl -fsSL https://orbit.wikova.com/install.sh | bash
set -euo pipefail

BASE_URL="${ORBIT_BASE_URL:-https://orbit.wikova.com}"
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
