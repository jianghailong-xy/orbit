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
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
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
  codesign --force --deep --sign - "$app"        # ad-hoc for local dev
else
  # Developer ID + hardened runtime: sign nested Sparkle code inside-out, then the app.
  sign() { codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$@"; }
  if [ -d "$appfwk" ]; then
    vdir="$(ls -d "$appfwk"/Versions/[A-Z] 2>/dev/null | head -1)"
    for x in "$vdir"/XPCServices/*.xpc; do [ -e "$x" ] && sign "$x"; done
    [ -e "$vdir/Autoupdate" ] && sign "$vdir/Autoupdate"
    [ -e "$vdir/Updater.app" ] && sign "$vdir/Updater.app"
    sign "$appfwk"
  fi
  sign "$app"
fi
codesign --verify --deep --strict --verbose=2 "$app" || true
if [ -n "${NOTARIZE_PROFILE:-}" ]; then
  echo "▶ notarize + staple app ($NOTARIZE_PROFILE)"
  ditto -c -k --keepParent "$app" "$out/$APP_NAME.zip"
  xcrun notarytool submit "$out/$APP_NAME.zip" --keychain-profile "$NOTARIZE_PROFILE" --wait
  xcrun stapler staple "$app"; rm -f "$out/$APP_NAME.zip"
fi
echo "▶ create DMG"; rm -f "$dmg"
hdiutil create -volname "$APP_NAME" -srcfolder "$app" -ov -format UDZO "$dmg"
if [ -n "${NOTARIZE_PROFILE:-}" ]; then
  echo "▶ notarize + staple DMG ($NOTARIZE_PROFILE)"   # DMG 自身也要公证,否则 stapler 报 Error 65
  xcrun notarytool submit "$dmg" --keychain-profile "$NOTARIZE_PROFILE" --wait
  xcrun stapler staple "$dmg"
fi
echo "▶ zip app payload (Sparkle update channel)"
ditto -c -k --keepParent "$app" "$zip"
echo ""; echo "✓ App:  $app"; echo "✓ DMG:  $dmg"; echo "✓ ZIP:  $zip"
