# Release process

Orbit is pre-1.0. A release is useful only when an operator can identify the exact source, understand upgrade
impact, and reproduce the checks that support the announcement.

## Version and channels

- Use one product version in the `vX.Y.Z` tag, package metadata, application metadata, artifact names, and
  release notes.
- `vX.Y.Z-beta.N` tags are prereleases for the beta update channel. A tag without a prerelease suffix is a
  stable release.
- Pin deployments to a tag. `main` is a development branch and older releases are not supported release
  lines.
- The [messaging brief](messaging-brief.md) owns the public positioning and the wording for known boundaries;
  this page owns the operational release checklist.

## Before tagging

1. Reconcile the version in the root package, runner, web/native metadata, and the intended tag.
2. Run the required checks for the candidate: JavaScript build/tests, PostgreSQL specs, Go runner tests, Swift
   core tests, container image build/boot, and the client workflow when native artifacts change.
3. Verify a clean-machine Compose install and record the OS, Docker/runtime versions, tag/SHA, and sanitized
   evidence. Review backups, migrations, security notes, and rollback impact.
4. Prepare human-readable notes with the problem solved, the three relevant launch scenarios, upgrade/migration
   impact, security fixes, known limitations, artifact links, and verification evidence.

## Publishing

Pushing a `v*` tag starts [.github/workflows/release.yml](../.github/workflows/release.yml), which builds the
signed/notarized macOS DMG, the iOS TestFlight artifact and the signed Android APK. The macOS job creates the
GitHub Release and Sparkle appcast for tag pushes; once it and the Android build have succeeded, the Android
publishing job attaches `orbit-android-<version>.apk`, its `.sha256` and `android-update.json` to that same
Release ([Android releases](../src/android/docs/release.md)). Maintainers must review the generated release
body before sharing it in Discussions or other channels, and must check that the release is marked prerelease
when the tag contains `-`.

Do not publish signing credentials, private logs, or a claim that a generated changelog is a substitute for
human upgrade notes. If a required gate is unavailable, say so in the release body and delay the release
unless the maintainer explicitly records the exception.

## After publishing

- Check that the release assets, checksums (when provided), appcast, TestFlight build, and Android
  `android-update.json` identify the same tag.
- Announce the release in [Discussions](https://github.com/jianghailong-xy/orbit/discussions) with upgrade notes,
  known limits, and a link to the exact release.
- Keep the previous supported release and rollback instructions discoverable.
- Update the relevant current guide when a command, configuration key, migration, or support boundary changes.

## Verify one release identity

The commands below require Git, GitHub CLI authenticated for repository reads, Node.js, curl, and Docker
Compose. Run deployment commands in the existing deployment checkout, with its protected `.env` and data
mounts. Replace the tag placeholders with actual published tags; do not use `main` as the release identity.

```bash
set -euo pipefail
ORBIT_RELEASE_TAG='<release-tag>'
ORBIT_PREVIOUS_TAG='<previous-release-tag>'
git fetch origin --tags
ORBIT_RELEASE_SHA="$(git rev-parse "$ORBIT_RELEASE_TAG^{commit}")"
ORBIT_PREVIOUS_SHA="$(git rev-parse "$ORBIT_PREVIOUS_TAG^{commit}")"
git show --no-patch --format=fuller "$ORBIT_RELEASE_SHA"
ORBIT_RELEASE_VERSION="${ORBIT_RELEASE_TAG#v}"
ORBIT_SOURCE_VERSION="$(git show "$ORBIT_RELEASE_TAG:package.json" | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
test "$ORBIT_SOURCE_VERSION" = "$ORBIT_RELEASE_VERSION"
git diff --stat "$ORBIT_PREVIOUS_SHA" "$ORBIT_RELEASE_SHA" -- src/apiserver/prisma/migrations
git diff "$ORBIT_PREVIOUS_SHA" "$ORBIT_RELEASE_SHA" -- src/apiserver/prisma/migrations
```

Expected: a single full source SHA, tag/package-version agreement, and a reviewed migration list. Older
Orbit tags may disagree with the root product version; a mismatch is a failed gate to resolve or explicitly
record, not permission to claim agreement. For annotated signed tags, `git verify-tag "$ORBIT_RELEASE_TAG"`
checks the signature when the signer's public key is available. A lightweight or unsigned tag has no signature
to verify; record that fact rather than claiming cryptographic verification.

```bash
gh release view "$ORBIT_RELEASE_TAG" --repo jianghailong-xy/orbit \
  --json tagName,isDraft,isPrerelease,url,assets,body
gh run list --repo jianghailong-xy/orbit --workflow release.yml --commit "$ORBIT_RELEASE_SHA" \
  --json databaseId,headSha,status,conclusion,url
ORBIT_RELEASE_RUN='<release-workflow-run-id>'
gh run view "$ORBIT_RELEASE_RUN" --repo jianghailong-xy/orbit --json headSha,conclusion,jobs,url
ORBIT_RELEASE_ASSETS="$(mktemp -d)"
gh release download "$ORBIT_RELEASE_TAG" --repo jianghailong-xy/orbit --dir "$ORBIT_RELEASE_ASSETS"
```

- [ ] Confirm the release is published, its prerelease flag matches the tag suffix, and both the DMG
  and TestFlight jobs succeeded on `ORBIT_RELEASE_SHA`. A successful macOS job alone does not prove iOS upload.
- [ ] Confirm the expected `Orbit-v<version>-arm64.dmg` and `.zip` assets are present and nonempty.
  The ZIP is the Sparkle payload, not a server image. Record asset names, sizes, URLs, and workflow run URL.
- [ ] Confirm `orbit-android-<version>.apk`, its `.sha256` and `android-update.json` are present and that
  `(cd "$ORBIT_RELEASE_ASSETS" && sha256sum -c orbit-android-*.apk.sha256)` passes; the manifest's `tag`,
  `versionName` and `sourceSha` must be this tag, its version and `ORBIT_RELEASE_SHA`. A second tag on an
  already released commit carries no Android files (its Android jobs skip); record which release has them.
- [ ] If the publisher supplies `SHA256SUMS`, verify it from the asset directory using
  `(cd "$ORBIT_RELEASE_ASSETS" && sha256sum -c SHA256SUMS)` on Linux, or
  `(cd "$ORBIT_RELEASE_ASSETS" && shasum -a 256 -c SHA256SUMS)` on macOS. For another checksum filename,
  use that file instead. If no checksums were published, record “not provided” and compute local audit hashes
  with `shasum -a 256 "$ORBIT_RELEASE_ASSETS"/*`; local hashes alone do not authenticate the publisher.

### Deployed version agreement

```bash
docker compose images
docker compose exec -T apiserver node -p 'require("/app/package.json").version'
ORBIT_VERIFY_ORIGIN='https://orbit.example.com'
curl -fsS "$ORBIT_VERIFY_ORIGIN/healthz"
curl -fsS "$ORBIT_VERIFY_ORIGIN/api/auth/setup-status"
curl -fsS "$ORBIT_VERIFY_ORIGIN/dl/version.json"
```

| Component | Check | Expected |
| --- | --- | --- |
| Server/API | Root package version inside the running image; recorded build source SHA and image ID | `ORBIT_RELEASE_VERSION`, built from `ORBIT_RELEASE_SHA`; healthy API/database |
| Web | Reload the browser and inspect a web API request's `X-Orbit-Client` header in developer tools | `web/<ORBIT_RELEASE_VERSION>`; built from the same checkout |
| Downloadable runner | `/dl/version.json`, then `orbit status` and `orbit capabilities --json` on a registered runner | Manifest/`cliVersion` match the product version; `sourceSha` matches `ORBIT_RELEASE_SHA` |
| macOS | App bundle's `CFBundleShortVersionString`, bundle build number, and release workflow SHA | Full version including any prerelease suffix; build number is the source commit count |
| iOS | App Store Connect/TestFlight version, build number, and release workflow SHA | Numeric version `${ORBIT_RELEASE_VERSION%%-*}`; build number is the source commit count |
| Android | `android-update.json` on the release; Settings → About on an installed phone | `versionName` is `ORBIT_RELEASE_VERSION` (prerelease suffix included); `versionCode` is the source commit count; `sourceSha` is `ORBIT_RELEASE_SHA` |

Server/web do not expose a runtime source-SHA endpoint; retain the build checkout SHA, build log, and image
IDs as source evidence. Do not infer their source from a matching version string alone. The macOS-bundled
runner currently stamps its version but not `sourceSha`; record the workflow SHA for it and do not call
`dev-local` a verified source stamp. A runner allowed to self-update may already be newer: pin the test to the
candidate deployment and record any deliberate version difference as an exception.

### Runner manifest and asset digests

`scripts/build-binaries.sh` writes `/dl/version.json` beside the binaries (`src/runner-go/cmd/release-manifest`).
Besides the version and the runner-write contract, it carries one entry per platform under `assets`:

```json
{
  "version": "0.1.214",
  "assets": {
    "darwin-arm64": { "file": "orbit-darwin-arm64.gz", "sha256": "<64 lowercase hex digits>" },
    "darwin-x64": { "file": "orbit-darwin-x64.gz", "sha256": "…" },
    "linux-arm64": { "file": "orbit-linux-arm64.gz", "sha256": "…" },
    "linux-x64": { "file": "orbit-linux-x64.gz", "sha256": "…" }
  }
}
```

- The key is the platform, `<darwin|linux>-<x64|arm64>`, as the runner's `platformKey` names it.
- `file` is the asset's name under `<origin>/dl/`. `sha256` is the lowercase hex SHA-256 of that file's bytes
  exactly as served: the `.gz` itself, not the binary inside it. Check the download before decompressing it.
- Anything that installs a runner from `/dl` checks the digest, and on a mismatch installs nothing and keeps the
  current binary. The runner's self-update and `orbit upgrade` do this. A manifest without `assets` comes from a
  control plane older than the field: the runner then installs as before, unverified, and logs a warning.
- The macOS app bundles no runner. Enrolling a Mac downloads `orbit-darwin-<arm64|x64>.gz` from the signed-in
  server's `/dl` and installs it to `~/.orbit/bin/orbit` only if it matches its digest. A manifest without one
  installs nothing there, since an enrollment has no current binary to fall back on: update the server first.
- The digest ties a download to the manifest that announces it. It is not a signature: whoever can rewrite
  `version.json` can rewrite the digests too.

Check a build against its manifest with
`(cd dist-bin && jq -r '.assets[] | "\(.sha256)  \(.file)"' version.json | sha256sum -c)`
(`shasum -a 256 -c` on macOS).

### macOS runner signature

The Go linker signs a darwin binary ad hoc, with the identifier `a.out`. macOS records a person's privacy
(TCC) answers for such a binary against its code hash, which every release changes, so after each runner
update a Mac asked again about Documents, Desktop and every other protected place an agent's work had
reached. A deployment with an Apple Developer ID signs the two darwin binaries instead.
`scripts/build-binaries.sh` signs them with [rcodesign](https://github.com/indygreg/apple-platform-rs) on
Linux before compressing them, so `version.json` carries the digests of the signed files and the update
check passes as before. Each binary is signed:

- as `com.orbit.runner`, by the team's Developer ID. Its designated requirement is then that identifier
  and that team, the same for every release, so an answer given to one release holds for the next.
- with the hardened runtime, and the entitlements that let macOS still ask on the runner's behalf for the
  camera, microphone, location, contacts, calendars, photos and Apple Events. A hardened process without
  them is refused those outright. Files and folders need no entitlement.
- with a secure timestamp from Apple, so the signature outlives the certificate.

The binaries are not notarized. A runner, `install.sh` and the macOS app download them without a
quarantine attribute, so Gatekeeper does not assess them.

To turn signing on, once, on the deploy host:

1. Export the Developer ID Application certificate and its private key from Keychain Access as a `.p12`
   with a password. A team can hold more than one Developer ID Application certificate, and the
   designated requirement names the team rather than the certificate, so a certificate of the runner's
   own keeps the macOS app's signing key off the deploy host and can be revoked alone. Keychain Access
   protects a `.p12` with SHA-1 and 3DES or RC2, the only kind rcodesign 0.29 reads. A `.p12` written by
   OpenSSL 3 uses AES by default, and rcodesign reports it as a wrong password. Rewrite such a file
   first:

   ```bash
   (umask 077; pem="$(mktemp)"; openssl pkcs12 -in in.p12 -nodes -out "$pem" &&
     openssl pkcs12 -export -legacy -in "$pem" -out developer-id.p12; rm -f "$pem")
   ```

2. Copy the `.p12` to the deploy host outside the checkout, and put its password on the first line of a
   second file. Make both readable only by the account that deploys (`chmod 600`).
3. Add three lines to the checkout's `.env`:

   ```bash
   COMPOSE_FILE=docker-compose.yml:deploy/macos-runner-signing.yml
   ORBIT_MACOS_SIGNING_P12=/root/orbit-signing/developer-id.p12
   ORBIT_MACOS_SIGNING_PASSWORD_FILE=/root/orbit-signing/developer-id.password
   ```

   Every Compose command in the checkout, the upgrade skill's included, then also reads
   [deploy/macos-runner-signing.yml](../deploy/macos-runner-signing.yml). It hands the two files to the
   web build as BuildKit secrets, which reach only the step that signs: not an image layer, a build
   argument or the build log. A build that is told to sign and cannot (a missing file, a wrong password,
   Apple's timestamp server out of reach) fails instead of publishing unsigned binaries.
4. Deploy with the upgrade skill. The build log names what it signed:
   `signed as com.orbit.runner, team <team ID>`.

Without these lines nothing changes: the darwin binaries keep the linker's signature and the build fetches
nothing. A build that leaves them out, such as one from another checkout, publishes ad-hoc binaries again,
and every Mac that updates to them asks once more.

On a Mac whose runner has updated to a signed release, `codesign -dv ~/.orbit/bin/orbit` shows
`Identifier=com.orbit.runner`, the team's `TeamIdentifier` and `flags=0x10000(runtime)`, and
`codesign -d -r- ~/.orbit/bin/orbit` shows a designated requirement naming both. The first signed
release asks once more about what the ad-hoc one was allowed, since the stored answer names the ad-hoc
hash, and access granted by hand in System Settings, such as Full Disk Access, has to be granted again
once for the same reason. From then on the answers survive updates. After the next update,
`log show --last 1h --info --debug --predicate 'subsystem == "com.apple.TCC"'` shows `AUTHREQ_RESULT` with
`authValue=2` for the runner and no `AUTHREQ_PROMPTING` naming it.

### Runner rollout and rollback

`/dl` publishes two runner releases, each with its own `version.json` and asset digests:

- `/dl/version.json` and `/dl/orbit-<platform>.gz`: the latest release, built from the deployed source.
- `/dl/previous/version.json` and `/dl/previous/orbit-<platform>.gz`: the release before it. The web image
  build carries it over from the image it replaces (`scripts/retain-runner-release.sh`). The upgrade skill
  passes the running `orbit-web` image as `PREVIOUS_RELEASE_IMAGE`. A build without it, such as a plain
  `docker compose build`, keeps no previous release. Until the next deploy, runners then can be neither held
  at one nor rolled back to one.

A registered runner asks `GET /api/runner/release` with its runner token at startup and at every update check
(every 10 minutes), naming both versions. The apiserver answers with the release that runner is to run,
following the release pointer, `runner-release.json` at the repository root:

```json
{ "rolloutPercent": 100, "rollback": null }
```

- `rolloutPercent` (0–100): the share of runners the latest release goes to. A runner's place is fixed by its
  id: the first four bytes of the SHA-256 of the runner id, mod 100. A runner whose place is below the
  percentage gets the latest release. Every other runner is assigned the previous release and reports
  `heldByRollout` as its reason for not updating. Raising the percentage only adds runners.
- `rollback`: `null`, or a release version. Naming the latest release points the release pointer back at the
  previous one: every runner is assigned the previous release, marked as a rollback. Naming the previous
  release withdraws it: every runner gets the latest, and none is held on the withdrawn one. Any other
  version is ignored.

A runner installs a newer assigned release as it always did. It installs an older one only when the answer is
marked as a rollback, and only if that release's `version.json` carries `runsAssignedRelease`. A release
without it would read `/dl/version.json` at its next check and reinstall the release it was rolled back from.
Without a rollback mark it never downgrades. The apiserver image ships the pointer, so every change to it is
a commit and a deploy: `git log -p runner-release.json` is the record of who moved it, when and why. The
apiserver logs what the pointer does whenever that changes, for example
`runner release 0.1.216 to 10% of runners; the rest are held at 0.1.215`.

- **Staged rollout:** set `rolloutPercent` (for example `10`) in the same change as the version bump, deploy, and
  raise it in later commits. Bumping again while the percentage is below 100 makes the canary the previous
  release, so the runners outside the rollout move up to it.
- **Rollback:** set `"rollback": "<the latest version>"`, commit, and deploy with the upgrade skill. Each runner
  installs the previous release at its next update check, after its turns in flight end. A rollback with no
  previous release published moves no runner at all.
- **Fix forward:** ship the fix as a new version and leave `rollback` naming the withdrawn release. While that
  release is the previous one, no runner is held on it. Reset `rollback` to `null` once a later release has
  replaced it at `/dl/previous`.

Check what is published with `curl -fsS "$ORBIT_VERIFY_ORIGIN/dl/version.json"` and
`curl -fsS "$ORBIT_VERIFY_ORIGIN/dl/previous/version.json"`. `install.sh`, the macOS app's first download,
`sudo orbit upgrade` from an account that is not the runner's, and runners released before assignment
existed all read `/dl/version.json` directly, so they always get the latest release.

Each runner reports where its updates stand on every heartbeat, and `GET /api/runners` and
`GET /api/runners/:id` return it as `selfUpdate`. Its `state` is `enabled`, `disabledByEnv` (`reason` says
which: `ORBIT_NO_SELFUPDATE`, a development build, or a platform with no published build), `dirNotWritable`
(`installDir` is not writable by the runner's account; `sudo orbit upgrade` there moves the install),
`waitingForIdle` (a release waits for the turns in flight), `failed` (`reason` is the runner's own words) or
`heldByRollout`. `lastUpdatedAt`, `lastUpdatedFrom` and `lastUpdatedTo` describe the last update the runner
installed into itself. A runner too old to report any of this has `selfUpdate: null`. The owner's Update Runner
Now, `POST /api/runners/:id/self-update`, has the runner run its update check at once rather than at the next
10-minute one, by the same rules: the release assigned to it, and never during a turn in flight.

### Native hand-off (platform-specific)

```bash
curl -fsSL https://jianghailong-xy.github.io/orbit/appcast.xml -o "$ORBIT_RELEASE_ASSETS/appcast.xml"
grep -E 'sparkle:(version|shortVersionString|channel)|releases/download/' "$ORBIT_RELEASE_ASSETS/appcast.xml"
git rev-list --count "$ORBIT_RELEASE_SHA"
```

- [ ] Check the appcast entry's version/build, download URL/tag, EdDSA signature, and channel: prerelease
  tags use the beta channel. Retained entries for previous releases are expected.
- [ ] On a **macOS** tester, mount the DMG, locate `Orbit.app`, and run:

  ```bash
  ORBIT_VERIFY_APP='/Volumes/<mounted-volume>/Orbit.app'
  codesign --verify --deep --strict "$ORBIT_VERIFY_APP"
  spctl --assess --type execute --verbose "$ORBIT_VERIFY_APP"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ORBIT_VERIFY_APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ORBIT_VERIFY_APP/Contents/Info.plist"
  ```

  Expected: signature/Gatekeeper checks succeed and metadata matches the table. Test launch and the intended
  Sparkle channel. These commands require macOS and cannot be validated on a Linux server.
- [ ] In **App Store Connect**, wait for the uploaded iOS build to finish processing, confirm version/build,
  compliance status and tester availability, then test sign-in and one small task on an iOS device.
  Workflow upload success does not mean Apple has completed processing or approved external testing.

## Rollback decision and procedure

Before upgrading, record the previous tag/SHA and image IDs, keep the previous native assets/TestFlight build,
and verify an off-host database backup plus a restore drill using the
[backup runbook](postgres-backup-restore.md). Back up the encryption/signing secrets privately. Review the
migration diff above for destructive changes, data transformations, and the schema floor each version needs.

**Application-only rollback is safe only when the previous API supports the database schema and data now
present.** Prisma's startup migration command does not undo applied migrations. An additive migration may
be compatible, but verify its specific release notes; a removed column or transformed data may require
database recovery. The [PostgreSQL conflict runbook](postgres-conflict-runbook.md#rolling-the-application-back)
is an example of a documented compatibility decision, not a blanket rule for later migrations.

For a confirmed compatible rollback, stop new work, let active tasks settle or interrupt them deliberately,
retain sanitized failure logs, and run from the same deployment directory:

```bash
docker compose stop gateway web apiserver
git checkout --detach "$ORBIT_PREVIOUS_TAG"
ORBIT_SOURCE_SHA="$ORBIT_PREVIOUS_SHA" docker compose up -d --build --no-deps --wait apiserver web gateway
docker compose ps
curl -fsS http://localhost:2086/healthz
curl -fsS http://localhost:2086/api/auth/setup-status
docker compose logs --since=10m --tail=100 apiserver
```

Keep PostgreSQL and its archive running on this path. Repeat version/runner/first-task verification before
resuming normal work. Reinstall the previous macOS artifact or select a still-available previous TestFlight
build only when its server compatibility is confirmed; an expired TestFlight build cannot be recovered by
changing the server tag.

For an incompatible schema or damaged data, stop the entire stack and preserve the failed directory first:

```bash
docker compose stop gateway web apiserver pgbackup postgres
ORBIT_FAILED_DATA="data/postgres.failed-$(date -u +%Y%m%dT%H%M%SZ)"
mv data/postgres "$ORBIT_FAILED_DATA"
```

Follow [point-in-time recovery](postgres-backup-restore.md#restore-to-a-point-in-time-bad-write-wrong-migration)
to a pre-upgrade time with a sufficiently old base backup and all required WAL. Keep `ORBIT_FAILED_DATA`, the
archive, and the matching protected secrets until the incident is resolved. Before starting the API, select
the previous tag and verify that the restored schema matches it. Recovery may lose writes after the chosen
time; get the operator's decision and record that impact in the incident/release exception.

## Release evidence and exceptions

The release body should retain the tag/full source SHA, previous rollback tag/SHA, migration and compatibility
notes, workflow run URLs, asset names/checksum status, image identities, native processing/test results, and a
sanitized [first-run evidence table](first-run.md#evidence-to-retain). Name every skipped/blocked gate and its
reason, approving maintainer, impact, follow-up issue, and next verification step. Record rollback failures
or a schema-compatibility exception there too; do not silently mark a failed check as passed.

Announce known limitations in a linked [Discussion](https://github.com/jianghailong-xy/orbit/discussions): name
the affected version/platform, observed limitation, workaround if tested, and follow-up issue. Link to the
exact release and evidence. Do not publish signing credentials, authentication tokens, private logs, or a
claim of a hosted service or SLA.
