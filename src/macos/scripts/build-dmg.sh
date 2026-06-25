#!/usr/bin/env bash
set -euo pipefail
APP_NAME="Orbit"
BUNDLE_ID="${BUNDLE_ID:-com.orbit.macos}"
VERSION="${VERSION:-0.1.0}"
SIGN_ID="${SIGN_ID:--}"        # "-" = ad-hoc (本机用). Developer ID 才能分发给别人
ARCHS="${ARCHS:-arm64}"        # 设 "arm64 x86_64" 出通用二进制
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/../OrbitApp"; out="$here/../build"; app="$out/$APP_NAME.app"; dmg="$out/$APP_NAME.dmg"
archflags=""; for a in $ARCHS; do archflags="$archflags --arch $a"; done
echo "▶ swift build -c release ($ARCHS)"
( cd "$pkg" && swift build -c release $archflags )
bin="$(cd "$pkg" && swift build -c release $archflags --show-bin-path)/OrbitApp"
echo "▶ assemble $APP_NAME.app"
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/$APP_NAME"
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
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>${BUNDLE_ID}</string>
    <key>CFBundleURLSchemes</key><array><string>orbit</string></array>
  </dict></array>
</dict></plist>
PLIST
echo "▶ codesign ($SIGN_ID)"
if [ "$SIGN_ID" = "-" ]; then codesign --force --sign - "$app"
else codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$app"; fi
codesign --verify --verbose "$app" || true
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
echo ""; echo "✓ App:  $app"; echo "✓ DMG:  $dmg"
