---
name: release
description: Cut a release of the Orbit clients by creating and pushing one vX.Y.Z git tag, which triggers the macOS release (signed + notarized DMG), the iOS release (TestFlight build) and the Android release (signed APK on the same GitHub Release) from the same tag. Use whenever someone wants to cut/ship a release, tag a version, push a TestFlight, beta or Android build, or kick off a release build.
---

# Cut a release (macOS + iOS + Android from one tag)

A release is a single git tag — `vX.Y.Z`. Pushing it runs every job of `.github/workflows/release.yml`
from that same tag, so one command ships all three clients together:

| Job (in `release.yml`) | Output |
|------------------------|--------|
| `identity` | Refuses the tag unless it is `v` + the root `package.json` version and carries a filled-in `release-notes/<version>.md`; every build job waits for it |
| `dmg` | macOS: signed + notarized DMG, a GitHub Release whose body is those release notes, and the Sparkle auto-update appcast |
| `testflight` | iOS: signed `.ipa` archived and uploaded to TestFlight |
| `android-build` | Android: signed release APK (signing key from the `android-internal` environment) |
| `android-publish` | Android: attaches `orbit-android-<version>.apk`, its `.sha256` and `android-update.json` to the **same GitHub Release** `dmg` created; installed Android apps update themselves from it |

**The root `package.json` version is the version of record**, and the tag is that version with `v`. Every
surface derives from it: the GitHub Release, the DMG/`.zip` names and `CFBundleShortVersionString`, the
TestFlight marketing version (numeric, suffix stripped), the Android `versionName`, the runner binaries and
`/dl/version.json`, the Sparkle appcast and `android-update.json`. `release.yml` refuses a tag that disagrees
with the package, so the two cannot drift.

- `vX.Y.Z` → macOS **stable** channel (reaches everyone) **+** an iOS TestFlight build.
- `vX.Y.Z-beta.N` → macOS **beta** channel (only users who enabled "Receive beta updates") **+** an
  iOS TestFlight build. The `-beta.N` suffix is a macOS/Sparkle concept; iOS strips it to a numeric
  marketing version (`v0.2.0-beta.3` → TestFlight `0.2.0`), and the build number (commit count)
  carries the beta iteration on TestFlight.
- Android, either way: `versionName` is the tag without `v` (`0.2.0-beta.3`, suffix kept) and
  `versionCode` is the same commit count as the iOS build number. Every Android phone on an older
  version is offered the new one, beta or stable.

## Who runs it

A release is mostly reading commits for its notes and then waiting 30 to 60 minutes on `release.yml`, which needs
no expensive model. On one, such as an Opus, Fable or GPT-6.x Sol model, the session keeps only the decisions and
hands the work to DeepSeek V4.1 Flash with Orbit's `delegate` (`model: "deepseek-flash"`, Orbit's id for it). If `delegate` refuses the
model (`SUBAGENT_TARGET_CANNOT_RUN`), take another flash or mini model from the list the refusal prints. On an
inexpensive model, follow [How to use](#how-to-use) yourself.

The session decides, and no SubAgent does:

- **The version.** `release.sh next` prints it; confirm it with the owner unless they named one.
- **What reaches `main`.** A SubAgent never pushes to `main` and never tags anything but `origin/main`'s tip. The
  session lands the release commit on `main` itself (its usual merge, such as Orbit's `session_merge`).
- **The notes.** They become the GitHub Release body. Read the file before the release commit is merged, and fix
  anything the SubAgent claimed without evidence (tests it did not see run, a server version it did not check).

Then:

1. **Prepare**, in the foreground (a few minutes): `delegate({ description: "Prepare release <version>", size: "S",
   prompt: <the prepare brief> })`. It runs in this session's working directory, which must be a branch based on
   `origin/main` with nothing uncommitted. Read the notes, then merge the release commit into `main`.
2. **Tag and watch**, in the background: `delegate({ description: "Tag and watch release <version>", size: "S",
   background: true, prompt: <the tag brief> })`. End the turn: Orbit wakes this session with the result.
3. **Report** the tag, the run's link, each job's outcome, the TestFlight and Android state, and any job that
   failed with its log lines. A failed job is reported, not retried: re-running or deleting a tag is the
   session's decision (see Notes).

The prepare brief: fill in `<version>` and `<previous tag>` (the newest `v*` tag, `git describe --tags --abbrev=0
--match 'v*' origin/main`).

```text
Prepare Orbit client release <version> in the current working directory, a git branch based on origin/main. Read
.claude/skills/release/SKILL.md first. Answer in English. Stop and report at the first step that fails; do not
improvise around a guard. Never push, never tag, never touch main.

1. `git fetch origin` and `git status --porcelain` must print nothing. `git merge-base --is-ancestor origin/main HEAD`
   must succeed and `git rev-list --count origin/main..HEAD` must print 0; otherwise stop.
2. `.claude/skills/release/release.sh bump <version>`. It commits package.json, the lockfile and
   release-notes/<version>.md.
3. Fill in every section of release-notes/<version>.md, following docs/release-notes-template.md and the previous
   release's notes (release-notes/ of <previous tag>) for tone and length. Base it on
   `git log --no-merges --format='%h %s%n%b' <previous tag>..origin/main` and
   `git diff --stat <previous tag> origin/main -- src/apiserver/prisma/migrations/`: group what users see per client,
   name each migration and whether it is additive, and say the runner served at /dl is built from this tag. State
   only what the commits say; for "Artifacts and verification" name only checks a commit message records, and say
   plainly where it records none. No TODO may remain.
4. `git add release-notes/<version>.md && git commit --amend --no-edit`, so the release is one commit.
5. Hand back: the commit hash, `git show --stat HEAD`, and the notes file in full.
```

The tag brief: fill in `<version>`.

```text
Tag and watch Orbit client release <version>. Read .claude/skills/release/SKILL.md first. Answer in English. Stop
and report at the first step that fails; do not retry, re-run, delete a tag or push anything but this tag.

1. W=/tmp/orbit-release-<version>. `git fetch origin --tags` and `git worktree add --detach "$W" origin/main`.
   `node -p "require('$W/package.json').version"` must print <version>, and `$W/release-notes/<version>.md` must
   exist; otherwise stop.
2. `cd "$W" && .claude/skills/release/release.sh <version>`. It must end having pushed tag v<version>.
3. Find the run: `gh run list --workflow release.yml -L 5 --json databaseId,headBranch,event,url` and take the one
   whose headBranch is v<version>. Wait for it with `gh run watch <id> --exit-status` in steps of under 10 minutes
   (`timeout 540 gh run watch <id>`; repeat while `gh run view <id> --json status -q .status` is not completed).
4. `gh run view <id> --json jobs -q '.jobs[] | "\(.name) \(.conclusion)"'`, and
   `gh release view v<version> --json assets -q '.assets[].name'`. For each failed job, its last 40 log lines
   (`gh run view <id> --log-failed`).
5. `git worktree remove --force "$W"`.
6. Hand back: the tag and its commit, the run URL, each job's conclusion, the release's assets, and the failed jobs'
   lines.
```

## How to use

1. **Pick the version.** `release.sh next` prints the one tag to cut next, resolved from the **package
   version** alone (old tags are never read as a sequence): the package version itself while it has no
   tag yet (the release commit is prepared and waiting), otherwise the next beta in the current series,
   or `X.Y.(Z+1)-beta.1` once a stable version is the package version. It only prints. Confirm it before
   bumping; pass an explicit version for anything else (a stable release, or opening a new minor).

   **A beta belongs to the version it precedes, not the one already out.** `0.1.1-beta.2` sorts
   *below* `0.1.1`, so once `X.Y.Z` ships stable, its betas are spent — the next beta must open on
   `X.Y.(Z+1)`. `next` handles the bump.

2. **Bump the package and open the notes.** This is the release commit: `package.json`, the lockfile and
   `release-notes/<version>.md` all name the same version.

   ```bash
   .claude/skills/release/release.sh bump next          # or: bump 0.2.0-beta.3
   ```

   `bump next` while the package version is still untagged and its notes exist changes nothing.

   Fill in every section of the notes file (`docs/release-notes-template.md`), commit it, and make sure
   the branch is `main` synced with `origin/main` before tagging. Tagging a feature/session branch — or
   a `main` that's behind `origin/main` — ships a tree that's missing whatever landed on `main` in
   parallel, so the release silently **drops those features and can revert already-merged fixes**.

   ```bash
   git rev-parse --abbrev-ref HEAD                     # → main
   git fetch origin && git rev-list --count HEAD..origin/main   # → 0 (nothing on origin/main you're missing)
   ```

3. **Tag it** (resolves the repo root itself). It runs the same identity gate as CI, refuses a dirty
   tree, a tag that disagrees with `package.json`, missing or placeholder notes, and an already-used tag
   (local or remote), then creates an annotated tag and pushes it:

   ```bash
   .claude/skills/release/release.sh 0.2.0-beta.3    # the version package.json already carries
   ```

4. **Watch the build and report the result.** All five jobs run in the one `release.yml` run:

   ```bash
   gh run watch "$(gh run list --workflow release.yml -L 1 --json databaseId -q '.[0].databaseId')"
   ```

   - **`dmg` (macOS):** when green, the signed + notarized DMG is in the run's Artifacts and a GitHub Release.
   - **`testflight` (iOS):** when green, the build is uploaded, then needs a few minutes of App Store
     Connect processing (and a one-time export-compliance answer) before it shows up in TestFlight.
   - **`android-build` / `android-publish` (Android):** `android-publish` waits for `dmg` and
     `android-build`; when green, the release lists `orbit-android-<version>.apk`, its `.sha256` and
     `android-update.json` (`gh release view vX.Y.Z --json assets -q '.assets[].name'`), and the job's
     summary shows their SHA-256. If the commit already went out for Android under another tag,
     `android-build` says so and both Android jobs end without publishing; that is not a failure.
   - **Re-publishing Android:** if `dmg` failed, Android is not attached. Fix the cause, then use
     **Re-run failed jobs** on that run (`gh run rerun <run-id> --failed`): the DMG is built again and
     the APK `android-build` already made is attached after it. An `android-build` that refused the
     version (the commit count must grow) needs a new commit and a new tag.

## Notes

- `.agents/skills/release/` carries the same rules for other engines; its `scripts/release.sh` is this
  `release.sh`, byte for byte (`npm run test:release-identity` checks it). Change both together.
- Accepted: `X.Y.Z` (stable) or `X.Y.Z-beta.N` (macOS beta channel). iOS always ships the numeric
  `X.Y.Z` to TestFlight regardless of suffix.
- **One tag fires all three** — every `v*` tag also uploads an iOS TestFlight build (two `macos-15`
  runner jobs) and publishes Android (two `ubuntu-24.04` jobs). To build only one Apple platform, skip
  the tag and dispatch with the `platform` input: `gh workflow run release.yml --ref main -f platform=macos`
  (or `-f platform=ios`). A dispatch with no tag builds each client's default version. Android has no
  dispatch: it builds and publishes on `v*` tag pushes only. `android-v*` tags are retired and start nothing.
- Required secrets are in the `release.yml` header:
  - macOS `dmg`: `DEVID_CERT_P12_BASE64`, `DEVID_CERT_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`,
    `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`, `SPARKLE_ED_PRIVATE_KEY`.
  - iOS `testflight`: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`, `APPLE_TEAM_ID`.
  - Android `android-build`: the `android-internal` environment (v* tags only) — secrets
    `ANDROID_KEYSTORE_BASE64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`,
    variables `ANDROID_APPLICATION_ID`, `ANDROID_CERT_SHA256` (see `src/android/docs/release.md`).
- To undo a tag pushed by mistake (one run holds all the jobs):

  ```bash
  git push origin :refs/tags/vX.Y.Z   # delete remote tag
  git tag -d vX.Y.Z                   # delete local tag
  gh run cancel <run-id>              # stop the release.yml run if it already started
  ```

  Once `android-publish` has attached `android-update.json`, installed Android apps may already be
  offered that version: say so when reporting the mistake rather than quietly deleting the release.
