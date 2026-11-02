# The probe that took the iPhone and Mac pictures: kept as a record

It ran ten times from the push-triggered branch `probe/recap-last-line`, deleted afterwards with its
`probe/recap-last-line-results` branch. On that branch these files sat under `.rcp-probe/`, and `client.probe.yml`
replaced `.github/workflows/client.yml`. Nothing here is built by this repository. These are the files of the last run;
earlier rounds differ as the table says. `base/RecapCardView.swift.txt` is main's view, copied over the tree for the
comparison in round 4. `scripts/mkprobe.sh` builds a probe commit in a temporary index, `scripts/watch_runs.py` waits on
the runs, and `scripts/sweep_gaps.py` reads the gaps below off the pictures.

| Round | Run | App code | What it asked | What it found |
|---|---|---|---|---|
| 1 | 41364214667 | 06d2f6dda | Gates, iPhone, Mac | Gates green. iPhone 5/5. Mac 0/2: the test looked for the card by label, and on the Mac a text's words are its value. |
| 2 | 41367561286 | 06d2f6dda | Same, Mac test fixed | Mac: the ⋯ is drawn under the pointer but is not in the accessibility tree. |
| 3 | 41370299305 | adb5a8343 | The ⋯ beside the paragraph in a ZStack instead of an overlay | Still not in the tree. The explanation behind that commit (a selectable text swallows what is laid over it) was wrong, and it was reverted. |
| 4 | 41373611869 | 853519e66 (= 06d2f6dda) | Mac only: main's view against the ⋯ under one test; a press where the ⋯ is drawn; a page of ten ways to stand the control | See below. |
| 5 | 41375284758 | 853519e66 | Mac only: the shipped overlay plus one of the real card's differences per row, then the real `RecapCardView` on the same page | Every row is in the tree under the pointer, the real card too. So the card is not the cause: the real console around it is. Which of its modifiers does it was not looked for. |
| 6 | 41376965583 | 36a7d24c4 | Gates, iPhone, Mac, with the hidden ⋯ at 0.001 opacity and the tree asserted | All green. The tree holds the ⋯ at rest and under the pointer in the real console. |
| 7 | 41379908794 | f1dd740c1 (a comment) | iPhone, Mac: recaps of eleven lengths across a line's end (`RcpSweep.swift`) | iPhone green. Mac: one red, the test's own: at the boundary (Latin row 4, `apple/mac-sweep-latin-row-4.png`) the last word and the ⋯ are drawn on line 3 while the tree reports the empty image on line 2. The picture is right; the assertion was dropped and the gaps are read off the pictures. |
| 8 | 41382643028 | f1dd740c1, and a tree without the label's negative padding | iPhone only: taps at measured distances from the ⋯'s middle | The ⋯ answered only within its 18 pt frame (9 pt below its middle: nothing). Without the negative padding: the 32 pt the label asks for. |
| 9 | 41384415837 | 9b281577b, the final code | Gates, iPhone, Mac, with the tap distances asserted | Gates green. Mac 5/5. iPhone 7/8: `test5` stopped on the probe's own note, which asked `isHittable` of a menu item while the menu still animated ("Activation point invalid"), before it pressed anything. The note now waits. |
| 10 | 41387638931 | 9b281577b | iPhone `test5`, three times | Two passes of the whole path: the ⋯ opens its menu, Hide recap takes the card away, and the stub records no write. One failure before the ⋯: the simulator was cold, the app took 77 s to launch, and the first query timed out ("Failed to get matching snapshots") at line 45, the wait for the card. The run reads red for that one iteration. |

## Round 4's two questions

Main's ↻ and × in the real console: absent from the tree at rest; under the pointer both there (`Button` "Refresh recap",
"Hide recap"). The ⋯ at opacity 0 in the same place: absent both ways, though drawn; pressed where it is drawn, its menu
opened and Hide recap worked. So the regression was real, and narrow: a person using a screen reader and a pointer at once.

The page of ten ways, each control named for its row, read at rest and under the pointer (its code was replaced by round
5's page, `mac/RcpVariants.swift`):

```
V1  main's two buttons in a row      at rest absent, under the pointer in the tree
V2  the Menu overlaid (what ships)   at rest absent, under the pointer in the tree
V3  the Menu in ZStacks              at rest absent, under the pointer in the tree
V4  V2, always shown                 at rest in the tree, under the pointer in the tree
V5  V3, always shown                 at rest in the tree, under the pointer in the tree
V6  the Menu in the old row          at rest absent, under the pointer in the tree
V7  V6, always shown                 at rest in the tree, under the pointer in the tree
V8  V2 with a Button for the Menu    at rest absent, under the pointer in the tree
V9  V2 at 0.001 opacity at rest      at rest in the tree, under the pointer in the tree
V10 V3 without children: .contain    at rest absent, under the pointer in the tree
```

V2 against V9 is what the fix came from.
