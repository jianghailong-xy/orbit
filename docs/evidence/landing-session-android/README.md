# Landing session — Android evidence (NATIVE frames, light and dark)

What the Android client draws for the landing session page (task A-1), against the owner-approved
boards `docs/mocks/landing-session/v4/` (07 Android; the page's states are the same frames 05 draws
for iOS and web). The pictures here are the evidence: each one is written by the Robolectric test
`LandingSessionViewTest` / `LandingSessionViewDarkTest` under `@GraphicsMode(NATIVE)`, from the real
`MainActivity` over the controlled `ProjectShell` HTTP fixture, and committed beside the semantics
tree it was drawn from. A plain test run writes its frames to
`src/android/build/evidence/landing-session-android/{light,dark}/` and leaves these alone; they are
refreshed only by the opt-in run under Reproduce. A build directory is not durable; this is.

## How the frames are made

- The page is opened the way a reader opens it: an `orbit-session:<id>` link handed to the running
  `MainActivity` (`onNewIntent`), which routes by `GET /sessions/:id`'s `sessionKind == "LANDING"`
  to `LandingSessionPage` — never to the transcript reader.
- The fixture is `src/android/app/src/test/kotlin/io/orbitd/android/ProjectShellFixture.kt`: a
  landing session id, its landing view, `inFlightJobs` (with `landingSessionId`), the project's
  integration, coordinator and promotion reads, `tasks/t-landing`, the doors' answers and a log
  page. The timeline entries carry the sentences the server writes
  (`src/apiserver/src/projects/project-integration-event.ts`: `Task marked done · queued to land on
  …`, `Claimed by runner wikova · claim 1`, `Task acceptance started · claim 1 · wikova`,
  `Rebasing onto …`, `Taken over by a new process on runner wikova · claim 2`, `Merge check started ·
  claim 1 · wikova`, `Reported starting the push to …`), not the event kinds.
- Light is the default Robolectric qualifier; dark is `w412dp-h915dp-xhdpi-night`, which
  `isSystemInDarkTheme()` reads in `AccountAppearance`.
- The activity's window is drawn into a bitmap; a ⋮ menu is drawn in a window of its own, so the
  popup's root is drawn where DropdownMenu anchors it (its end under the ⋮) and kept as
  `*-popup.png` too. `*-semantics.txt` beside each frame is the tree both assertions and the
  picture were read from.

Reproduce (the same kit the task used; `JAVA_HOME` and `ANDROID_HOME` must point at Java 21 and
the Android SDK). `ORBIT_WRITE_EVIDENCE=1` writes the frames here; without it the same run writes
them to `src/android/build/evidence/landing-session-android/{light,dark}/`. Gradle does not track
environment variables as test inputs, so `--rerun` keeps an up-to-date test task from skipping the
run and writing nothing:

```
ORBIT_WRITE_EVIDENCE=1 bash src/android/gradlew -p src/android --no-daemon :app:testDebugUnitTest --rerun \
  --tests "io.orbitd.android.reader.LandingSessionViewTest" \
  --tests "io.orbitd.android.reader.LandingSessionViewDarkTest"
```

## Frames

Each file is in `light/` and `dark/`; the board column names the v4 frame it is checked against.

| Frame | What it draws | Board |
|---|---|---|
| `01-checking` | 任务段运行中：头（30 dp 圆、`Landing`、右边步骤时钟）、`checking · output 6s ago · claim 1 · round 1 of 3 · updated just now`、`Task acceptance 1m 50s of 60m` 预算条、`Output 6s ago · Updated just now`；时间线 `Generation 1` 的服务器句子与运行中检查的深色输出尾；只读页脚 `Decisions: the coordinator` | 05 a、05 h、07 11:05 |
| `02-timed-out-land-task` | 整张卡琥珀：三角、`Timed out`、`No report for 23m · limit 10m`、`Runner wikova took it at … · stopped at checking · claim 1 · round 1 of 3`、`Nothing was pushed — …`、实心 `Retry` + 浅红底红字无描边的 `Abandon`（A11-20 l，板 05 的 `cap4.red`）；时间线与段尾 `No report from wikova since …` | 05 i、07 14:58 |
| `03-timed-out-merge-to-main` | 合入作业超时：`Merge to main`、`Timed out`、`May have been pushed — it reported starting the push at …`、只有 `Abandon`、`No Retry: a confirmed merge ends by Abandon, …`；时间线 `Merge to main · 1` 与推送行；页脚 `Merging is decided on the merge card · Review card ›` | 05 f |
| `04-taken-over` | 接管之后：头 `claim 2`、`Taken over … · first started …`；时间线 `Claimed by runner wikova · claim 1` 与 `Taken over by a new process on runner wikova · claim 2` | 05 j |
| `05-settled` | 结案的一轮：绿圆里的 ✓、`Merged into main`、`8ed0ea7 · 2 tasks · automatically`、`Now on main · 2 tasks`、`✓ Passed on the combined tree · 17m 41s`、`Landed exactly the tested tree 5e5bfca · as a merge commit`、`This landing is complete — nothing to type here.` | 05 c |
| `06-merge-menu` | 已确认的合入轮（`Merge to main`、`claim 1 · round 1 of 3`），⋯ 菜单打开：`Open coordinator`、`Review card`、`Cancel merge`（后果 `Before the push only · stops at the runner's next report`）；没有 Open task / Open source session / Copy Link | 05 d、07 |
| `07-task-menu` | 任务段，⋯ 菜单打开：`Open task`、`Open source session`、`Open coordinator`、`Stop landing`（后果 `Before the push only · nothing pushed yet`）；没有 Copy Link、Rename、Share、Move、Tags、Trash | 07 11:05 |
| `08-merge-checking` | 合入轮检查中（无菜单）：`Merge check`、`2m 40s of 60m`、`usually ~18m`、`Output 6s ago · Updated just now`、`Merges on its own when it passes.`、页脚 `A clean pass merges on its own · Review card ›` | 05 a |
| `09-failed-check` | 检查没过（A11-20 b）：卡 `checks failed · exit 1 after 3m 52s`；时间线第三行 ✗ 与 `Log ›`，下面内联它最后 6 行非空输出，深色块（与运行中检查同一块） | 05 g |
| `10-log-open` | 同一行的 `Log ›` 展开：整页 log，字色是主题的 `onSurface`（深色主题下为浅色字），底为它的 4%；测试按像素核对字色随主题（`ink-landing:log-text.txt`） | 05 g |
| `11-offline-frozen` | 服务端读不到时再开这一页（A11-20 e）：卡用这一页上次读到的 `inFlightJobs` 条目画冻结头——`Landing`、时钟停在那次读取、`Update unavailable`、`Updated 0m ago`；没有门、没有 ⋯、没有时间线与页脚 | 05（iOS `offlineCard`） |

Two differences that are not the page's:

1. The project id in the title is the fixture's short id; a deployment's is base62, so
   `Merge project/<id> → main · #4` is one line on a device.
2. The frames are a 412 dp phone; the board's Android frame is the same shell at the same width, so
   the header, card and footer are directly comparable.

## Tests behind the frames

- `LandingSessionModelTest` — the landing view's decode (a server without the timeline, without
  `retryable`/`pushBoundaryPassed`, before the session row exists), the status card's five
  livenesses × three job kinds, the timeline's sections and a takeover's first start, the ⋮ menu's
  doors (Stop gone past the push boundary, no Stop on a merge round, Abandon + the server's Retry or
  Re-run the check once the lease expired, no Copy Link), J12's two push sentences, §2.7a's cadence
  and the stop once settled, and a failed read freezing the card with no door.
- `LandingSessionShellTest` — the production shell: a landing link renders the page and never the
  reader (no transcript, no composer, no session menu, no `sessions/:id/events`), a conversation
  still opens the reader, the pre-generated id draws before the row exists, every door sends the
  server's route (including the re-check's `{reason}` body), a refusal is said in the server's
  words, a settled landing stops polling, and a check's log expands.
- `LandingSessionViewTest` / `LandingSessionViewDarkTest` — the frames above, with the lines the
  semantics asserts and the ✓ on a settled success; frame 10 also reads the opened log's ink off its
  pixels (light strokes on the dark theme, dark on the light one).
- `LandingSessionCopyParityTest` — every word in `LandingSessionCopy` is the Swift page's (the six
  menu labels compared ignoring case: v4 07 draws Android's menu in sentence case, iOS in Title
  Case); the composed sentences are Swift's own interpolations.
