# Release notes

Each release has one file here, `release-notes/<version>.md`, written before the tag is cut. It becomes
the GitHub Release body and the notes `android-update.json` carries to installed Android apps.

- Required sections and what belongs in each: [Release notes template](../docs/release-notes-template.md).
- Why, and the rest of the release rules: [Release process](../docs/release-process.md).
- `release.sh bump <version>` opens the file for the next release; it is filled in and committed as part
  of the release commit, before `release.sh <version>` creates the tag.

Naming is the version of record with no `v`: `release-notes/0.1.257-beta.1.md` belongs to tag
`v0.1.257-beta.1`. A tag without its file (or with a section still holding only a TODO) is refused by
`release.yml` before anything is built.
