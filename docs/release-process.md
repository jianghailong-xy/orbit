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
signed/notarized macOS DMG and the iOS TestFlight artifact. The macOS job creates the GitHub Release and
Sparkle appcast for tag pushes. Maintainers must review the generated release body before sharing it in
Discussions or other channels, and must check that the release is marked prerelease when the tag contains `-`.

Do not publish signing credentials, private logs, or a claim that a generated changelog is a substitute for
human upgrade notes. If a required gate is unavailable, say so in the release body and delay the release
unless the maintainer explicitly records the exception.

## After publishing

- Check that the release assets, checksums (when provided), appcast, and TestFlight build identify the same tag.
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
- The digest ties a download to the manifest that announces it. It is not a signature: whoever can rewrite
  `version.json` can rewrite the digests too.

Check a build against its manifest with
`(cd dist-bin && jq -r '.assets[] | "\(.sha256)  \(.file)"' version.json | sha256sum -c)`
(`shasum -a 256 -c` on macOS).

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
