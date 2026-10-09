#!/usr/bin/env bash
# TEMPORARY (probe branch, never merged; task 34ckUsDB9IxmvzLjTCxWI). Builds four runner releases on
# Linux with the real scripts/build-binaries.sh: v0.1.900 and v0.1.901 signed by rcodesign with a
# throwaway self-signed "Developer ID Application" certificate generated here (no repository secret
# is read), and the same two versions left with the Go linker's ad-hoc signature as the control.
set -euo pipefail
OUT="$1"
mkdir -p "$OUT"
T="$(mktemp -d)"

# rcodesign: the pin src/web/Dockerfile uses.
curl -fsSL -o "$T/rcodesign.tar.gz" \
  https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz
echo "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002  $T/rcodesign.tar.gz" | sha256sum -c -
mkdir -p "$T/bin"
tar -xzf "$T/rcodesign.tar.gz" -C "$T/bin" --strip-components=1 apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign
export PATH="$T/bin:$PATH"

head -c 18 /dev/urandom | base64 > "$T/password"
rcodesign generate-self-signed-certificate --profile developer-id-application --team-id PROBETEAM1 \
  --person-name "Orbit Sign Probe" --validity-days 30 --p12-file "$T/probe.p12" \
  --p12-password "$(head -n1 "$T/password")" > /dev/null

orig="$(cat package.json)"
for v in 900 901; do
  sed -i -E "0,/\"version\"/s/\"version\": *\"[^\"]+\"/\"version\": \"0.1.$v\"/" package.json
  grep -m1 '"version"' package.json
  PUBLIC_ORIGIN=http://127.0.0.1:8765 ORBIT_MACOS_SIGNING_P12="$T/probe.p12" ORBIT_MACOS_SIGNING_PASSWORD_FILE="$T/password" \
    bash scripts/build-binaries.sh "dists/signed-v$v"
  PUBLIC_ORIGIN=http://127.0.0.1:8765 bash scripts/build-binaries.sh "dists/adhoc-v$v"
  printf '%s' "$orig" > package.json
done
cp -R dists/. "$OUT/"
# The throwaway identity itself, so the Mac can export it the way Keychain Access would.
mkdir -p "$OUT/identity"; cp "$T/probe.p12" "$T/password" "$OUT/identity/"
rm -rf "$T"
ls -lR "$OUT"
