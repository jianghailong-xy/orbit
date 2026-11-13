# Verifiable release supply chain

Every `v*` tag publishes more than installers: it publishes the evidence that ties the installers to the
commit they were built from, the workflow that built them, and the bytes a downloader actually receives.
This page says what is published, who signs it, how to check it, and how to roll back when a check fails.
The operational rules for cutting a release stay in [Release process](release-process.md).

## What every tag publishes

The `supply-chain` job in [.github/workflows/release.yml](../.github/workflows/release.yml) collects every
build, builds the runner binaries from the tag, and writes one bundle. `publish` creates the GitHub Release
from that bundle only after the gate passed; an artifact that disagrees with its version, checksum, SBOM or
provenance stops the release there, and nothing becomes public.

| Release asset | What it is |
| --- | --- |
| `Orbit-v<version>-arm64.dmg` | Signed, notarized, stapled macOS installer built on the macOS runner |
| `Orbit-v<version>-arm64.zip` | The Sparkle update payload (`Orbit.app`), the same version and build number |
| `orbit-<platform>.gz`, `version.json` | Reference runner build from the tag for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`; `version.json` names each file's SHA-256 |
| `android-update.json`, `orbit-android-<version>.apk`, `…apk.sha256` | Attached by the Android publishing job after the Release exists; the manifest is what installed Android apps read |
| `android-identity.json` | The Android build's identity: application id, versionName/versionCode, APK SHA-256, signing certificate SHA-256, source commit |
| `appcast.xml` | The Sparkle feed published to GitHub Pages; its entry names the same version, build and tag |
| `SHA256SUMS` | GNU `sha256sum` format over the DMG, Sparkle payload, runner assets, APK, Android identity, appcast, `release-manifest.json`, the SBOM and the provenance. The APK's own `.sha256` and `android-update.json` are attached later and check themselves |
| `orbit-v<version>-sbom.cdx.json` | CycloneDX 1.6 software bill of materials for the release |
| `orbit-v<version>-provenance.intoto.jsonl` | in-toto statement with a SLSA v1 provenance predicate |
| `release-manifest.json` | The bundle's index: version, tag, source commit, build identity, every artifact's name/size/SHA-256/surface, image identities, and the digests of the SBOM and the provenance |

The runner assets are a reference build. A deployment builds its own runner binaries while building its web
image and serves them at `<origin>/dl/`; that deployment's `/dl/version.json` carries the SHA-256 of the
exact bytes it serves, and the binary carries the source commit it was built from. Install runners from your
deployment's `/dl`, not from the release, when you want the deployment's build.

## Signing identities and the project

The release carries four independent signatures plus GitHub's attestation. They answer different questions,
and none of them replaces the source mapping in `release-manifest.json`.

### Apple: macOS and iOS

The macOS DMG is signed with the Developer ID Application certificate of the Apple Developer team
**Wikova HQ**, imported into a throwaway keychain from the `DEVID_CERT_P12_BASE64` secret, then notarized
and stapled by Apple. The iOS build uses an Apple Distribution certificate and an App Store provisioning
profile of the same team, and uploads to TestFlight under that team's App Store Connect account. The team's
identifier is not printed in this repository; read it from a downloaded app:

```bash
codesign -dv --verbose=4 "/Volumes/Orbit/Orbit.app" 2>&1 | grep -E 'Authority|TeamIdentifier'
codesign --verify --deep --strict "/Volumes/Orbit/Orbit.app"
spctl --assess --type execute --verbose "/Volumes/Orbit/Orbit.app"
xcrun stapler validate "/Volumes/Orbit/Orbit.app"
```

Sparkle updates are signed with an EdDSA key. The public key is embedded in the app's `Info.plist` as
`SUPublicEDKey` (`8huUODCPnWSupH+g30/RWaCGOCeRzRY/oAlShNuIzm4=` for the current app); the private key is the
`SPARKLE_ED_PRIVATE_KEY` repository secret, held by the maintainer. Sparkle verifies every update against
that key before installing it.

**How this relates to the open-source project.** Orbit is published from the GitHub account
`jianghailong-xy`; the repository, the Apple team, the Android signing key and the Sparkle key are held by
the same maintainer. The Apple certificate therefore says "this release was built and published by the
maintainer's Apple Developer team", not "this release came from an Orbit foundation, company or project-owned
organisation". The certificate is not evidence about the source: that link comes from this repository's
public workflow, the source commit the manifest names, and the provenance below. If the project later moves
to an organisation or transfers a signing key, this section and the release notes must name the new subject
before the first release under it.

### Android

The APK is signed by the release keystore in the protected `android-internal` environment (secrets
`ANDROID_KEYSTORE_BASE64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`). The
certificate's SHA-256 is recorded twice — as the `ANDROID_CERT_SHA256` environment variable and as
`certSha256` in `android-update.json` and `android-identity.json`. Check it yourself:

```bash
apksigner verify --print-certs orbit-android-<version>.apk
```

The printed certificate SHA-256 digest must equal `certSha256` in `android-update.json`. Installed apps
also compare it before applying an update. See [Android releases](../src/android/docs/release.md).

### Runner binaries

A deployment that configures `ORBIT_MACOS_SIGNING_P12` signs its darwin runner binaries with that
Developer ID certificate, as `com.orbit.runner` (the project's own deployments use the maintainer's team);
unconfigured deployments keep the Go linker's ad-hoc signature.
Independently of signing, every runner binary has `main.sourceSHA` stamped at build time, so
`orbit version --json` names the commit it was built from. The release's runner assets are the reference
build described above, not a deployment's `/dl` release.

### GitHub's attestation

`actions/attest-build-provenance` signs a Sigstore attestation for every file in the verified bundle, bound
to this repository's workflow identity and the run that produced it. It is a second, independently hosted
record next to `orbit-v<version>-provenance.intoto.jsonl`; `gh attestation verify` checks it.

## Verify checksums

Download the release assets into one directory, then check the list with the platform's own tool:

```bash
tag=v0.1.257-beta.1
mkdir -p release
gh release download "$tag" --repo jianghailong-xy/orbit --dir release
(cd release && sha256sum -c SHA256SUMS)          # Linux
(cd release && shasum -a 256 -c SHA256SUMS)     # macOS
```

`SHA256SUMS` covers the manifest, the SBOM and the provenance too, so a single check catches a swapped bundle. The APK's
own `orbit-android-<version>.apk.sha256` and `android-update.json` are added by the Android publishing job;
check the APK against its own file with `(cd release && sha256sum -c orbit-android-*.apk.sha256)`.

## Verify the release bundle

The same script that generated the bundle re-reads it. Run it from a checkout at the tag so the version of
record and its release notes are the tree being claimed:

```bash
tag=v0.1.257-beta.1
git clone https://github.com/jianghailong-xy/orbit
cd orbit
git checkout "$tag"
node scripts/supply-chain.mjs verify --dir ../release --tag "$tag" \
  --source-sha "$(git rev-parse "$tag^{commit}")" --repository jianghailong-xy/orbit --require-ci --tree .
```

It refuses the release when:

- the manifest's tag is not `v` + its version, its source is not a full commit SHA, or the tag points at a
  different commit than the manifest names;
- any artifact's bytes or size disagree with the manifest, `SHA256SUMS`, the SBOM component, or a provenance
  subject, or a file in the directory is claimed by none of them;
- the Sparkle zip's `CFBundleShortVersionString`/`CFBundleVersion`, the Android identity's
  versionName/versionCode/APK digest, or the runner `version.json`'s version and asset digests disagree;
- the SBOM is not CycloneDX 1.6, its component version/tag/source differ, or an image identity is missing;
- the provenance is not in-toto v1 + SLSA v1, its builder is not this repository's Actions run, or its
  resolved source commit is not the release commit;
- `--tree .` finds a different `package.json` version or missing/invalid release notes.

`node scripts/release-identity.mjs check-tag "$tag"` separately checks the tag, package version, notes and
annotated-tag rules the release workflow enforces before it builds anything.

## Verify the SBOM

The SBOM is CycloneDX 1.6. Every artifact is a `file` component with its SHA-256; each service image is a
`container` component carrying the config digest, layer digests and base images; the runner's Go modules and
the service images' production npm packages are `library` components with purls (`pkg:golang/…`,
`pkg:npm/…`). Read and check it with `jq`, or any CycloneDX validator:

```bash
sbom="release/orbit-v<version>-sbom.cdx.json"
jq -r '.metadata.component.version, (.components | length)' "$sbom"
# Rebuild a checksum list from the SBOM and check the downloaded bytes against it.
(cd release && jq -r '.components[] | select(.type == "file") |
  "\(.hashes[0].content)  \(.name)"' "orbit-v<version>-sbom.cdx.json" | sha256sum -c -)
```

The native client bundles are represented at artifact level: their Swift and Kotlin dependency graphs are
built by Xcode/Gradle in the signed builds and are not enumerated as package components here. The runner's
Go modules and the service images' production npm packages are enumerated because the build has those
manifests at hand.

## Verify the provenance

For a published tag the provenance statement names the public workflow, the tag, the source commit and the
Actions run:

```bash
jq -r '.subject[] | "\(.digest.sha256)  \(.name)"' release/orbit-v<version>-provenance.intoto.jsonl
jq -r '.predicate.buildDefinition.externalParameters.workflow | .repository, .path, .ref' \
  release/orbit-v<version>-provenance.intoto.jsonl
jq -r '.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit' \
  release/orbit-v<version>-provenance.intoto.jsonl
jq -r '.predicate.runDetails.builder.id' release/orbit-v<version>-provenance.intoto.jsonl
```

Expected: the repository and `.github/workflows/release.yml`, `refs/tags/<tag>`, the tag's full commit, and
`https://github.com/jianghailong-xy/orbit/actions/runs/<run id>`. The JSON file is the readable statement the
verifier checks; it is not itself signed. The signature is GitHub's attestation:

```bash
gh attestation verify release/SHA256SUMS --repo jianghailong-xy/orbit
gh attestation verify release/Orbit-v<version>-arm64.dmg --repo jianghailong-xy/orbit
```

## Re-verify from a public workflow

Actions → **Verify a release's supply chain** → *Run workflow* with the tag. The workflow is
[.github/workflows/verify-release.yml](../.github/workflows/verify-release.yml): it downloads the release,
requires the manifest's source commit to be the commit the tag points at, runs the same verifier, and checks
GitHub's attestation. It needs no repository secret and no write permission. Anyone with write access to
the repository can dispatch it; anyone else can run the same two commands locally against the downloaded
assets.

## Service images

The supply-chain job builds `src/apiserver/Dockerfile` and `src/web/Dockerfile` from the tag, records each
image's config digest, layer digests and base images in `release-manifest.json` and as a `container`
component, and lists the production npm packages from `package-lock.json`. A deployment rebuilds those
images from the same source, but Docker builds are not bit-reproducible: the deployment's image ID will
differ from the recorded reference build. Compare what you can compare — the image's version
(`node -p 'require("/app/package.json").version'` in the apiserver container), the package inventory in the
release SBOM, and the source commit the deployment was built from — and record the deployment's own image
ID as its identity. [Release process](release-process.md#deployed-version-agreement) lists the deployed-version
checks.

## Rollback

A failed verification happens **before** publication: `publish` needs `supply-chain`, so a mismatch means no
GitHub Release, no appcast update and no Android assets for that run. Fix the build or the mismatch and run
the workflow again; do not publish around the gate.

If a bad release is already public, treat its assets as suspect and roll back on the normal paths:

1. Stop announcing it. Edit the GitHub Release body to say it is withdrawn and why, keep the assets (their
   digests are what people can check), and link the release that replaces it.
2. Verify the previous release bundle the same way and confirm it is the one you want users on.
3. Roll the deployment back with [Release process → Rollback decision and procedure](release-process.md#rollback-decision-and-procedure);
   retain the database backup and migration review that page requires.
4. Move the runner release pointer back with `runner-release.json` (`rollback` names the withdrawn version;
   see [Release process → Runner rollout and rollback](release-process.md#runner-rollout-and-rollback)), or
   ship the fix as a new version and leave the pointer naming the withdrawn release until a later release
   replaces it at `/dl/previous`.
5. The Sparkle appcast retains the previous versions; users who have not updated stay on the previous one.
   Android `versionCode` is the commit count and only increases, so publish a fix forward rather than trying
   to downgrade the APK.

## What this does and does not prove

It proves that the bytes on the release are the bytes the described workflow produced from the named commit,
that the version and build metadata agree across the DMG/Sparkle payload, Android APK identity, runner build,
SBOM and provenance, and that the tag's commit is the source the release claims. It does not prove that the
maintainer's account or signing keys were uncompromised: GitHub Actions, the repository secrets and the
Apple/Android signing keys are the trust root. It does not make the DMG or the service images reproducible
bit for bit. Apple's notarization is Apple's assessment, not a code review. And the native clients' SBOMs are
artifact-level rather than full Swift/Kotlin dependency graphs.
