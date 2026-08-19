# Orbit brand assets

This directory contains the project's visual identity. Use the approved files below for public project and
product surfaces; the remaining files are design explorations and review artifacts.

## Approved assets

| Asset | Use |
| --- | --- |
| [`orbit-mark.svg`](orbit-mark.svg) | Primary standalone mark for repository, navigation, and small UI placements |
| [`orbit-lockup.svg`](orbit-lockup.svg) | Mark plus wordmark on light backgrounds |
| [`app-icon.svg`](app-icon.svg) | Desktop and web app-icon source |
| [`app-icon-ios.svg`](app-icon-ios.svg) | iOS app-icon source |
| [`final-preview.png`](final-preview.png) | Reference sheet showing the approved direction in product contexts |

`orbit-lockup.svg` contains a dark wordmark and is intended for light surfaces. On a dark surface, use the
standalone mark beside live text in the surface's normal foreground color until an approved reversed lockup is
added.

Files named `mark-a-*`, `mark-b-*`, `mark-c-*`, `showcase*`, `legibility*`, and `final-preview.html` document
the exploration and review process. They are not production marks.

## Core palette

| Token | Value | Role |
| --- | --- | --- |
| Orbit Blue | `#3370FF` | Primary actions, the low end of the mark gradient, links, and focus |
| Signal Blue | `#5B8BFF` | Highlight and the high end of the mark gradient |
| Ink | `#1F2329` | Light-surface wordmark and primary text |
| White | `#FFFFFF` | Mark detail and dark-surface foreground |

Product UI may use additional semantic colors for success, warning, error, and neutral states. Those colors
must not replace Orbit Blue as the main brand signal.

## Name and descriptor

- Write the product name as **Orbit**, not `ORBIT`, except where an all-caps environment requires it.
- Use **Agent Mission Control** as the short descriptor.
- On a first mention where the category is not obvious, use **Orbit — self-hosted mission control for coding
  agents**.
- Use `orbit` for the CLI executable and code identifiers.
- Claude Code, Codex, Kimi, OpenCode, Apple, and other third-party names remain the property of their owners.
  Do not imply endorsement or ownership.

The word “Orbit” is widely used in software. The project must complete naming and trademark clearance before
v1.0; see the [project maturity roadmap](../docs/project-maturity.md#the-name-is-the-largest-brand-risk).

## Voice

Orbit should sound calm, precise, and operational:

- Lead with the user's outcome, then explain the mechanism.
- Prefer concrete nouns and verbs: runner, session, task, approve, resume, restore.
- Make trust boundaries and incomplete features explicit.
- Avoid claims such as “secure,” “autonomous,” “enterprise-ready,” or “production-ready” without specific
  evidence and stated limits.
- Describe supported agent runtimes consistently and in the same order: Claude Code, Codex, Kimi, OpenCode.

The product story has three recurring proof points:

1. **The work survives the session.** Tasks and dependencies preserve a project beyond one context window.
2. **Agents run where the context lives.** Runners use the repositories, tools, credentials, and networks on
   the user's own machines.
3. **Humans keep control.** Approvals, permissions, isolated worktrees, and visible history make parallel work
   supervisable.

## Usage

- Preserve the asset's aspect ratio and internal spacing.
- Do not recolor, rotate, outline, add effects, or separate pieces of the mark.
- Keep surrounding space of at least one quarter of the mark's width when practical.
- Prefer the SVG sources for web and print. Derive raster sizes from the SVG rather than scaling an existing
  small PNG upward.
- Keep the icon, wordmark, product UI, website, release artwork, and social preview on the same approved mark.

No separate trademark usage policy has been adopted yet. External uses that could imply endorsement should be
discussed with the maintainers before publication.
