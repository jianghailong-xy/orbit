#!/usr/bin/env bash
# Print the brief for the Mac mini SubAgent (iOS half of compare-android-ios). The Mac runs on its own repo HEAD and does
# not have this checkout's skills, so section B of client-screenshots is pasted in verbatim, never summarised.
#
#   ios-brief.sh PAGE_FLAG UNTIL_TEXT BRANCH
#     PAGE_FLAG   the probe landing arguments, one string: "-probe.draft", "-probe.session S2", "-probe.list"
#                 (section B2 says how to add a landing for another page)
#     UNTIL_TEXT  words that are on the page once it has drawn, e.g. "Send a task to get started."
#     BRANCH      throwaway branch for the hand-back, e.g. probe/compare-new-session
set -euo pipefail
flag="${1:?page flag}"; until="${2:?until text}"; branch="${3:?branch}"
# "-probe.session S2" → "-probe.session", "S2": the Swift launch-argument list the tests pass.
args="$(printf '%s\n' $flag | sed 's/.*/"&"/' | paste -sd, - | sed 's/,/, /g')"
skill="$(dirname "$0")/../client-screenshots/SKILL.md"
section="$(awk '/^## B\. iOS Simulator/,/^## C\. Compare/' "$skill" | sed '$d' | sed '/^---$/d')"
cat <<EOF
Take iOS Simulator screenshots of one Orbit iPhone page, light and dark, on an iPhone 17 Pro on this Mac, for comparison with Android.

Work in this machine's Orbit repo checkout and stay on whatever HEAD is checked out; note \`git rev-parse HEAD\`. You may create
files only under \`.shot-probe/\` at the repo root. Never commit to or push the checked-out branch, and never change \`src/\`.

The page: launch arguments \`[$args]\`; it has drawn once "$until" is on screen. In B2 step 3 the two tests open
\`[$args]\` and \`[$args, "-dark"]\` until "$until", and shoot "ios-shot" and "ios-shot-dark" (in place of the
section's draft tests). \`-probe.session <id>\`, \`-probe.list\` and \`-probe.machine\` already land in the harness; add a
landing branch in B2 step 1 only for \`-probe.draft\` (as shown) or for a page that has none.

Follow these steps exactly (section B of the project's client-screenshots skill, verbatim):

----- BEGIN SECTION B -----
$section
----- END SECTION B -----

For this run:
- Hand-back branch: \`$branch\`, files at \`ios-shots/ios-shot.png\`, \`ios-shots/ios-shot-dark.png\`, \`ios-shots/tree.txt\`
  (the light run's accessibility tree). Push with \`--force\`. Try file_upload first only if you like; the branch is what the caller reads.
- Long commands: bg_run (kind job, wakeOnExit true) if your Bash can't wait 20 minutes; if bg_run is unavailable, run in the
  foreground in two steps (build-for-testing, then the tests).
- A build break: fix only probe files under \`.shot-probe/\` (the known ones are listed in B2). After three failed tries stop and
  report the exact \`error:\` lines.
- Open each PNG with the Read tool before handing back: it must show the page asked for, not a sheet, a list or sign-in.

Hand back:
- the HEAD sha;
- the simulator line (name, UDID, iOS version);
- both PNGs' sizes from \`sips\`;
- run.sh's exit code;
- the branch and its commit;
- one sentence per shot describing it top to bottom.
EOF
