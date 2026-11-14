#!/usr/bin/env bash
# Dry-run the release supply chain without pushing a tag, using a sample prerelease version and
# representative local artifacts. It runs the same generate/verify commands release.yml runs on the
# real DMG, Sparkle payload, Android APK, runner binaries and service images, then proves that a
# tampered artifact blocks verification.
#
# What is real here: the version of record and release notes from this checkout, a real runner build
# for all four platforms (scripts/build-binaries.sh), a real Sparkle-shaped zip carrying the app's
# Info.plist, a real Android build-identity file bound to the APK bytes, real container image
# config/layer digests from Docker, and the real SHA256SUMS/CycloneDX/SLSA documents.
#
# What is a stand-in: a Linux host cannot produce a notarized UDIF DMG or a signed APK, so those two
# files carry representative bytes and their names are the ones the release publishes. The macOS zip
# is a real zip with the real Info.plist path, and the container images are scratch images standing in
# for the Dockerfiles the release workflow builds so the image-identity path is exercised end to end.
#
# Requires: bash, git, node, go, python3 (for the sample zip), sha256sum. Docker is optional; without
# it the service-image surface is skipped and said so.
#
#   bash scripts/supply-chain-dry-run.sh            # uses the root package.json version
#   KEEP=1 bash scripts/supply-chain-dry-run.sh     # keep the bundle under .supply-chain-dry-run/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -e 'process.stdout.write(require("./package.json").version)')"
TAG="v$VERSION"
SOURCE_SHA="$(git rev-parse HEAD)"
BUILD_NUMBER="$(git rev-list --count HEAD)"
REPOSITORY="${ORBIT_RELEASE_REPOSITORY:-jianghailong-xy/orbit}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/orbit-supply-chain-dry-run.XXXXXX")"
cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    rm -rf "$ROOT/.supply-chain-dry-run"
    cp -a "$WORK" "$ROOT/.supply-chain-dry-run"
    echo "kept the dry-run workspace at .supply-chain-dry-run/"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

ARTIFACTS="$WORK/artifacts"
BUNDLE="$WORK/bundle"
mkdir -p "$ARTIFACTS" "$BUNDLE" "$WORK/images"

say() { printf '%s\n' "$*"; }

say "Supply-chain dry run for $TAG from $SOURCE_SHA (build $BUILD_NUMBER)"
say ""

# 1. The runner release: the same four cross-compiled, gzip-compressed binaries the deploy build
#    produces, plus the version.json their self-update reads.
say "== Runner binaries (scripts/build-binaries.sh) =="
ORBIT_SOURCE_SHA="$SOURCE_SHA" bash scripts/build-binaries.sh "$ARTIFACTS" >"$WORK/runner-build.log" 2>&1 \
  || { tail -40 "$WORK/runner-build.log"; exit 1; }
tail -3 "$WORK/runner-build.log"
say ""

# 2. A Sparkle-shaped zip: a real zip whose Orbit.app/Contents/Info.plist carries the release version
#    and commit-count build number, exactly the fields the generator checks.
say "== macOS payload (representative) =="
APP="$WORK/Orbit.app/Contents"
mkdir -p "$APP/MacOS"
printf '#!/bin/sh\necho Orbit %s\n' "$VERSION" >"$APP/MacOS/Orbit"
chmod +x "$APP/MacOS/Orbit"
cat >"$APP/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>CFBundleIdentifier</key><string>io.orbitd.app</string>
</dict></plist>
PLIST
python3 - "$WORK" "$ARTIFACTS/Orbit-v$VERSION-arm64.zip" <<'PY'
import os, sys, zipfile
work, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for directory, _, files in os.walk(os.path.join(work, 'Orbit.app')):
        for name in sorted(files):
            absolute = os.path.join(directory, name)
            archive.write(absolute, os.path.relpath(absolute, work))
PY
# A Linux host cannot build a UDIF DMG; this file stands in for the signed, notarized one so the
# DMG/Sparkle surface is present in the manifest and checksums.
printf 'DMG stand-in for the dry run; the macOS job builds the signed, notarized image on macOS.\n' \
  >"$ARTIFACTS/Orbit-v$VERSION-arm64.dmg"
printf '<rss version="2.0"><channel><title>Orbit</title></channel></rss>\n' >"$ARTIFACTS/appcast.xml"
ls -l "$ARTIFACTS/Orbit-v$VERSION-arm64.zip" "$ARTIFACTS/Orbit-v$VERSION-arm64.dmg" | sed 's/^/  /'
say ""

# 3. The Android APK and the build identity the release publishes beside it. A signed APK needs the
#    android-internal signing environment, which a dry run must not use; identity.json binds the
#    representative APK bytes to the version, commit and certificate digest the real build writes.
say "== Android APK (representative) =="
APK="$ARTIFACTS/orbit-android-$VERSION.apk"
python3 - "$APK" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as apk:
    apk.writestr('META-INF/DRY-RUN', 'representative APK bytes; not a signed release build\n')
PY
APK_SHA="$(sha256sum "$APK" | cut -d' ' -f1)"
CERT_SHA="$(printf 'dry-run-certificate-sha256-placeholder%.0s' 1 | sha256sum | cut -d' ' -f1)"
node -e '
  const fs = require("fs");
  const [out, apkSha, certSha, version, code, source] = process.argv.slice(1);
  fs.writeFileSync(out, `${JSON.stringify({
    applicationId: "io.orbitd.app", versionName: version, versionCode: Number(code), minSdk: 29,
    targetSdk: 36, buildType: "release", debuggable: false, apkSha256: apkSha,
    certificateSha256: certSha, sourceSha: source, sourceDirty: false,
    distributionSignature: true, note: "dry-run stand-in; the real build uses the android-internal signing environment",
  }, null, 2)}\n`);
' "$ARTIFACTS/android-identity.json" "$APK_SHA" "$CERT_SHA" "$VERSION" "$BUILD_NUMBER" "$SOURCE_SHA"
say "  orbit-android-$VERSION.apk $APK_SHA"
say ""

# 4. Service images: real config and layer digests from Docker. The images are scratch stand-ins;
#    release.yml builds src/apiserver/Dockerfile and src/web/Dockerfile and records their identities
#    the same way.
say "== Service images (representative) =="
IMAGE_ARGS=()
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  mkdir -p "$WORK/imgctx"
  printf 'dry-run stand-in for the service image contents\n' >"$WORK/imgctx/payload"
  for spec in 'orbit-apiserver src/apiserver/Dockerfile' 'orbit-web src/web/Dockerfile'; do
    set -- $spec
    name="$1"; dockerfile="$2"
    printf 'FROM scratch\nCOPY payload /payload\nLABEL org.opencontainers.image.title="%s"\n' "$name" \
      >"$WORK/imgctx/Dockerfile"
    docker build -q -t "$name:supply-chain-dry-run" "$WORK/imgctx" >"$WORK/image-$name.log" 2>&1 \
      || { tail -20 "$WORK/image-$name.log"; exit 1; }
    node scripts/supply-chain.mjs image-inspect --name "$name" \
      --image "$name:supply-chain-dry-run" --dockerfile "$dockerfile" \
      --out "$WORK/images/$name.json"
    say "  $(node -e 'const i=require(process.argv[1]);console.log(`${i.name} ${i.id} base=${i.baseImages.join(",")}`)' "$WORK/images/$name.json")"
    IMAGE_ARGS+=(--image "$WORK/images/$name.json")
  done
else
  say "  SKIP: no usable Docker daemon; the image surface is not part of this dry run."
fi
say ""

# 5. Generate and verify the same way release.yml does.
say "== Generate =="
node scripts/supply-chain.mjs generate \
  --version "$VERSION" --tag "$TAG" --source-sha "$SOURCE_SHA" --repository "$REPOSITORY" \
  --artifacts "$ARTIFACTS" --out "$BUNDLE" --tree "$ROOT" --build-number "$BUILD_NUMBER" \
  --require-surface macos --require-surface sparkle-appcast --require-surface runner \
  --require-surface android --require-surface android-identity \
  --lockfile "$ROOT/package-lock.json" \
  --generated-on "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --started-on "$(git show -s --format=%cI "$SOURCE_SHA")" \
  --finished-on "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "${IMAGE_ARGS[@]+"${IMAGE_ARGS[@]}"}"

say ""
say "== Independent checksum check (sha256sum -c) =="
(cd "$BUNDLE" && sha256sum -c SHA256SUMS | sed 's/^/  /')

say ""
say "== Verify (the gate release.yml runs before publishing) =="
node scripts/supply-chain.mjs verify --dir "$BUNDLE" --tag "$TAG" --source-sha "$SOURCE_SHA" \
  --repository "$REPOSITORY" --tree "$ROOT"

# 6. Negative controls: each of these has to be refused, or the gate is not a gate.
say ""
say "== Negative controls (each must be refused) =="
FAILED=0
expect_refused() {
  local label="$1" directory="$2"; shift 2
  local output status
  output="$(node scripts/supply-chain.mjs verify --dir "$directory" "$@" 2>&1)" && status=0 || status=$?
  if [ "$status" -eq 0 ]; then
    say "  ✗ FAIL: $label was accepted"
    FAILED=1
  else
    say "  ✓ $label refused: $(printf '%s\n' "$output" | head -1 | sed 's/^✗ //')"
  fi
}

cp -a "$BUNDLE" "$WORK/tampered"
printf 'tampered\n' >>"$WORK/tampered/Orbit-v$VERSION-arm64.dmg"
expect_refused 'a changed DMG byte' "$WORK/tampered"

cp -a "$BUNDLE" "$WORK/wrong-sbom"
printf '{"bomFormat":"CycloneDX"}\n' >"$WORK/wrong-sbom/orbit-v$VERSION-sbom.cdx.json"
expect_refused 'a rewritten SBOM' "$WORK/wrong-sbom"

cp -a "$BUNDLE" "$WORK/extra-file"
printf 'not part of the release\n' >"$WORK/extra-file/extra.bin"
expect_refused 'an unclaimed extra file' "$WORK/extra-file"

expect_refused 'a different tag' "$BUNDLE" --tag v0.1.256
expect_refused 'a different source commit' "$BUNDLE" --source-sha 0000000000000000000000000000000000000000

if [ "$FAILED" -ne 0 ]; then
  say ""
  say "The supply-chain gate did not refuse every bad input."
  exit 1
fi

say ""
say "Supply-chain dry run passed for $TAG."
say "  bundle: $BUNDLE"
node -e '
  const fs = require("fs");
  const [dir, version] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(`${dir}/release-manifest.json`, "utf8"));
  console.log(`  artifacts: ${manifest.artifacts.length} (${[...new Set(manifest.artifacts.map((a) => a.surface))].sort().join(", ")})`);
  console.log(`  images: ${(manifest.images ?? []).map((image) => `${image.name}@${image.id}`).join(", ") || "none"}`);
  const sums = fs.readFileSync(`${dir}/SHA256SUMS`);
  console.log(`  SHA256SUMS ${require("crypto").createHash("sha256").update(sums).digest("hex")} (${sums.toString().trim().split("\n").length} files)`);
  console.log(`  SBOM       ${manifest.sbom.file} ${manifest.sbom.sha256}`);
  console.log(`  provenance ${manifest.provenance.file} ${manifest.provenance.sha256}`);
' "$BUNDLE" "$VERSION"
