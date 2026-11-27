---
name: release
description: Cut an Orbit client release by creating and pushing one vX.Y.Z git tag, triggering the signed/notarized macOS DMG release, the iOS TestFlight build and the signed Android APK on the same GitHub Release. Use when asked to cut or ship a release, tag a version, publish a beta, TestFlight or Android build, or start the client release workflow. Do not use for ordinary deployments of the Docker Compose stack; use the upgrade skill instead.
---

# Cut an Orbit client release

Use one `vX.Y.Z` tag to ship all three clients through `.github/workflows/release.yml`:

| Job | Output |
| --- | --- |
| `identity` | Refuses the tag unless it is `v` + the root `package.json` version and carries a filled-in `release-notes/<version>.md`; every build job waits for it |
| `dmg` | Signed and notarized macOS DMG, GitHub Release, and Sparkle appcast |
| `testflight` | Signed iOS `.ipa` uploaded to TestFlight |
| `android-build` | Signed Android release APK, from the `android-internal` environment |
| `android-publish` | The APK, its `.sha256` and `android-update.json` attached to the same GitHub Release, after `dmg` and `android-build` succeed |

**The root `package.json` version is the version of record**, and the tag is that version with `v`. The GitHub Release, the DMG/`.zip` names, the TestFlight marketing version, the Android `versionName`, the runner binaries and `/dl/version.json`, the Sparkle appcast and `android-update.json` all derive from it, and `release.yml` refuses a tag that disagrees with the package.

Interpret tags as follows:

- `vX.Y.Z`: macOS stable channel, an iOS TestFlight build and an Android release.
- `vX.Y.Z-beta.N`: macOS beta channel, an iOS TestFlight build and an Android release. iOS uses numeric marketing version `X.Y.Z`; the commit-count build number distinguishes iterations.
- Android uses the tag without `v` as `versionName` and the same commit count as `versionCode`; installed Android apps update to any higher `versionCode`.

## Who runs it

A release is mostly reading commits for its notes and then waiting 30 to 60 minutes on `release.yml`, which needs
no expensive model. On one, such as an Opus, Fable or GPT-6.x Sol model, the session keeps only the decisions and
hands the work to DeepSeek V4.1 Flash with Orbit's `delegate` (`model: "deepseek-flash"`, Orbit's id for it). If `delegate` refuses the
model (`SUBAGENT_TARGET_CANNOT_RUN`), take another flash or mini model from the list the refusal prints. On an
inexpensive model, follow [Workflow](#workflow) yourself.

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
3. **Publish the Orbit Cloud runner image** on orbit-ws04, in the background, once the tag is pushed (see
   [Orbit Cloud runner image](#orbit-cloud-runner-image)).
4. **Report** the tag, the run's link, each job's outcome, the TestFlight and Android state, the Orbit Cloud runner
   image, and any job that failed with its log lines. A failed job is reported, not retried: re-running or deleting a tag is the
   session's decision (see Notes).

The prepare brief: fill in `<version>` and `<previous tag>` (the newest `v*` tag, `git describe --tags --abbrev=0
--match 'v*' origin/main`).

```text
Prepare Orbit client release <version> in the current working directory, a git branch based on origin/main. Read
.agents/skills/release/SKILL.md first. Answer in English. Stop and report at the first step that fails; do not
improvise around a guard. Never push, never tag, never touch main.

1. `git fetch origin` and `git status --porcelain` must print nothing. `git merge-base --is-ancestor origin/main HEAD`
   must succeed and `git rev-list --count origin/main..HEAD` must print 0; otherwise stop.
2. `.agents/skills/release/scripts/release.sh bump <version>`. It commits package.json, the lockfile and
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
Tag and watch Orbit client release <version>. Read .agents/skills/release/SKILL.md first. Answer in English. Stop
and report at the first step that fails; do not retry, re-run, delete a tag or push anything but this tag.

1. W=/tmp/orbit-release-<version>. `git fetch origin --tags` and `git worktree add --detach "$W" origin/main`.
   `node -p "require('$W/package.json').version"` must print <version>, and `$W/release-notes/<version>.md` must
   exist; otherwise stop.
2. `cd "$W" && .agents/skills/release/scripts/release.sh <version>`. It must end having pushed tag v<version>.
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

## Workflow

1. Resolve the version. `release.sh next` prints the one tag to cut next, resolved from the package version alone; old tags are never read as a sequence:

   ```bash
   .agents/skills/release/scripts/release.sh next
   ```

   While the package version has no tag yet (locally or on `origin`), it is the candidate. Once it is tagged, `next` is the next beta in its series, or `X.Y.(Z+1)-beta.1` after a stable `X.Y.Z`: a beta belongs to the version it precedes. `next` only prints. Pass an explicit version for anything else.

2. If the package version is not the version to release, bump it. This is the release commit: `package.json`, the lockfile and `release-notes/<version>.md` all name the same version.

   ```bash
   .agents/skills/release/scripts/release.sh bump next          # or: bump 0.2.0-beta.3
   ```

   Fill in every section of the notes (`docs/release-notes-template.md`) and commit them. `bump next` while the package version is still untagged and its notes exist changes nothing.

3. Verify the release commit is the committed and pushed `main` tip:

   ```bash
   git rev-parse --abbrev-ref HEAD
   git fetch origin
   git rev-list --count HEAD..origin/main
   ```

   Require `main` and a result of `0`. If a fix exists only on another branch, merge it into `main`; never tag the feature branch.

4. State the exact resolved tag and get explicit user confirmation before tagging. Creating and pushing the tag is an external, release-triggering action.

5. Tag it with the version `package.json` already carries:

   ```bash
   .agents/skills/release/scripts/release.sh 0.2.0-beta.3
   ```

   The helper runs the same identity gate as CI (`node scripts/release-identity.mjs check-tag vX.Y.Z`): it refuses a tag that disagrees with `package.json`, missing or placeholder notes, tracked uncommitted changes and an already-used tag (local or remote), then creates an annotated tag and pushes it to `origin`.

6. Publish the Orbit Cloud runner image on the build host (orbit-ws04), from the tag just pushed; from another workspace through the SubAgent in [Orbit Cloud runner image](#orbit-cloud-runner-image):

   ```bash
   ORBIT_REGISTRY=10.66.0.1:5000 deploy/two-stage/publish-managed-runner.sh v0.2.0-beta.3
   ```

7. Watch the shared workflow and report every job result:

   ```bash
   gh run watch "$(gh run list --workflow release.yml -L 1 --json databaseId -q '.[0].databaseId')"
   ```

   A green `testflight` job means upload completed; App Store Connect may still need processing time and an export-compliance answer. A green `android-publish` job means the Android files are on the release (`gh release view vX.Y.Z --json assets -q '.assets[].name'`); its step summary lists their SHA-256. When `android-build` reports that the commit was already published for Android under another tag, both Android jobs end without publishing, which is expected.

## Constraints

- Accept only `X.Y.Z` or `X.Y.Z-beta.N` versions, and only the one `package.json` carries.
- `scripts/release.sh` is `.claude/skills/release/release.sh`, byte for byte, and this skill follows the same rules (`npm run test:release-identity` checks it). Change both together.
- Every pushed `v*` tag starts all the platform jobs. To build one Apple platform only, dispatch `release.yml` on `main` with `platform=macos` or `platform=ios` instead of creating a tag. Android never runs from a dispatch, and `android-v*` tags start nothing.
- If `dmg` fails, Android is not attached. After the cause is fixed, re-run the failed jobs of that run (`gh run rerun <run-id> --failed`); it rebuilds the DMG and then attaches the Android build already made. Ask before re-running, as it publishes.
- Required signing and publishing secrets are documented in `.github/workflows/release.yml`; Android signing lives only in the `android-internal` environment.
- If a tag was pushed incorrectly, ask for confirmation before deleting the remote/local tag or cancelling its workflow; those are destructive external actions.
