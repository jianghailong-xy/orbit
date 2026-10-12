# Android under server execution — settings, Activity's Runs and a run's page (P9)

Three shots of the Android client while the server executes the account's wiki (design §2.2, mock
`docs/mocks/wiki/35-server-execution-clients.png`, P9), taken with Compose/Robolectric and fake reads:
`WikiServerExecutionShotsTest` answers the client's own HTTP from
`src/shared/src/wiki-server-execution.fixture.json` and `wiki-health.fixture.json` — no deployment, no account.
These are the task's "Robolectric/Compose 测试截图" half; the production screenshots are P10's, as the task says.
Each `*-semantics.txt` is the Compose semantics tree on screen as its PNG was taken, so what the picture holds
can be read as text.

Reproduce (the test writes the PNGs and the trees under
`src/android/build/evidence/wiki-android-server-execution/`; these files are that output, copied here):

```sh
env JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk \
  bash src/android/gradlew -p src/android --no-daemon --max-workers=2 \
  :app:testDebugUnitTest --tests 'io.orbitd.android.wiki.WikiServerExecutionShotsTest'
```

| Shot | What it shows | Mock 35 |
| --- | --- | --- |
| `settings-server.png` | Wiki settings with the server running the wiki: `Status On`, `Reads the repository from · orbit · Mac mini`, `Model · System model · qwen3.8-27b-fp8 ● Up`, the daily limit and look-back, and the privacy note. There is no Provider row, and Automatic's sentence names the System model. | ① ② |
| `runs-server.png` | The Wiki page's Runs band, after Review and Plan: the head `Runs · System model · qwen3.8-27b-fp8 ● Up` and one row a run — `Verification · Running · 1 of 3 calls ended · next call 2 ahead`, `Articles · Queued · 1 run ahead · waited …`, `Import · Done · 40 calls · 52,310 tokens · took 6m 2s`, `Maintenance · Failed · The System model refused the key (401) · 12 calls`. | ④ |
| `run-server.png` | A server run's page: `Running · 1 of 3 calls ended · next call 2 ahead`, when it started and the log's line under it (`3 calls · 1,204 tokens in, 296 out so far`), then the `Calls` section — `verify · 3f2a9c1e Done / waited 1s · ran 14s · 1,204 → 296 tokens`, a queued call with its place, and a failed call with its error in red. | ⑤ |

The fixture's times are the shot's (`2026-10-08T06:30:00Z`); the run page reads them against the clock when it
is drawn, so the waits in a shot taken later are longer than the fixture's own case — the words and the shape are
what the shot is for. The settings page shows the `up` state; `Unreachable`, `Key refused`, `Not configured` and
`wiki worker not running` are the same row in their tones, and the status line's reasons are the shared fixture's
cases (`WikiHealthTest`).
