# Session menu design v4 — English UI

[Design board](session-list-interaction-v4-en.png)

This revision corrects the UI language of v3. All interface labels, sample content and annotations in the board are English, matching Orbit. The action matrix and interaction rules from [v3](session-list-interaction-v3.md) still apply. Use the existing product terms Complete, Move to Open, Pin / Unpin, Share…, Move…, Delete and Delete Permanently…. The only row action is More actions (⋯). Completion shortcuts appear inside the menu.

Delete moves a session to Trash. The existing confirmation for deleting a publicly shared session stays in place. Permanent deletion always requires confirmation. Completed pin ordering and exact restoration of pre-deletion state remain separate product considerations, not changes in this implementation.

## Implementation

Implemented in the web Session list. Open and Completed expose five actions; Trash exposes two. Desktop rows reserve a fixed-width More actions button instead of overlaying the preview, and a small pin indicates pinned state. Narrow mouse/keyboard windows keep the menu; touch phones retain the existing swipe actions.

An open menu owns the Complete shortcut. Disabled or absent actions cannot fall through to the selected conversation. Arrow keys navigate within the menu, Escape closes it and restores trigger focus, and holding the completion shortcut cannot complete a second session through key repeat. Existing lifecycle, Share and Move request handlers are reused.

All action items use the same single-line height. Complete retains its keyboard shortcut; its running-state explanation and unavailable-state reason appear as a hover title instead of a second line. This supersedes the taller Complete item in the original design board. Browser measurements confirm 32px for all five actions, including disabled Complete and a narrow column; [updated screenshot](session-list-equal-height-en.png).

Validation: web production build and 93 focused tests passed (16 menu, 11 folder and 66 existing related regressions). Browser checks passed for light/dark mode, a 260px session column, an 800px mouse/keyboard window, a 390px touch viewport, menu arrow navigation and Escape focus restoration. Browser checks use fixture data without real account writes.

[Implemented UI screenshot](session-list-implemented-en.png)

Generated with the built-in image_gen tool. Original file preserved:
/root/.codex/generated_images/01a10261-5d51-7a21-b65d-af0ed2cc3d16/exec-81a6d3f0-6ae5-4912-b806-5f97cafc1baf.png

## Final prompt

```text
Use case: text-localization
Asset type: high-fidelity Orbit desktop Session menu design board.
Input image: existing v3 three-column design board is the edit target. The app is ENGLISH. Produce an entirely ENGLISH revision of this board, preserving the layout, whitespace, colors, visual hierarchy, row geometry, icon shapes, menu structure, sole ellipsis row button and menu-only Complete action. Absolutely no Chinese text anywhere in the output. This is a localization correction, not a redesign.
Replace exact texts:
Main title: "Session menus · Aligned with iOS"
Subtitle: "One entry point. Actions for each session state."
Keep column headings "01 Open", "02 Completed", "03 Trash".
Open example session title: "Upgrade from main branch"; green tag: "Deployment"; time: "Now"; preview "I’m using the upgrade skill…"; muted "+1" may be omitted if space is limited. Small pin status icon stays.
Open dropdown exactly FIVE actions:
"Complete" with RIGHT-ALIGNED "⌘D"; secondary line under Complete: "Ends the run and moves to Completed".
"Unpin"
divider
"Share…"
"Move…"
divider
"Delete" in red.
Completed example row title "Session list polish", purple tag "UI", preview "Updated the interaction details", time "12m", small pin status icon.
Completed dropdown FIVE actions:
"Move to Open" with curved undo arrow.
"Unpin" with pin-slash icon.
divider
"Share…"
"Move…"
divider
"Delete" in red.
Trash example row title "Review pending changes"; preview "Check and merge the latest changes"; time "28m".
Trash dropdown TWO actions:
"Move to Open" with curved undo arrow.
divider
"Delete Permanently…" in red.
Below Open menu exact English notes: "Swipe right: Complete · Pin / Unpin" and "Swipe left: Share · Move · Delete".
Below Completed menu: "Moving to Open does not start a run." and "Pin / Unpin stays available, as on iOS."
Below Trash menu: "Permanent deletion requires confirmation." and "No Pin, Share or Move actions in Trash."
Bottom three-part rules strip:
1 "Action groups" / "State & pinning → Share & move → Delete"
2 "Keyboard shortcut" / "Complete: ⌘D / Ctrl+D targets the menu’s session."
3 "Feedback" / "Complete and Delete offer Undo."
Use a two-line footer: "Delete moves a session to Trash. Permanent deletion cannot be undone." and "Design proposal · Menu shortcut targeting will be updated during implementation."
Ensure the longer English sentences wrap neatly within their panels without crowding. You may slightly enlarge the canvas and panels if needed for readable English, but preserve all three columns and balanced appearance. Restore icons must be curved undo arrows, distinct from Share's upward arrow from a box. Every row has only the ellipsis as its action control. NO standalone Complete button. Crisp professional UI, no oversized tooltip, no decoration, no watermark.
```
