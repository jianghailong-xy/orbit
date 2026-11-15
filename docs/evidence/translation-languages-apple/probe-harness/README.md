# TEMPORARY evidence probe — never merged

Task 34xweTmJeaYjcJmKAkO4P (Translation languages, macOS/iOS). Copied from Translation X3's `.x3-probe`
(origin `probe/translation-x3`): the iPhone `CompactShell` with its Settings sheet and the Mac `MainView`, built from
the tree's own sources into throwaway apps, against `stub.py`. The stub's account writes Chinese (Simplified) and has
agents work in **Japanese** (`translationAgentLanguage: "ja"`), and it merges `PATCH /users/me/preferences` as the
server does, so a pick shows.

`LanguageShotTests` photographs Settings › Translation on both platforms (footer naming Japanese, Agents work in as a
picker over the whole shared list, picking Korean writes `translationAgentLanguage: "ko"` and the footer follows),
Your language over the same list, and the composer tag "Chinese → Japanese".
