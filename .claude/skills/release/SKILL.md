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
3. **Publish the Orbit Cloud runner image** on orbit-ws04, in the background, once the tag is pushed, then pull it
   onto the k3s node through orbit-ws03 (see [Orbit Cloud runner image](#orbit-cloud-runner-image)).
4. **Report** the tag, the run's link, each job's outcome, the TestFlight and Android state, the Orbit Cloud runner
   image, and any job that failed with its log lines. A failed job is reported, not retried: re-running or deleting a tag is the
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

## Orbit Cloud runner image

The tag also publishes the Orbit Cloud (managed) runners' image, `10.66.0.1:5000/orbit-cloud-runner:<version>`, whose
runner reports the release version (docs/release-process.md, "Orbit Cloud runner image comes from the release tag").
It is built and pushed on the build host, workspace **orbit-ws04** (wikova): the registry is reached only over
WireGuard, so `release.yml` cannot. Once the tag is on `origin`, start it beside the tag brief, in the background:

`delegate({ description: "Publish Orbit Cloud runner <version>", size: "S", workspace: "orbit-ws04", background: true,
prompt: <the publish brief> })`

It is idempotent: a tag whose image is in the registry already is skipped, so a failed or repeated run is simply run
again. A two-stage deploy of the tag's commit, or of a later one, uses this image and builds none; until it is
published, a deploy stops before changing anything and names the command. Report its result with the release's.

The publish brief: fill in `<version>`.

```text
Publish the Orbit Cloud runner image of release tag v<version> on this host. Answer in English. Stop and report at
the first step that fails; do not improvise around a guard. Never push to git, never tag, never deploy.

1. The tag is on origin: `git -C /root/orbit fetch --quiet origin "refs/tags/v<version>:refs/tags/v<version>"`.
2. W=/dev/shm/wkdir-publish-cloud-runner-<version>; `git -C /root/orbit worktree add --detach "$W" "v<version>"`.
   Do not check out or change anything in /root/orbit itself.
3. `cd "$W" && ORBIT_REGISTRY=10.66.0.1:5000 deploy/two-stage/publish-managed-runner.sh v<version>`. It builds from
   the tag's commit (several minutes, about 4.4 GiB) and pushes, or says the image is in the registry already. It
   must end with a line starting `✓ 10.66.0.1:5000/orbit-cloud-runner:<version> is in 10.66.0.1:5000`.
4. `git -C /root/orbit worktree remove --force "$W"`.
5. Hand back: whether it was built or already there, the digest it printed, and on failure the last 40 lines.
```

**Then pull it onto the node.** Once the publish brief hands back its `✓` line, take the reference by digest from it
(`10.66.0.1:5000/orbit-cloud-runner@sha256:<64 hex>`, the one a deploy writes into the profile) and pull it onto
production's k3s node, workspace **orbit-ws03** (`workstation`), in the background:
`delegate({ description: "Pull Orbit Cloud runner <version> onto the node", size: "S", workspace: "orbit-ws03",
background: true, prompt: <the pre-pull brief> })`. A runner's Pod pulls its image only as it starts, so without this
the first runner to start after the deploy waits for the 1.5 GB pull first: 116 s on 2026-11-25, against about 9 s for
the ones after it. It is idempotent, and a failed pull costs nothing but that wait: report it with the release's
result, and do not hold the release for it.

The pre-pull brief: fill in `<version>` and `<ref>`.

```text
Pull the Orbit Cloud runner image of release v<version> onto this k3s node, so that the first runner to start on it
does not wait for the pull. Answer in English. Run as root. Change nothing else on the node: no Pod, no other image,
no k3s setting. Stop and report at the first step that fails.

1. `git -C /root/orbit fetch --quiet origin "refs/tags/v<version>:refs/tags/v<version>"`.
2. `git -C /root/orbit show "v<version>:deploy/managed-runner/prepull-runner-image.sh" | bash -s -- <ref>`. It takes a
   minute or two. It must end with a line starting `✓ <ref> is on this node`.
3. Hand back its last lines.
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

4. **Publish the Orbit Cloud runner image** on the build host (orbit-ws04), from the tag just pushed; from another
   workspace through the SubAgent in [Orbit Cloud runner image](#orbit-cloud-runner-image):

   ```bash
   ORBIT_REGISTRY=10.66.0.1:5000 deploy/two-stage/publish-managed-runner.sh v0.2.0-beta.3
   ```

5. **Watch the build and report the result.** All five jobs run in the one `release.yml` run:

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
