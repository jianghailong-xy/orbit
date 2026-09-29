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
