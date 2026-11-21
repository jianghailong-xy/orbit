# Model tiers — the older-family label on Apple

Screenshots of the Model tiers table with the new `Older · uses <newest>` cell, built from
`orbit/task-model-tiers-show-older-family-versi-3bd036` at `5de6e87f78` (the shared
`InfrastructureModelTiersSection` in `src/macos/OrbitApp/Sources/OrbitApp/Views/SubagentViews.swift`
plus `SubagentSettings.modelTierText` / `tierIsOlder` in OrbitKit, compiled unchanged).

| File | What it is |
| --- | --- |
| `ios-model-tiers-light.png` | iPhone 17 Pro simulator (iOS 26.5, `5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6`), light |
| `ios-model-tiers-dark.png` | the same, dark |
| `ios-model-tiers-menu-open.png` | the tier menu open on `claude-opus-4-8`: S, M, L, XL |
| `macos-model-tiers-light.png` | macOS window (the app photographed its own window), light |
| `macos-model-tiers-dark.png` | the same, dark |

## What the pictures show

`claude-opus-5`, `claude-opus-4-8` and `gemini-4-argon` — no levels, a `supersededBy` — read grey
`Older · uses claude-opus-5-5` / `Older · uses gemini-4-neon` in place of the orange `Not set`, and
the tier menu still opens on them. `grok-4.7` (no levels, no `supersededBy`) still reads orange
`Not set`.

## A layout observation, not a fix

The new text is wider than the Tier column. The column is `.frame(width: 110, alignment: .leading)`
and the `Menu` label keeps `.fixedSize()`, so the label overflows the column and draws over the
Price / M out cell on both platforms. The macOS probe's own view dump measures the section's
pop-up buttons as 71 pt wide for `L · XL` rows but 217 / 203 pt for the older rows — the overflow is
the branch's code as written, not the probe's. Nothing in the branch was changed for these
pictures; this is what it renders with the fixture below.

## How it was taken

A throwaway copy outside the repository (`/tmp/mtprobe`): `src/macos` and `src/ios` rsynced out of
the task branch, and an xcodegen probe project whose targets compile those shared sources and host
only `List { InfrastructureModelTiersSection(agents:) }` — the page's own `List` under
`NavigationTitle("Machines & models")`. `AppModel` is the real one, built the way the app builds it:
`orbit.instance` is written to `UserDefaults` before `AppModel()` so its `init` calls `configure`
and creates the real `AgentsModel`; no login and no Keychain read; the section's own header `.task`
calls `loadSubagentTiers()`.

`stub.py` answers `GET /api/providers/subagent-tiers` with the task's fixture (one built-in
provider, `cursor`: two tiered models, three with `supersededBy`, and `grok-4.7` with neither) and
`GET /api/users/me`; everything else is an empty 200.

### Throwaway-copy workaround (never committed to the branch)

The shared sources do not compile as they stand: `UserTurnRow.swift:242` calls
`SubagentFinishedLineView(wake:ts:)`, whose type was deleted upstream, so the compiler says

```
error: cannot find 'SubagentFinishedLineView' in scope
```

In the copy only, that call was replaced with `EmptyView()`. That was the only origin/main compile
error hit; everything else built once the probe's own entry points were fixed.

### Commands

```sh
# copy (outside the repo)
rsync -a src/macos src/ios /tmp/mtprobe/
# … then the one-line UserTurnRow.swift workaround in /tmp/mtprobe/macos/…

cd /tmp/mtprobe/harness
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodegen generate

# macOS probe
xcodebuild build -project TiersProbe.xcodeproj -scheme TiersMacProbe -destination 'platform=macOS' \
  -derivedDataPath .dd-mac CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
python3 -u stub.py 8770 requests-mac.log &
.dd-mac/Build/Products/Debug/TiersMacProbe.app/Contents/MacOS/TiersMacProbe \
  -probe.instance http://127.0.0.1:8770 -probe.shot macos-model-tiers-light.png
#   … -probe.dark for the dark picture. The app writes CGWindowListCreateImage of its own window
#   every 2 s; the last write is the settled one.

# iOS probe
xcodebuild build -project TiersProbe.xcodeproj -scheme TiersProbe \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath .dd-ios \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
xcrun simctl install 5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6 \
  .dd-ios/Build/Products/Debug-iphonesimulator/TiersProbe.app
python3 -u stub.py 8773 requests-ios.log &
xcrun simctl launch 5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6 io.orbitd.tiersprobe \
  -probe.instance http://127.0.0.1:8773            # add -probe.dark for the dark picture
xcrun simctl io 5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6 screenshot ios-model-tiers-light.png

# iOS menu (XCUITest taps tier.cursor.claude-opus-4-8 and asserts S/M/L/XL are up)
python3 -u stub.py 8777 requests-menu.log &
xcodebuild test -project TiersProbe.xcodeproj -scheme TiersProbe \
  -destination "id=5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6" -derivedDataPath .dd-ios \
  -resultBundlePath results/ios-menu.xcresult CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
xcrun xcresulttool export attachments --path results/ios-menu.xcresult --output-path attachments
```

The macOS menu-open picture was not produced. The tier control on macOS is a `SwiftUIPopupButton`
whose `NSMenu` is built only while real mouse tracking runs: `performClick` does nothing
(`action`/`target` are nil), `menu` is empty, `menu(for:)` returns no populated menu, and a
synthesized click's tracking loop cannot be photographed from a second process on this host (no
Screen Recording permission). Every attempt is in the probe log, not in these pictures.
