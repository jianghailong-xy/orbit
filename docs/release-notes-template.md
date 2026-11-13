# Release notes template

A release's GitHub Release body and its `android-update.json` notes are the file
`release-notes/<version>.md` at the tag. `release.yml` refuses to build or publish a tag without one
([Release process](release-process.md#release-notes)). The notes are written for the operator deciding
whether to upgrade — not a copy of the commit log. Keep every heading (`scripts/release-identity.mjs check-notes` requires each one);
`## Security fixes` and `## Known limitations` say "None" rather than being deleted when there is nothing to
say.

Copy this file to `release-notes/<version>.md`, or let `release.sh bump <version>` open it. Everything in
angle brackets is a placeholder; `scripts/release-identity.mjs check-notes` refuses a section that still
holds only a TODO/TBD line.

```markdown
# Orbit <version>

## Summary

<One paragraph: what this release is for, and the one or two changes an operator will notice.>

## Upgrade impact

<What must happen before or during the upgrade: database migrations and whether they are additive or
destructive; configuration or environment changes; the minimum runner and native client versions; any
one-time step a runner, Mac, iPhone or Android device needs. If nothing is required, say so explicitly.>

## Security fixes

<Every fixed security issue, with its impact in a sentence: what an attacker could do, what the fix
changed, and whether users on an older release are exposed. Name an advisory or CVE when one exists. If
the release carries none, write "None in this release.">

## Known limitations

<Limits a user can hit in this release, each with a workaround if one is tested. "None known." when there
are none that are not already documented in SUPPORT.md.>

## Artifacts and verification

<The tag, the full source SHA, the DMG/TestFlight/APK/runner assets this release publishes, their
checksums, and the checks that ran (workflow run URL, clean-install result). Link evidence instead of
claiming a check that did not run.>

## Rollback

<The previous tag and source SHA, whether the schema change makes an application-only rollback safe, and
the backup/restore step for an incompatible one. See the release process's rollback section.>
```

## What the pipeline does with these notes

- The GitHub Release body is this file (`gh release create --notes-file`); a generated changelog is not
  substituted for it.
- `android-update.json`'s `notes` field is this file, trimmed to the 4000 characters installed Android
  apps read.
- The file is part of the release commit, so the notes the tag names are in the tag's tree.
- Tags before this rule have generated changelogs and tag-message notes only; they are historical and are
  not backfilled.
