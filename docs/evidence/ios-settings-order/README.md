# iOS Settings order — as it landed

The owner's picks on [`docs/mocks/ios-settings-order`](../../mocks/ios-settings-order/): **1A 2A 3A**.

- **1A, order.** Settings opens with Machines & models, the one row that says what needs you. Preferences follows, then Account, then Sign out.
- **2A, Sessions.** The five session settings leave the list for a Sessions page, opened from Preferences' first row. Each setting has a section of its own, with the web's hint as its footer.
- **3A, scope.** iPhone/iPad and Android change together. The web page and the Mac window keep their forms.

## What the pictures show

| Client | Picture | Reads |
|---|---|---|
| iPhone | `ios/01-settings-top.png` | Alex, then **Machines & models · 1 needs you** (amber) with its footer, then **Preferences**: Sessions ›, Notifications ›, Appearance System. **Account** follows: Email, Instance, Shared links, Access tokens |
| iPhone | `ios/02-settings-bottom.png` | the same list scrolled down: Preferences, Account through Change password, then **Sign out** |
| iPhone | `ios/03-sessions-page.png` | **Sessions** (back and close in the bar). Default permission Auto, then Session orchestration on, Smart model selection off, Suggested replies on, Session recaps on. Each has the web's hint as its footer |
| Android | `android/settings-home.png` | the same list in the same order: Machines & models · 1 needs you, Preferences (Sessions, Notifications On, Appearance System), Account, About, Sign out |
| Android | `android/settings-sessions.png` | the Sessions page: the five settings in iOS's order, each in a card of its own with its hint under it |

## What was checked on the pictures

The iPhone pictures come from `SettingsOrderShotTests` on GitHub's `macos-26` runner (run `40477667840`, `ci-outcomes.txt`). The run passed: 2 tests, 0 failures (`ios/summary-build-ios.txt`). Each claim is also written down in `ios/list-notes.txt` and `ios/sessions-notes.txt`:

- **The list's order, from element frames on screen.** Machines & models@332 < Preferences@430 < Sessions@470 < Notifications@522 < Appearance@590 < Account@644 < Email@700.
- **None of the five settings is on the list**, at the top or scrolled to the bottom.
- **The Sessions page's order, from frames.** Each title is followed by its hint, in `SessionSettings`' order: Default permission@182, its hint@219, Session orchestration@298, its hint@350, and so on down to Session recaps@691 and its hint@743.
- **The values are the fresh account's.** Orchestration is on and smart model selection off (the stub names neither). Suggested replies and session recaps are on, and Default permission is Auto.
- **The run changed nothing.** The stub's `ios/writes.txt` holds only the test's own resets, and `ios/not-served.txt` holds only `GET /api/auth/capabilities`.
- **One harmless note.** "sign-out: never between 120 and 780" means the list bottoms out with Sign out at 768–820 pt; the picture shows it.

The Android pictures come from `SettingsOrderShotsTest`: Robolectric renders of the real `SettingsScreen` over fake reads, not an emulator. The test asserts the same order and values before it saves them. Its run on this host passed together with every Android class the change touches (25 tests), and `:app:compileDebugAndroidTestKotlin` compiled the device tests, which CI's `verify.sh` doesn't build.

## Gates on the change itself (commit 00f5ccbdc, on main as 781a7e61f)

00f5ccbdc is the branch commit these runs tested. It was rebased onto main as 781a7e61f; `git range-diff` shows the same patch.

- **OrbitKit `swift test`** in `swift:6.1` on Linux: 4079 tests, 5 skipped (the perf baselines, as always on Linux), 0 failures.
- **Client CI dispatch** `40476989453`: iOS (generate + build) and macOS (build + test) both succeeded.
- **Android CI** `40476962422`: test, lint and the debug APK all succeeded.

## Re-taking the pictures

`probe-harness/` builds a throwaway iPhone app out of the real sources (the session-recap probe's arrangement). It points the app at `stub.py`: the account Alex, two machines, one of them offline. It is never merged. To run it:

```sh
# a throwaway branch whose client.yml is ci/client.yml.probe
git checkout -b probe/ios-settings-order
cp docs/evidence/ios-settings-order/ci/client.yml.probe .github/workflows/client.yml
git commit -am "probe: iOS Settings order shots" && git push -u origin probe/ios-settings-order
gh workflow run client.yml --ref probe/ios-settings-order -f settings_order_probe=true
```

The shots are the run's `settings-order-shots` artifact. Android's come from:

```sh
gradlew -p src/android :app:testDebugUnitTest --tests io.orbitd.android.management.SettingsOrderShotsTest
```

They land in `src/android/build/evidence/ios-settings-order-android/`.
