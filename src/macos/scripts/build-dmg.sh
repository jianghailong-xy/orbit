#!/usr/bin/env bash
set -euo pipefail
APP_NAME="Orbit"
BUNDLE_ID="${BUNDLE_ID:-com.orbit.macos}"
VERSION="${VERSION:-0.1.0}"
SIGN_ID="${SIGN_ID:--}"        # "-" = ad-hoc (本机用). Developer ID 才能分发给别人
ARCHS="${ARCHS:-arm64}"        # 设 "arm64 x86_64" 出通用二进制
here="$(cd "$(dirname "$0")" && pwd)"
# CFBundleVersion must be monotonic for Sparkle's update comparison; the commit count is monotonic
# and identical locally and in CI (CI needs full history → fetch-depth: 0). The marketing version
# (which may carry a -beta suffix) stays in CFBundleShortVersionString for display only.
BUILD_NUMBER="${BUILD_NUMBER:-$(git -C "$here" rev-list --count HEAD 2>/dev/null || echo 1)}"
pkg="$here/../OrbitApp"; out="$here/../build"; app="$out/$APP_NAME.app"
archflags=""; for a in $ARCHS; do archflags="$archflags --arch $a"; done
# The .app keeps a stable name; the distributable DMG is versioned + arch-tagged.
if [ "$(echo $ARCHS | wc -w)" -gt 1 ]; then archtag="universal"; else archtag="$ARCHS"; fi
dmg="$out/$APP_NAME-v$VERSION-$archtag.dmg"   # filename carries the v-prefixed version (matches the git tag)
zip="$out/$APP_NAME-v$VERSION-$archtag.zip"   # zipped .app = Sparkle update-channel payload
# Sparkle auto-update config; injected into Info.plist only when SU_PUBLIC_ED_KEY is set (release).
SU_FEED_URL="${SU_FEED_URL:-https://jianghailong-xy.github.io/orbit/appcast.xml}"
SU_PUBLIC_ED_KEY="${SU_PUBLIC_ED_KEY:-8huUODCPnWSupH+g30/RWaCGOCeRzRY/oAlShNuIzm4=}"   # EdDSA public key (not secret)
echo "▶ swift build -c release ($ARCHS)"
( cd "$pkg" && swift build -c release $archflags )
bin="$(cd "$pkg" && swift build -c release $archflags --show-bin-path)/OrbitApp"
echo "▶ assemble $APP_NAME.app"
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/$APP_NAME"
# Compile the AppIcon set into AppIcon.icns so Finder/Dock/the DMG show the branded icon.
# The .appiconset PNG filenames already match iconutil's .iconset naming convention, so they
# feed straight in — no Xcode/actool needed, so local ad-hoc builds get the icon too.
iconset="$out/AppIcon.iconset"; rm -rf "$iconset"; mkdir -p "$iconset"
cp "$here/../Assets.xcassets/AppIcon.appiconset/"icon_*.png "$iconset/"
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
echo "▶ build orbit runner binary from source (frozen into the app)"
# The macOS app installs + runs a local runner with no Terminal: "Enroll this Mac" copies this
# bundled `orbit` binary to ~/.orbit/bin and loads the LaunchAgent. The runner's network self-update
# is disabled (ORBIT_NO_SELFUPDATE in the plist), so its version tracks the app: we build it here
# from the same source tree at the same $VERSION, and the app re-syncs ~/.orbit/bin on launch. This
# is why we build (not download /dl): the bundled copy is an exact, version-matched build rather than
# whatever the control plane currently serves, so a fresh install needs no second download.
# SKIP_RUNNER_BUNDLE=1 skips it (fast offline builds without the Go toolchain) — the in-app installer
# then reports the binary missing.
runner_out="$app/Contents/Resources/orbit"
if [ -n "${SKIP_RUNNER_BUNDLE:-}" ]; then
  echo "  (skipped: SKIP_RUNNER_BUNDLE set)"
else
  runner_src="$here/../../runner-go"
  runner_parts=""
  for a in $ARCHS; do
    case "$a" in
      arm64)            goarch="arm64" ;;
      x86_64|x64|amd64) goarch="amd64" ;;
      *) echo "✗ unsupported runner arch: $a" >&2; exit 1 ;;
    esac
    part="$out/orbit-darwin-$goarch"
    echo "  ⚒ go build darwin/$goarch v$VERSION"
    ( cd "$runner_src" && CGO_ENABLED=0 GOOS=darwin GOARCH="$goarch" \
      go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$part" . )
    runner_parts="$runner_parts $part"
  done
  if [ "$(echo $ARCHS | wc -w)" -gt 1 ]; then
    lipo -create $runner_parts -output "$runner_out"
  else
    cp $runner_parts "$runner_out"
  fi
  chmod +x "$runner_out"
fi
sparkle_keys=""
if [ -n "$SU_PUBLIC_ED_KEY" ]; then
  sparkle_keys="  <key>SUFeedURL</key><string>$SU_FEED_URL</string>
  <key>SUPublicEDKey</key><string>$SU_PUBLIC_ED_KEY</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUScheduledCheckInterval</key><integer>86400</integer>"
fi
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Draw full-bleed on notched MacBook displays: without this, native full screen reserves a
       notch-height black bar across the top instead of using the whole screen. -->
  <key>NSPrefersDisplaySafeAreaCompatibilityMode</key><false/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>${BUNDLE_ID}</string>
    <key>CFBundleURLSchemes</key><array><string>orbit</string></array>
  </dict></array>
${sparkle_keys}
</dict></plist>
PLIST
echo "▶ embed Sparkle.framework"
fwk="$(find "$pkg/.build/artifacts" -type d -name Sparkle.framework -path '*macos*' 2>/dev/null | head -1)"
if [ -n "$fwk" ]; then
  mkdir -p "$app/Contents/Frameworks"
  cp -R "$fwk" "$app/Contents/Frameworks/Sparkle.framework"
  # SPM links Sparkle via @rpath; point that rpath at the embedded copy.
  install_name_tool -add_rpath @executable_path/../Frameworks "$app/Contents/MacOS/$APP_NAME" 2>/dev/null || true
fi
echo "▶ codesign ($SIGN_ID)"
appfwk="$app/Contents/Frameworks/Sparkle.framework"
if [ "$SIGN_ID" = "-" ]; then
  [ -f "$runner_out" ] && codesign --force --sign - "$runner_out"   # bundled runner (nested executable)
  codesign --force --deep --sign - "$app"        # ad-hoc for local dev
else
  # Developer ID + hardened runtime: sign nested code (Sparkle, bundled runner) inside-out, then the app.
  sign() { codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$@"; }
  if [ -d "$appfwk" ]; then
    vdir="$(ls -d "$appfwk"/Versions/[A-Z] 2>/dev/null | head -1)"
    for x in "$vdir"/XPCServices/*.xpc; do [ -e "$x" ] && sign "$x"; done
    [ -e "$vdir/Autoupdate" ] && sign "$vdir/Autoupdate"
    [ -e "$vdir/Updater.app" ] && sign "$vdir/Updater.app"
    sign "$appfwk"
  fi
  [ -f "$runner_out" ] && sign "$runner_out"
  sign "$app"
fi
codesign --verify --deep --strict --verbose=2 "$app" || true
if [ -n "${NOTARIZE_PROFILE:-}" ]; then
  echo "▶ notarize + staple app ($NOTARIZE_PROFILE)"
  ditto -c -k --keepParent "$app" "$out/$APP_NAME.zip"
  xcrun notarytool submit "$out/$APP_NAME.zip" --keychain-profile "$NOTARIZE_PROFILE" --wait
  xcrun stapler staple "$app"; rm -f "$out/$APP_NAME.zip"
fi
echo "▶ create DMG (drag-to-Applications layout)"; rm -f "$dmg"
# Retina background: pack the 1x + 2x PNGs into one HiDPI tiff so the art is crisp on Retina yet
# maps to the 660x400-pt window (a bare 2x PNG would overflow the window and show only its corner).
bgtiff="$out/dmg-background.tiff"
tiffutil -cathidpicheck "$here/assets/dmg-background.png" "$here/assets/dmg-background@2x.png" -out "$bgtiff"
# create-dmg lays out the window: Orbit.app on the left + an /Applications drop-link on the right
# (the arrow + wording live in the background art). It can exit non-zero on CI Finder/AppleScript
# hiccups while still producing the DMG, so verify the artifact rather than trusting the exit code.
create-dmg \
  --volname "$APP_NAME" \
  --background "$bgtiff" \
  --window-pos 200 120 \
  --window-size 660 400 \
  --icon-size 120 \
  --icon "$APP_NAME.app" 175 190 \
  --app-drop-link 485 190 \
  --hide-extension "$APP_NAME.app" \
  --no-internet-enable \
  "$dmg" "$app" || true
[ -s "$dmg" ] || { echo "✗ create-dmg did not produce $dmg" >&2; exit 1; }
if [ -n "${NOTARIZE_PROFILE:-}" ]; then
  echo "▶ notarize + staple DMG ($NOTARIZE_PROFILE)"   # DMG 自身也要公证,否则 stapler 报 Error 65
  xcrun notarytool submit "$dmg" --keychain-profile "$NOTARIZE_PROFILE" --wait
  xcrun stapler staple "$dmg"
fi
echo "▶ zip app payload (Sparkle update channel)"
ditto -c -k --keepParent "$app" "$zip"
echo ""; echo "✓ App:  $app"; echo "✓ DMG:  $dmg"; echo "✓ ZIP:  $zip"
