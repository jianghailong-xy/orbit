# Model tiers — the older-family label on Apple

Screenshots of the Model tiers table with the `Older · uses <newest>` cell, built from
`orbit/task-model-tiers-show-older-family-versi-3bd036` at `188939e8b6` ("let Older · uses <model>
wrap in the Tier column"). The shared `InfrastructureModelTiersSection`
(`src/macos/OrbitApp/Sources/OrbitApp/Views/SubagentViews.swift`) and OrbitKit's
`SubagentSettings.modelTierText` / `tierIsOlder` are compiled unchanged.

| File | What it is |
| --- | --- |
| `ios-model-tiers-light.png` | iPhone 17 Pro simulator (iOS 26.5, `5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6`), light |
| `ios-model-tiers-dark.png` | the same, dark |
| `ios-model-tiers-menu-open.png` | the tier menu open on `claude-opus-4-8`: S, M, L, XL |
| `macos-model-tiers-light.png` | macOS window (the app photographed its own window), light |
| `macos-model-tiers-dark.png` | the same, dark |
| `macos-model-tiers-light-proposed-fix.png` | **not the branch's code** — the light window with the proposed fix at the bottom of this note applied in the throwaway copy |

## What the pictures show

On iOS the fix works exactly as intended: `claude-opus-5`, `claude-opus-4-8` and `gemini-4-argon`
read `Older · uses claude-opus-5-5` / `Older · uses gemini-4-neon` wrapped onto three lines inside
the 110-point Tier column, the whole model name visible, the Price / M out column untouched, and the
row growing to fit. `grok-4.7` still reads orange `Not set`, and the tier menu still opens on an
older model (`ios-model-tiers-menu-open.png`).

**On macOS it does not wrap.** Nothing overlaps the Price cell any more, but the model name is lost:
the cell reads `Older · us…` (light and dark), i.e. the Text is truncated with an ellipsis rather
than wrapped. The reason is the control, not the text: with `.menuStyle(.button)` the macOS `Menu`
is an `SwiftUIPopupButton`, and SwiftUI flattens its label into the native button's title — the probe's
view dump shows the label as `NSButtonImageView` + `NSButtonTextField`/`NSTextFieldSimpleLabel`,
16 pt tall, and the row stays 24 pt. A native button title is single-line, so
`.multilineTextAlignment(.leading)` and `.fixedSize(horizontal: false, vertical: true)` have nothing
to act on. Two further variants were tried in the throwaway copy and changed nothing on macOS:

- `.lineLimit(3)` on the text plus `.frame(width: 100, alignment: .leading)` on the label HStack —
  the button was still 110 × 16, one line, `Older · us…`;
- `.frame(maxWidth: .infinity, alignment: .leading)` on the label HStack — identical picture.

So on macOS the whole model name needs the label drawn outside the Menu.

## The diff that works (proposed, not on the branch)

In `tierControl`, move the text beside the `Menu` and leave only the chevron as its label:

```diff
     @ViewBuilder private func tierControl(_ provider: ProviderTierRow, _ model: ProviderModelTier) -> some View {
         let text = Text(SubagentSettings.modelTierText(model))
             …
         if let path = SubagentSettings.tierPath(provider, model) {
-            Menu {
-                …
-            } label: {
-                HStack(spacing: 3) {
-                    text
-                    Image(systemName: "chevron.up.chevron.down")
-                        .font(.orbitLabel)
-                        .foregroundStyle(.secondary)
-                }
-            }
-            .menuStyle(.button)
-            .buttonStyle(.borderless)
-            .fixedSize(horizontal: false, vertical: true)
-            .accessibilityIdentifier("tier.\(provider.slug).\(model.model)")
+            HStack(alignment: .center, spacing: 3) {
+                text                                  // drawn by SwiftUI, so it wraps
+                Menu {
+                    …
+                } label: {
+                    Image(systemName: "chevron.up.chevron.down")
+                        .font(.orbitLabel)
+                        .foregroundStyle(.secondary)
+                }
+                .menuStyle(.button)
+                .buttonStyle(.borderless)
+                .fixedSize()
+                .accessibilityIdentifier("tier.\(provider.slug).\(model.model)")
+            }
         } else {
             text
         }
```

`macos-model-tiers-light-proposed-fix.png` is that diff rendered on macOS: all three older rows
read `Older · uses claude- opus-5-5` on three lines inside the Tier column, rows grow, Price
unaffected. The same build on iOS renders the wrapping table in `ios-model-tiers-light.png`'s shape,
so the diff holds on both platforms. The trade-off to weigh before taking it: the menu's hit target
becomes the chevron alone (pressing the words no longer opens it), and the accessibility identifier
`tier.<slug>.<model>` moves with it.

## How it was taken

A throwaway copy outside the repository (`/tmp/mtprobe`): `src/macos` and `src/ios` rsynced out of
`188939e8b6`, and an xcodegen probe project whose targets compile those shared sources and host only
`List { InfrastructureModelTiersSection(agents:) }` — the page's own `List` under
`NavigationTitle("Machines & models")`. `AppModel` is the real one, built the way the app builds
it: `orbit.instance` is written to `UserDefaults` before `AppModel()` so its `init` calls
`configure` and creates the real `AgentsModel`; no login and no Keychain read; the section's own
header `.task` calls `loadSubagentTiers()`.

`stub.py` answers `GET /api/providers/subagent-tiers` with the task's fixture (one built-in
provider, `cursor`: two tiered models, three with `supersededBy`, and `grok-4.7` with neither) and
`GET /api/users/me`; everything else is an empty 200.

### Throwaway-copy workaround (never committed to the branch)

The shared sources still do not compile as they stand: `UserTurnRow.swift:242` calls
`SubagentFinishedLineView(wake:ts:)`, whose type was deleted upstream —

```
error: cannot find 'SubagentFinishedLineView' in scope
```

In the copy only, that call was replaced with `EmptyView()`, exactly as before. It is the only
compile error hit; `SubagentViews.swift` compiled cleanly, including the new
`.multilineTextAlignment(.leading)` and `.fixedSize(horizontal: false, vertical: true)`.

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
python3 -u stub.py 8782 requests-mac.log &
.dd-mac/Build/Products/Debug/TiersMacProbe.app/Contents/MacOS/TiersMacProbe \
  -probe.instance http://127.0.0.1:8782 -probe.shot macos-model-tiers-light.png
#   … -probe.dark for the dark picture. The app writes CGWindowListCreateImage of its own window
#   every 2 s; the last write is the settled one.

# iOS probe
xcodebuild build -project TiersProbe.xcodeproj -scheme TiersProbe \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath .dd-ios \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
xcrun simctl install 5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6 \
  .dd-ios/Build/Products/Debug-iphonesimulator/TiersProbe.app
python3 -u stub.py 8784 requests-ios.log &
xcrun simctl launch 5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6 io.orbitd.tiersprobe \
  -probe.instance http://127.0.0.1:8784            # add -probe.dark for the dark picture
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
