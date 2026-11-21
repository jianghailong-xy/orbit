# Model tiers — the older-family label on Apple

Screenshots of the Model tiers table with the `Older · uses <newest>` cell, built from
`orbit/task-model-tiers-show-older-family-versi-3bd036` at `335acc1dd2` ("widen the Tier column so
Older · uses <model> is not cut"). The shared `InfrastructureModelTiersSection`
(`src/macos/OrbitApp/Sources/OrbitApp/Views/SubagentViews.swift`), with its new `Self.tierWidth`
(230 pt on macOS, 110 pt on iOS), and OrbitKit's `SubagentSettings.modelTierText` / `tierIsOlder`
are compiled unchanged.

| File | What it is |
| --- | --- |
| `ios-model-tiers-light.png` | iPhone 17 Pro simulator (iOS 26.5, `5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6`), light |
| `ios-model-tiers-dark.png` | the same, dark |
| `ios-model-tiers-menu-open.png` | the tier menu open on `claude-opus-4-8`: S, M, L, XL |
| `macos-model-tiers-light.png` | macOS window (the app photographed its own window), light |
| `macos-model-tiers-dark.png` | the same, dark |

## What the pictures show

**macOS.** The Tier column is now 230 pt, and all three older rows read their whole value in one
line — `Older · uses claude-opus-5-5` for `claude-opus-5` and `claude-opus-4-8`, `Older · uses
gemini-4-neon` for `gemini-4-argon` — with no ellipsis and nothing drawn over the Price / M out cell
(`Subscription` sits in its own column). The `Tier` column head starts at the same x as the rows'
chevrons, and `Price / M out` still ends flush with `Subscription`, so header and rows stay aligned;
the model column (`claude-opus-5-5` … `gemini-4-argon`) still has room and is not truncated. Same
in dark. `grok-4.7` still reads orange `Not set`, and `L · XL` rows are unchanged apart from the
wider column.

**iOS.** Unchanged, as intended — `tierWidth` stays 110 there and the older labels wrap onto three
lines inside the column (`Older · uses / claude- / opus-5-5`) with the Price column untouched. The
three iOS pictures are byte-identical (same MD5) to the ones taken at `188939e8b6`, which is the
strongest statement that this commit did not move the phone.

## How it was taken

A throwaway copy outside the repository (`/tmp/mtprobe`): `src/macos` and `src/ios` rsynced out of
`335acc1dd2`, and an xcodegen probe project whose targets compile those shared sources and host only
`List { InfrastructureModelTiersSection(agents:) }` — the page's own `List` under
`NavigationTitle("Machines & models")`. `AppModel` is the real one, built the way the app builds it:
`orbit.instance` is written to `UserDefaults` before `AppModel()` so its `init` calls `configure`
and creates the real `AgentsModel`; no login and no Keychain read; the section's own header `.task`
calls `loadSubagentTiers()`.

`stub.py` answers `GET /api/providers/subagent-tiers` with the task's fixture (one built-in
provider, `cursor`: two tiered models, three with `supersededBy`, and `grok-4.7` with neither) and
`GET /api/users/me`; everything else is an empty 200.

### Throwaway-copy workaround (never committed to the branch)

The shared sources still do not compile as they stand: `UserTurnRow.swift:242` calls
`SubagentFinishedLineView(wake:ts:)`, whose type was deleted upstream —

```
error: cannot find 'SubagentFinishedLineView' in scope
```

In the copy only, that call was replaced with `EmptyView()`, as before. It is the only compile error
hit; `SubagentViews.swift` compiled cleanly, `Self.tierWidth` and both `#if os(macOS)` arms
included.

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
python3 -u stub.py 8790 requests-mac.log &
.dd-mac/Build/Products/Debug/TiersMacProbe.app/Contents/MacOS/TiersMacProbe \
  -probe.instance http://127.0.0.1:8790 -probe.shot macos-model-tiers-light.png
#   … -probe.dark for the dark picture. The app writes CGWindowListCreateImage of its own window
#   every 2 s; the last write is the settled one.

# iOS probe
xcodebuild build -project TiersProbe.xcodeproj -scheme TiersProbe \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath .dd-ios \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
xcrun simctl install 5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6 \
  .dd-ios/Build/Products/Debug-iphonesimulator/TiersProbe.app
python3 -u stub.py 8792 requests-ios.log &
xcrun simctl launch 5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6 io.orbitd.tiersprobe \
  -probe.instance http://127.0.0.1:8792            # add -probe.dark for the dark picture
xcrun simctl io 5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6 screenshot ios-model-tiers-light.png

# iOS menu (XCUITest taps tier.cursor.claude-opus-4-8 and asserts S/M/L/XL are up)
python3 -u stub.py 8777 requests-menu.log &
xcodebuild test -project TiersProbe.xcodeproj -scheme TiersProbe \
  -destination "id=5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6" -derivedDataPath .dd-ios \
  -resultBundlePath results/ios-menu.xcresult CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
xcrun xcresulttool export attachments --path results/ios-menu.xcresult --output-path attachments
```

The macOS menu-open picture is still not produced: the tier control is a `SwiftUIPopupButton` whose
`NSMenu` exists only while real mouse tracking runs (`performClick` no-ops — action/target nil —
`menu` is empty, `menu(for:)` returns no items), and a synthesized click's tracking loop cannot be
photographed from another process on this host.
