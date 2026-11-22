#!/usr/bin/env bash
set -euo pipefail
APP_NAME="Orbitd"
BUNDLE_ID="${BUNDLE_ID:-com.orbit.macos}"
# Release builds get VERSION from the git tag (release.yml); a local build falls back to the newest
# tag rather than a hardcoded default that silently goes stale. versionsort.suffix=-beta sorts
# -beta.N below its stable, so a shipped X.Y.Z wins over its own betas.
VERSION="${VERSION:-$(git -C "$(dirname "$0")" -c versionsort.suffix=-beta tag --list 'v[0-9]*' --sort=-v:refname 2>/dev/null | head -1 | sed 's/^v//')}"
VERSION="${VERSION:-0.0.0}"    # no tags (shallow clone) → placeholder
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
# Share to Orbit (docs/share-to-orbit-design.md §3.3): the App Group the app and OrbitShare.appex share.
# A Developer ID build has no provisioning profile, so the group is the team-prefixed <TEAMID>.io.orbitd.app;
# the team comes from SIGN_ID's "(TEAMID)". An ad-hoc build has no team and uses local.io.orbitd.app.
TEAM_ID="${TEAM_ID:-$(printf '%s' "$SIGN_ID" | sed -n 's/.*(\([A-Z0-9]\{10\}\))[[:space:]]*$/\1/p')}"
APP_GROUP="${APP_GROUP:-${TEAM_ID:-local}.io.orbitd.app}"
SHARE_ID="$BUNDLE_ID.OrbitShare"
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
# The Mermaid build that draws a wiki document's diagrams (WikiDiagram.swift), and its license: the package's resources.
cp "$pkg/Sources/OrbitApp/Resources/mermaid.min.js" "$pkg/Sources/OrbitApp/Resources/mermaid-LICENSE.txt" "$app/Contents/Resources/"
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
    <key>CFBundleURLSchemes</key><array><string>orbit</string><string>orbit-session</string></array>
  </dict></array>
  <!-- A session row dragged onto a folder row (Views/SessionFolderDrop.swift): the app's own type,
       so nothing outside the app reads the drag as text or a file. -->
  <key>UTExportedTypeDeclarations</key><array><dict>
    <key>UTTypeIdentifier</key><string>app.orbit.session-row</string>
    <key>UTTypeDescription</key><string>Orbit session row</string>
    <key>UTTypeConformsTo</key><array><string>public.data</string></array>
  </dict></array>
  <!-- The App Group (signed into the entitlements below) that holds the share inbox and snapshot. -->
  <key>OrbitAppGroup</key><string>${APP_GROUP}</string>
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
echo "▶ assemble OrbitShare.appex (App Group $APP_GROUP)"
# SPM has no app-extension product: the OrbitShare executable (Package.swift) was built with the app
# above (its main hands over to NSExtensionMain) and is wrapped here into a bundle with its own Info.plist.
appex="$app/Contents/PlugIns/OrbitShare.appex"
mkdir -p "$appex/Contents/MacOS"
cp "$(dirname "$bin")/OrbitShare" "$appex/Contents/MacOS/OrbitShare"
# Same activation rule as the iOS extension: files, images, movies, text and links, at most 10 items.
cat > "$appex/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>OrbitShare</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${SHARE_ID}</string>
  <key>CFBundleExecutable</key><string>OrbitShare</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>OrbitAppGroup</key><string>${APP_GROUP}</string>
  <key>NSExtension</key><dict>
    <key>NSExtensionAttributes</key><dict>
      <key>NSExtensionActivationRule</key><dict>
        <key>NSExtensionActivationSupportsAttachmentsWithMaxCount</key><integer>10</integer>
        <key>NSExtensionActivationSupportsFileWithMaxCount</key><integer>10</integer>
        <key>NSExtensionActivationSupportsImageWithMaxCount</key><integer>10</integer>
        <key>NSExtensionActivationSupportsMovieWithMaxCount</key><integer>10</integer>
        <key>NSExtensionActivationSupportsText</key><true/>
        <key>NSExtensionActivationSupportsWebURLWithMaxCount</key><integer>10</integer>
      </dict>
    </dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.share-services</string>
    <key>NSExtensionPrincipalClass</key><string>OrbitShare.ShareViewController</string>
  </dict>
</dict></plist>
PLIST
# The extension is sandboxed (an extension must be) and reaches the app only through the group.
# The app is not sandboxed; it carries the group so its container is the extension's.
ents="$out/entitlements"; mkdir -p "$ents"
cat > "$ents/OrbitShare.entitlements" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.application-groups</key><array><string>${APP_GROUP}</string></array>
</dict></plist>
PLIST
cat > "$ents/Orbit.entitlements" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.application-groups</key><array><string>${APP_GROUP}</string></array>
</dict></plist>
PLIST
echo "▶ codesign ($SIGN_ID)"
appfwk="$app/Contents/Frameworks/Sparkle.framework"
# Nested code inside-out (Sparkle, then OrbitShare.appex with its own entitlements), then the app.
# No --deep: it would re-sign the appex without its entitlements. Developer ID adds the hardened
# runtime and a secure timestamp, which notarisation requires; ad-hoc (local dev) has neither.
if [ "$SIGN_ID" = "-" ]; then
  sign() { codesign --force --sign - "$@"; }
else
  sign() { codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$@"; }
fi
if [ -d "$appfwk" ]; then
  vdir="$(ls -d "$appfwk"/Versions/[A-Z] 2>/dev/null | head -1)"
  for x in "$vdir"/XPCServices/*.xpc; do [ -e "$x" ] && sign "$x"; done
  [ -e "$vdir/Autoupdate" ] && sign "$vdir/Autoupdate"
  [ -e "$vdir/Updater.app" ] && sign "$vdir/Updater.app"
  sign "$appfwk"
fi
echo "▶ codesign OrbitShare.appex"
sign --entitlements "$ents/OrbitShare.entitlements" "$appex"
echo "▶ codesign $APP_NAME.app"
sign --entitlements "$ents/Orbit.entitlements" "$app"
codesign --verify --deep --strict --verbose=2 "$app" || true
codesign -d --entitlements - "$appex" 2>/dev/null | grep -q "$APP_GROUP" \
  || { echo "✗ OrbitShare.appex is not signed with the App Group $APP_GROUP" >&2; exit 1; }
# Stapling fetches the ticket of an already accepted notarization from Apple (api.apple-cloudkit.com),
# which sometimes drops the connection: Error 68, "The network connection was lost" (beta.207 failed
# three times on it, on the app and on the DMG). Fetch it again rather than fail the release.
staple() {
  for try in 1 2 3 4 5; do
    xcrun stapler staple "$1" && return 0
    if [ "$try" -lt 5 ]; then echo "  staple failed (try $try of 5); again in 30s" >&2; sleep 30; fi
  done
  return 1
}
if [ -n "${NOTARIZE_PROFILE:-}" ]; then
  echo "▶ notarize + staple app ($NOTARIZE_PROFILE)"
  ditto -c -k --keepParent "$app" "$out/$APP_NAME.zip"
  xcrun notarytool submit "$out/$APP_NAME.zip" --keychain-profile "$NOTARIZE_PROFILE" --wait
  staple "$app"; rm -f "$out/$APP_NAME.zip"
fi
echo "▶ create DMG (drag-to-Applications layout)"; rm -f "$dmg"
# Retina background: pack the 1x + 2x PNGs into one HiDPI tiff so the art is crisp on Retina yet
# maps to the 660x400-pt window (a bare 2x PNG would overflow the window and show only its corner).
bgtiff="$out/dmg-background.tiff"
tiffutil -cathidpicheck "$here/assets/dmg-background.png" "$here/assets/dmg-background@2x.png" -out "$bgtiff"
# create-dmg lays out the window: Orbitd.app on the left + an /Applications drop-link on the right
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
  staple "$dmg"
fi
echo "▶ zip app payload (Sparkle update channel)"
ditto -c -k --keepParent "$app" "$zip"
echo ""; echo "✓ App:  $app"; echo "✓ DMG:  $dmg"; echo "✓ ZIP:  $zip"
